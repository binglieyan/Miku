/**
 * @file particles.js — WebGPU 粒子系统（主线程）
 *
 * 所有 WebGPU 物理计算（compute shader）和渲染（instanced billboard quads）
 * 在主线程中完成。
 *
 * 背景图片由 CSS #background 层常驻显示（index.html），
 * canvas 为透明覆盖层，浏览器合成器做图层叠加。
 *
 * 缓冲区策略：buf0 / buf1 按 MAX_COUNT 一次性分配（ping-pong），
 * 活跃粒子数由 uniform count 控制。setCount 仅更新该 uniform 与
 * workgroup 数，不重建缓冲区——调整粒子数量时已有粒子保留当前动画状态，
 * 无重置闪烁，且无 GPU 缓冲区抖动。
 *
 * 错误处理：设备丢失、uncapturederror（GPU 校验错误不抛 JS 异常，只走
 * 该事件）、帧内同步异常，统一经 _shutdown() 置空 _device/_queue 并
 * 真正终止 rAF 循环（frameLoop 仅在 _rafId 非空时才请求下一帧），
 * 之后 CSS 背景层仍持续可见。
 *
 * @module particles
 */

/* ————————————————————————————————————————————
 *  DOM 引用
 * ———————————————————————————————————————————— */

/** @type {?HTMLCanvasElement} */
const canvas = document.getElementById('canvas');

// 缺少 canvas 时没有可渲染的目标，但模块必须能**成功求值**：粒子模块抛异常会
// 连带打死入口 settings.js，属性桥（含背景显示模式）会一起失效。这里只报错，
// 各使用点再各自早退——属性桥因此照常工作，只是没有雪花。
if (!canvas) {
  console.error(
    '[particles] 未找到 #canvas，粒子层已禁用（背景层与属性桥不受影响）',
  );
}

/* ————————————————————————————————————————————
 *  WGSL 着色器
 * ———————————————————————————————————————————— */

/**
 * compute 与 vertex 共用的 WGSL 片段：时间折回常量与风场/湍流函数。
 *
 * "物理与渲染走同一条轨迹"是整套设计的地基，两侧必须逐字一致——所以这里只
 * 写一份，由两个着色器插值共用。改这里即同时改变物理与渲染，不会出现只改了
 * 一侧、粒子被静默画到轨迹之外的情况。
 *
 * @constant {string}
 */
const WGSL_COMMON = /* wgsl */ `
// 把任意距离的坐标折回 [minValue, maxValue)，而不是只修正一次。
// 这同时覆盖窗口缩放、较大风场位移以及单帧跨越多个世界周期的情况。
fn wrapRange(value: f32, minValue: f32, maxValue: f32) -> f32 {
  let range = maxValue - minValue;
  return value - range * floor((value - minValue) / range);
}

const TIME_WRAP: f32 = 628.3185307179587; // 200π，所有时间频率的共同周期

fn swayX(phase: f32, amplitude: f32) -> f32 {
  return (sin(phase * 2.0) * 26.0 + sin(phase) * 16.0) * amplitude;
}

fn swayY(phase: f32, amplitude: f32) -> f32 {
  return cos(phase * 2.2) * 13.0 * amplitude;
}

fn gustPulse(phase: f32) -> f32 {
  return 0.55 + 0.45 * sin(phase * 0.18 + 2.0);
}

fn windXOffset(x: f32, y: f32, phase: f32) -> f32 {
  let wind = sin(x * 0.006 + phase * 0.8 + 1.3) * 16.0
           + sin(y * 0.005 - phase * 0.35 + 0.7) * 20.0
           + sin((x + y) * 0.0025 - phase * 0.12) * 22.0;
  return wind * gustPulse(phase);
}

fn windZOffset(x: f32, y: f32, phase: f32) -> f32 {
  return sin(x * 0.0035 + y * 0.0035 + phase * 0.25) * 45.0 * gustPulse(phase);
}
`;

/**
 * 物理步进 compute shader（WGSL）。
 *
 * 每个线程处理一个粒子：基础运动 + 物理湍流/风场位移 + 三轴边界环绕。
 * 活跃粒子数由 uniform count 控制（i >= count 的线程直接返回，
 * 对应粒子不再步进、各自保留最后一次被写入的状态——不重置、无闪烁），
 * 工作组分发数 = ceil(count / 64)。
 *
 * @constant {string}
 */
const COMPUTE_SHADER = /* wgsl */ `
struct Particle {
  posX: f32, posY: f32, posZ: f32, _p0: f32,  // _p0：粒子局部模拟时钟
  velX: f32, velY: f32, velZ: f32, _p1: f32,  // _p1：湍流幅度
}

struct Uniforms {
  speedFactor: f32,
  worldHalf:   f32,   // x 半宽
  yHalf:       f32,   // 盒子世界：y 半高（小于 x）
  zMin:        f32,   // 盒子世界：z 下限（可见深度带远端）
  zMax:        f32,   // 盒子世界：z 上限（相机后 1 单位环绕落点）
  cameraZ:     f32,   // 相机 Z（近处收敛系数需要每颗粒子的深度）
  count:       u32,
}

@group(0) @binding(0) var<storage, read>       src: array<Particle>;
@group(0) @binding(1) var<storage, read_write>  dst: array<Particle>;
@group(0) @binding(2) var<uniform>              u:   Uniforms;

${WGSL_COMMON}

// 每个固定物理步（FIXED_STEP = 1/60 秒）推进的相位量：1/60 相位 = 1 秒真实
// 时间。风场与阵风的时间尺度因此与 aSpeed 滑杆（speedFactor）解耦——与把
// 风场移入物理位置之前用真实秒数当相位的行为一致。
const PHASE_PER_STEP: f32 = 1.0 / 60.0;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= u.count) { return; }

  var p = src[i];

  // _p0 是每个粒子的局部模拟时钟（初始值随机），让湍流和风场在物理步进中
  // 改变粒子轨迹，而不是在顶点着色器里把粒子"画"到另一个位置。
  // 相位按固定步长推进（1 相位 = 1 秒真实时间，见 PHASE_PER_STEP），不随
  // aSpeed 滑杆变化；再按共同周期折回以防 f32 精度退化。
  let phase0 = p._p0;
  let phase1 = wrapRange(phase0 + PHASE_PER_STEP, 0.0, TIME_WRAP);

  let nextX = p.posX + p.velX * u.speedFactor;
  let nextY = p.posY + p.velY * u.speedFactor;
  let nextZ = p.posZ + p.velZ * u.speedFactor;

  // 近处收敛：靠近镜头的湍流/风场位移按深度衰减（dist < 500 起衰减，下限
  // 0.35），避免贴脸雪花摆动过剧——与风场进入物理位置之前 nearScale 的语义
  // 一致。compute / vertex 用同一表达式与同一 p.posZ，保证两侧轨迹一致。
  let nearScale = clamp((u.cameraZ - p.posZ) / 500.0, 0.35, 1.0);

  // 湍流、横向风、深度风都以"位移差"形式进入模拟位置，避免每帧重复叠加
  // 一个绝对偏移值造成无界漂移。风场按当前物理位置采样，形成空间变化的气流。
  let deltaSwayX = (swayX(phase1, p._p1) - swayX(phase0, p._p1)) * nearScale;
  let deltaSwayY = (swayY(phase1, p._p1) - swayY(phase0, p._p1)) * nearScale;
  let deltaWindX = (windXOffset(p.posX, p.posY, phase1)
                  - windXOffset(p.posX, p.posY, phase0)) * nearScale;
  let deltaWindZ = (windZOffset(p.posX, p.posY, phase1)
                  - windZOffset(p.posX, p.posY, phase0)) * nearScale;

  p.posX = nextX + deltaSwayX + deltaWindX;
  p.posY = nextY + deltaSwayY;
  p.posZ = nextZ + deltaWindZ;
  p._p0 = phase1;

  // 三轴统一使用模运算式环绕，缩放后落在新边界之外或一步跨越多个周期也有效。
  // Y 的双向折返只会在缩小世界或湍流上移时触发；正常下落仍从下边界回到上方。
  p.posX = wrapRange(p.posX, -u.worldHalf, u.worldHalf);
  p.posY = wrapRange(p.posY, -u.yHalf, u.yHalf);
  p.posZ = wrapRange(p.posZ, u.zMin, u.zMax);

  dst[i] = p;
}
`;

/**
 * 顶点着色器（WGSL）— 实例化 billboard 四边形 + 时间外推。
 *
 * 每个实例 = 一个粒子，4 个顶点组成正方形（triangle-strip）。
 * 外推：根据 u.extrapFactor（基础速度）与 u.extrapPhase（风场相位的分数步）
 * 把粒子位置前推到当前时间点，使渲染位置对齐到当前帧而非上一个物理步。
 * 粒子轨迹中的湍流摆动、横向风场与深度风场由 compute shader 写入物理位置；
 * 本着色器只做固定步长外推和投影，避免显示位置与碰撞/环绕位置分离。
 * 近处收敛：与 compute shader 使用同一个 nearScale（dist < 500 起衰减、下限
 * 0.35），保证同一颗粒子在两侧得到同一段位移。
 * 近距处理：屏幕半径封顶 MAX_SR（防 1/dist 病态填充率尖峰），
 * dist < NEAR_DIST 的粒子 alpha 平滑渐隐至 0（镜头前"化开"，替代贴脸圆盘）。
 * 深度门控：物理在相机后方、或预测位置已越过镜头的粒子恒不可见——后者若不
 * 拦下，z 环绕会先把它丢到远平面、近距渐隐随即失效，于是以满透明度闪现。
 * 远距处理：按预测深度越过远平面（cameraZ + 1000）后平滑淡出，在盒子世界
 * z 下限（cameraZ - zMin）处完全透明——此后所有 z/x/y 环绕都在不可见区域
 * 发生，消除远距小粒子凭空消失 / 凭空冒出 / 远距闪现。
 * 视锥门控：仅覆盖 billboard 屏幕半径与少量外推余量，不再补偿渲染期风场位移。
 *
 * @constant {string}
 */
const VERTEX_SHADER = /* wgsl */ `
struct Particle {
  posX: f32, posY: f32, posZ: f32, _p0: f32,  // _p0：粒子局部模拟时钟
  velX: f32, velY: f32, velZ: f32, _p1: f32,  // _p1：湍流幅度
}

// 注意：此结构必须与片元着色器中的 Uniforms 完全一致（两者共用同一 binding）。
struct Uniforms {
  focalLength:    f32,
  cameraZ:        f32,
  screenW:        f32,
  screenH:        f32,
  particleRadius: f32,
  pink:           f32,
  extrapFactor:   f32,   // speedFactor × (accum / FIXED_STEP)，0 时不外推
  extrapPhase:    f32,   // (accum / FIXED_STEP) / 60：分数步对应的相位增量
  worldHalf:      f32,   // 动态世界 x 半宽（由 JS 根据视锥计算）
  yHalf:          f32,   // 盒子世界：y 半高
  zMin:           f32,   // 盒子世界：z 下限
  zMax:           f32,   // 盒子世界：z 上限
}

// 近距处理常量：屏幕半径封顶（物理像素）与近距渐隐距离（世界单位）
const MAX_SR: f32 = 48.0;
const NEAR_DIST: f32 = 35.0;

// 远距渐隐带的最小宽度（世界单位）：保证 smoothstep 的 edge0 < edge1 恒成立。
const MIN_FAR_FADE: f32 = 32.0;

${WGSL_COMMON}

@group(0) @binding(0) var<storage, read> particles: array<Particle>;
@group(0) @binding(1) var<uniform>       u:         Uniforms;

struct VertexOut {
  @builtin(position) pos:  vec4<f32>,
  @location(0)        uv:   vec2<f32>,
  @location(1)        fade: f32,
}

// 四边形局部坐标（不含顶点缓冲区，用 vertex_index 索引）
const QUAD: array<vec2<f32>, 4> = array(
  vec2(-1.0, -1.0), vec2( 1.0, -1.0),
  vec2(-1.0,  1.0), vec2( 1.0,  1.0),
);
const UV: array<vec2<f32>, 4> = array(
  vec2(0.0, 0.0), vec2(1.0, 0.0),
  vec2(0.0, 1.0), vec2(1.0, 1.0),
);

@vertex
fn main(
  @builtin(instance_index) i: u32,
  @builtin(vertex_index)   v: u32,
) -> VertexOut {
  let p = particles[i];

  // —— 物理状态外推 ——
  // 固定步长之间的少量剩余时间也按同一套风场位移差外推，保持高刷新率平滑；
  // 这只是对下一小段物理运动的预测，不是独立的视觉位移。
  let phase0 = p._p0;
  let phase1 = wrapRange(phase0 + u.extrapPhase, 0.0, TIME_WRAP);
  // 与 compute shader 相同的近处收敛系数（同一表达式、同一 p.posZ）。
  let nearScale = clamp((u.cameraZ - p.posZ) / 500.0, 0.35, 1.0);
  let deltaSwayX = (swayX(phase1, p._p1) - swayX(phase0, p._p1)) * nearScale;
  let deltaSwayY = (swayY(phase1, p._p1) - swayY(phase0, p._p1)) * nearScale;
  let deltaWindX = (windXOffset(p.posX, p.posY, phase1)
                  - windXOffset(p.posX, p.posY, phase0)) * nearScale;
  let deltaWindZ = (windZOffset(p.posX, p.posY, phase1)
                  - windZOffset(p.posX, p.posY, phase0)) * nearScale;
  var px = p.posX + p.velX * u.extrapFactor + deltaSwayX + deltaWindX;
  var py = p.posY + p.velY * u.extrapFactor + deltaSwayY;
  var pz = p.posZ + p.velZ * u.extrapFactor + deltaWindZ;

  // 环绕之前的预测深度。可见性门控用预测深度，而不是缓冲区里尚未外推的
  // p.posZ：否则预测已越过 zMax（跑到镜头后）的粒子会先被环绕丢到远平面，
  // 再被基于 p.posZ 的门控判为"在镜头前"，以满透明度在远平面闪现。
  let predDist = u.cameraZ - pz;

  // 与 compute shader 完全一致的模运算式环绕，处理外推越界和新尺寸下的旧状态。
  let rangeX = 2.0 * u.worldHalf;
  let rangeY = 2.0 * u.yHalf;
  let rangeZ = u.zMax - u.zMin;
  px = px - rangeX * floor((px + u.worldHalf) / rangeX);
  py = py - rangeY * floor((py + u.yHalf) / rangeY);
  pz = pz - rangeZ * floor((pz - u.zMin) / rangeZ);

  let dist = u.cameraZ - pz;

  var out: VertexOut;
  out.uv = UV[v];

  // 深度门控（二者取一即不可见）：
  // ① physDist <= 0：物理上在相机后方（含 z 环绕落点）的粒子恒不可见——
  // 迎面风可能把渲染深度推到镜头前，需要这条兜底；
  // ② predDist <= 0：预测位置已越过镜头。此时环绕会把该粒子丢到远平面，
  // dist 变成远距值、近距渐隐不生效，必须在此拦下，否则它以满透明度闪现。
  let physDist = u.cameraZ - p.posZ;
  var fade: f32 = 1.0;
  if (physDist <= 0.0 || predDist <= 0.0) {
    fade = 0.0;
  } else {
    // 近距渐隐：dist < NEAR_DIST 的粒子 alpha 平滑衰减至 0（镜头前"化开"）。
    if (dist <= NEAR_DIST) {
      fade = smoothstep(0.0, NEAR_DIST, dist);
    }

    // 远距渐隐：按预测深度越过远平面（cameraZ + 1000，即 JS 侧 MAX_DIST）
    // 后平滑淡出，到世界 z 下限对应的深度（cameraZ - zMin，盒子世界远端
    // 环绕平面）时完全透明。该深度之后所有环绕（z 环绕落点、x/y 环绕）都
    // 发生在屏外或已完全淡出——消除：① 远距粒子 z 环绕瞬移到相机后方
    // （凭空消失）；② 相机后方粒子 z 环绕落到远距可见区（凭空冒出）；
    // ③ 远距 x/y 环绕在屏内闪现。
    // 用预测深度：风场已进入物理位置，渐隐跟随真实轨迹，不再需要"必须用
    // 未受扰动的物理深度，否则透明度随风场呼吸"的旧约束。
    // 起点取 MAX_DIST（cameraZ + 1000）与"远端环绕面前 MIN_FAR_FADE"的较小值：
    // 前者是设计上的最远可见距离，后者保证 smoothstep 的 edge0 < edge1。现行
    // 世界参数下 farFadeEnd 恒大于 MAX_DIST（见 _updateWorldSize 的不变量），
    // 所以这里取到的始终是 MAX_DIST；万一将来常量被调坏，也只是把渐隐带压窄，
    // 不会退化成 edge0 > edge1 的未定义行为。
    let farFadeEnd = u.cameraZ - u.zMin;
    let farFadeStart = min(u.cameraZ + 1000.0, farFadeEnd - MIN_FAR_FADE);
    if (predDist > farFadeStart) {
      fade *= 1.0 - smoothstep(farFadeStart, farFadeEnd, predDist);
    }
  }

  // 视锥门控只需覆盖 billboard 本身的屏幕半径（再加少量外推余量）；
  // 风场已进入物理位置，不再需要用 ±110 世界单位的宽渐隐带来掩盖渲染/物理不一致。
  let halfW = predDist * u.screenW / (2.0 * u.focalLength);
  let halfH = predDist * u.screenH / (2.0 * u.focalLength);
  let edgeMargin = max(12.0, MAX_SR * max(predDist, 0.0) / max(u.focalLength, 1.0) + 8.0);
  if (abs(px) > halfW) {
    fade *= 1.0 - smoothstep(halfW, halfW + edgeMargin, abs(px));
  }
  if (abs(py) > halfH) {
    fade *= 1.0 - smoothstep(halfH, halfH + edgeMargin, abs(py));
  }
  out.fade = fade;

  // 屏幕半径（物理像素）封顶：sr ∝ 1/dist 在近处无上界，单枚近距粒子
  // 可铺满整屏（4K 下病态填充率尖峰）。封顶后每个 quad 至多 ~96px 见方。
  let rawSr = u.particleRadius * (u.focalLength / max(dist, 0.001));
  var sr = min(rawSr, MAX_SR);

  // 完全不可见（镜头后 / 渐隐完成，fade = 0）→ 半径归零成零面积四边形，
  // 不产生任何片元——等效于原 sr < 0.5 剔除，且粒子仍在物理缓冲中继续模拟。
  if (fade <= 0.0) { sr = 0.0; }

  // 投影系数：安全除法（防止 dist 过小时除零）
  let projScale = u.focalLength / max(dist, 1.001);

  // sy 转为屏幕像素坐标（Y 向下）；下方像素 → NDC 时再取负，
  // 两次取负相抵，最终世界 +Y 映射到 NDC +Y（屏幕上方）。
  let sx = px * projScale;
  let sy = -py * projScale;

  let ndcX = (sx / u.screenW) * 2.0 + QUAD[v].x * sr / u.screenW * 2.0;
  let ndcY = -(sy / u.screenH) * 2.0 + QUAD[v].y * sr / u.screenH * 2.0;

  out.pos = vec4(ndcX, ndcY, 0.0, 1.0);
  return out;
}
`;

/**
 * 片元着色器（WGSL）— 径向渐变圆（smoothstep 衰减 × 近距渐隐 fade），
 * 预乘 alpha 输出（匹配 canvas 的 premultiplied alphaMode）。
 *
 * Uniforms 结构与顶点着色器完全一致（同一 binding 共用）；
 * 本着色器只读取 pink，其他字段仅供顶点着色器使用。
 *
 * @constant {string}
 */
const FRAGMENT_SHADER = /* wgsl */ `
struct Uniforms {
  focalLength:    f32,
  cameraZ:        f32,
  screenW:        f32,
  screenH:        f32,
  particleRadius: f32,
  pink:           f32,
  extrapFactor:   f32,  // 顶点着色器专用，此处不读取
  extrapPhase:    f32,  // 顶点着色器专用，此处不读取
  worldHalf:      f32,  // 顶点着色器专用，此处不读取
  yHalf:          f32,  // 顶点着色器专用，此处不读取
  zMin:           f32,  // 顶点着色器专用，此处不读取
  zMax:           f32,  // 顶点着色器专用，此处不读取
}

@group(0) @binding(1) var<uniform> u: Uniforms;

fn computeAlpha(d: f32) -> f32 {
  // smoothstep：中心保持 ~0.75，越过 ~0.20 后光滑衰减至边缘为 0。
  return 0.75 * (1.0 - smoothstep(0.20, 1.0, d));
}

@fragment
fn main(
  @location(0) uv:   vec2<f32>,
  @location(1) fade: f32,
) -> @location(0) vec4<f32> {
  let d = length(uv - 0.5) * 2.0;  // 0 在中心，1 在内接圆边缘
  let alpha = computeAlpha(d) * fade;  // fade：近距渐隐，来自顶点着色器

  let white = vec3(1.0, 1.0, 1.0);
  let pink  = vec3(0.96078, 0.70196, 0.73725);  // 245,179,188 #f5b3bc
  let color = mix(white, pink, u.pink);

  // 预乘输出：color 通道预先乘 alpha（配合 blend color srcFactor: one）。
  return vec4(color * alpha, alpha);
}
`;

/* ————————————————————————————————————————————
 *  模块状态
 * ———————————————————————————————————————————— */

/** @type {?GPUDevice} */
let _device = null;

/** @type {?GPUCanvasContext} */
let _context = null;

/** @type {GPUTextureFormat} */
let _format = 'bgra8unorm';

/** @type {?GPUQueue} */
let _queue = null;

/* ——— 管线 —————————————————————————————————— */

/** @type {?GPUComputePipeline} */
let _computePipeline = null;

/** @type {?GPURenderPipeline} */
let _renderPipeline = null;

/* ——— 缓冲区 ———————————————————————————————— */

/** @type {?GPUBuffer} */
let _buf0 = null;

/** @type {?GPUBuffer} */
let _buf1 = null;

/** @type {number} 当前用作 compute src 的缓冲区索引（0 或 1）。 */
let _currentSrc = 0;

/** @type {?GPUBuffer} */
let _computeUniformBuf = null;

/** @type {?GPUBuffer} */
let _renderUniformBuf = null;

/* ——— 绑定组 ———————————————————————————————— */

/**
 * compute 绑定组：下标 = source 缓冲区下标，与 _currentSrc / 局部 src 同义。
 * 用「数组 + 下标」而不是两个变量，含义由语法保证——不依赖命名约定，也不会因为
 * 重命名或调整 _rebuildBindGroups 里的顺序而悄悄失效。0 号以 _buf0 为 source。
 *
 * @type {Array<?GPUBindGroup>}
 */
const _computeBindGroups = [null, null];

/**
 * render 绑定组：下标 = 要读取的缓冲区下标（与 _currentSrc 同义）。
 *
 * @type {Array<?GPUBindGroup>}
 */
const _renderBindGroups = [null, null];

/**
 * Compute uniform 共用缓冲区（Float32Array 视图）。
 * 布局：[speedFactor, worldHalf, yHalf, zMin, zMax, cameraZ, count(u32)]
 * 共 7 个字段 → 28 字节（count 为 u32，仍占 4 字节）。
 *
 * @type {Float32Array}
 */
const _computeUniformData = new Float32Array(7);

/**
 * Compute uniform 共用缓冲区的 Uint32Array 视图（用于写入 u32 count 字段）。
 *
 * @type {Uint32Array}
 */
const _computeUniformU32 = new Uint32Array(_computeUniformData.buffer);

/**
 * Render uniform 共用缓冲区（Float32Array 视图）。
 * 布局：[focalLength, cameraZ, screenW, screenH, particleRadius, pink, extrapFactor, extrapPhase, worldHalf, yHalf, zMin, zMax]
 * 共 12 个 f32 → 48 字节。
 *
 * @type {Float32Array}
 */
const _renderUniformData = new Float32Array(12);

/**
 * 每帧 render uniform 临时缓冲区（两个 f32，写入 offset 24）：
 * [extrapFactor, extrapPhase]——前者外推基础速度、后者外推风场相位，都对应
 * 同一段"剩余分数步"（extrapFactor = speedFactor × 分数步，
 * extrapPhase = 分数步 / 60），由 handleFrame 每帧成对写入。
 *
 * @type {Float32Array}
 */
const _extrapData = new Float32Array(2);

/**
 * Render pass 描述符模板（colorAttachments[0].view 每帧替换）。
 *
 * @type {GPURenderPassDescriptor}
 */
const _renderPassDescriptor = {
  colorAttachments: [
    {
      view: null,
      clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
      loadOp: 'clear',
      storeOp: 'store',
    },
  ],
};

/**
 * colorAttachment 引用缓存：handleFrame 每帧少两层属性寻址。收益很小（远小于
 * 一帧的 GPU 开销），保留它是因为零代价、且让热路径更短；取值一律走数组解构，
 * 不要写回 colorAttachments[0] 下标访问。
 *
 * @type {GPURenderPassColorAttachment}
 */
const [_colorAttachment] = _renderPassDescriptor.colorAttachments;

/**
 * Queue submit 参数数组（预分配，避免每帧创建）。
 *
 * @type {Array<GPUCommandBuffer>}
 */
const _submitArray = [null];

/* ——— 参数 —————————————————————————————————— */

/** @type {number} 当前活跃粒子数。 */
let _count = 500;

/** @type {number} 当前速度系数。 */
let _speedFactor = 1;

/** @type {boolean} 当前粉色模式开关。 */
let _pink = false;

/** @type {number} 画布宽度（物理像素）。 */
let _screenW;

/** @type {number} 画布高度（物理像素）。 */
let _screenH;

/** @type {number} 投影焦距。 */
let _focalLength;

/** @type {number} 固定物理步长（ms），对应 60fps。 */
const FIXED_STEP = 1000 / 60;

/** @type {number} 当前 workgroup 分发数 = ceil(count / 64)。 */
let _workgroupCount = Math.ceil(500 / 64);

/* ——— 3D 世界常量（动态） —————————————————— */

/** @type {number} 世界 x 半宽（世界范围为 [-_worldHalf, _worldHalf]）。 */
let _worldHalf = 2000; // 初始值，稍后会被 _updateWorldSize 覆盖

/** @type {number} 世界 x 总宽。 */
let _worldSize = 4000;

/** @type {number} 世界 y 半高（盒子世界：远 fade 终点视锥半高 + 余量）。 */
let _yHalf = 2000;

/** @type {number} 世界 z 下限（盒子世界：可见深度带远端环绕平面）。 */
let _zMin = -2000;

/** @type {number} 世界 z 上限（盒子世界：相机后 1 单位环绕落点）。 */
let _zMax = 1001;

/** @type {number} 相机 Z 坐标。 */
const CAMERA_Z = 1000;

/** @type {number} 最远可见距离（世界单位），相机前方 1000。 */
const MAX_DIST = CAMERA_Z + 1000;

/** @type {number} 视场角（弧度），75°。 */
const FOV = (75 * Math.PI) / 180;

/** @type {number} 角度转弧度系数。 */
const TO_RAD = Math.PI / 180;

/** @type {number} 粒子 billboard 半径（世界单位）。 */
const PARTICLE_RADIUS = 11;

/** @type {number} 最大粒子缓冲区容量。 */
const MAX_COUNT = 1000;

/* ——— 累加器 ———————————————————————————————— */

/** @type {number} 上一帧时间戳（ms）。 */
let _lastTime = 0;

/** @type {number} 物理累加器（ms）。 */
let _accum = 0;

/* ——— rAF 句柄 ——————————————————————————— */

/** @type {?number} requestAnimationFrame 句柄。非 null 表示循环处于运行态。 */
let _rafId = null;

/* ——— 设备初始化 / 重试 ————————————————————— */

/** @type {number} 本轮初始化的尝试次数（成功后清零），用于给重试封顶。 */
let _initAttempts = 0;

/**
 * @type {boolean} 是否曾经成功初始化过。
 *
 * 用来区分"首帧就失败"（例如机器根本没有 WebGPU，重试必然复现，不重试）与
 * "曾经能跑、后来设备丢了"（值得重试）。不能用 _initAttempts 判断——它成功
 * 后会清零，于是"计数器 > 1"不再等价于"曾经成功过"。
 */
let _everReady = false;

/** @type {?number} 设备丢失后的重试定时器句柄。 */
let _retryTimer = null;

/** @type {boolean} _initGPU 的重入保护。 */
let _initializing = false;

/** @type {number} 单轮初始化允许的最大尝试次数（成功后清零，每轮重新计）。 */
const MAX_INIT_ATTEMPTS = 3;

/** @type {number} 设备丢失后的重试间隔（ms）。 */
const RETRY_DELAY_MS = 2000;

/* ————————————————————————————————————————————
 *  工具函数
 * ———————————————————————————————————————————— */

/**
 * 生成 [min, max) 范围内的随机浮点数。
 *
 * @param {number} min - 下界（含）。
 * @param {number} max - 上界（不含）。
 * @returns {number} 随机浮点数。
 */
function randomRange(min, max) {
  return Math.random() * (max - min) + min;
}

/**
 * 统一致停：设备丢失、uncapturederror（GPU 校验错误）、帧内同步异常时调用。
 *
 * 置空 _device 与 _queue（此后公开 API 的 uniform 写入函数均变为空操作，
 * 不会向已失效的队列提交），并取消/清空 _rafId。
 * frameLoop 每帧末尾只在 _rafId 非空时才请求下一帧，因此无论本函数
 * 在帧内（同步调用）还是帧间（事件回调取消挂起的下一帧）被调用，
 * 都能真正终止循环——修复了原先"cancel 之后 frameLoop 又 request"
 * 导致循环无法停下、以空设备状态无限空转的问题。
 *
 * 同时释放对 GPU 资源的引用：绑定组 / 管线 / 缓冲区各自都持有 device 引用，
 * 只置空 _device 会让整张失效设备图保持可达。重试时 _initGPU 会重建它们。
 *
 * @returns {void}
 */
function _shutdown() {
  _device = null;
  _queue = null;
  // 一并置空对失效设备的引用（含上下文：重试时 canvas.getContext('webgpu')
  // 返回同一个上下文对象，无需保留旧引用）。
  _context = null;
  _buf0 = null;
  _buf1 = null;
  _computePipeline = null;
  _renderPipeline = null;
  _computeUniformBuf = null;
  _renderUniformBuf = null;
  _computeBindGroups[0] = null;
  _computeBindGroups[1] = null;
  _renderBindGroups[0] = null;
  _renderBindGroups[1] = null;
  // 有意不在这里清空画布：设备丢失后 GPU 提交会被丢弃（什么也提交不出去），
  // 而非 GPU 的清空手段（隐藏 canvas / 重置后备缓冲）会把"设备丢失到重试成功
  // 之间的约 2 秒"从"雪花静止"变成"雪花消失又回来"，对瞬态丢失反而更突兀；
  // 永久失败时一张静止的雪景也比空场景更接近优雅降级。冻结帧还会在下一次
  // resize（重置后备缓冲）时自然消失，不会长期残留。
  if (_rafId !== null) {
    cancelAnimationFrame(_rafId);
    _rafId = null;
  }
}

/**
 * 安排一次设备重试（只用于设备丢失后的恢复）。
 *
 * 设备丢失（驱动重置、切换独显/核显、DWM 重置等）通常是瞬态的，
 * 重新 requestAdapter + requestDevice 一般能拿回一个新设备；而
 * uncapturederror（校验错误）是确定性的，重试必然复现，因此不走这里。
 * 尝试次数以 MAX_INIT_ATTEMPTS 封顶（每轮初始化独立计）、间隔 RETRY_DELAY_MS，
 * 避免无限重试刷屏。
 *
 * @returns {void}
 */
function _scheduleRetry() {
  if (_retryTimer !== null) {
    return;
  }
  if (_initAttempts >= MAX_INIT_ATTEMPTS) {
    console.warn(
      `[particles] 设备丢失后重试 ${_initAttempts} 次仍未恢复，停止重试，回退到纯 CSS 背景`,
    );
    return;
  }
  _retryTimer = setTimeout(() => {
    _retryTimer = null;
    void _initGPU();
  }, RETRY_DELAY_MS);
}

/**
 * 初始化失败时的统一出口：致停；只有"曾经成功初始化过"的机器才继续重试——
 * 首帧就失败的机器（例如根本没有 WebGPU）重试必然复现，不安排重试。
 *
 * @returns {void}
 */
function _abortInit() {
  _shutdown();
  if (_everReady) {
    _scheduleRetry();
  }
}

/**
 * 根据当前屏幕宽高比重新计算世界尺寸（盒子世界），并更新 uniforms。
 *
 * x 半宽取远平面视锥覆盖范围（+10% 余量，下限 2000），保证 x 环绕永远
 * 在屏幕外；y 半高取远 fade 终点处视锥半高（+10% 余量），z 范围收紧为
 * 可见深度带 + 相机后 1 单位环绕落点——避免粒子预算躺在相机后方和
 * 远平面之外睡觉。
 *
 * @returns {void}
 */
function _updateWorldSize() {
  const halfH = Math.tan(FOV / 2) * MAX_DIST;
  const halfW = halfH * (_screenW / _screenH);
  const newHalf = Math.ceil(Math.max(halfW, halfH) * 1.1);
  // 下限 2000：极窄屏（竖屏）下视锥变小，仍保证世界体积不至于过小
  _worldHalf = Math.max(newHalf, 2000);
  _worldSize = _worldHalf * 2;

  // 盒子世界：y/z 不再跟随 x 走满整个世界。
  // farFadeEnd = 远距渐隐终点。保留 115 世界单位的屏外缓冲，确保边界环绕
  // 与 billboard 的边缘渐隐带均发生在可见视锥之外，减少边缘闪现。
  const EDGE_MARGIN = 115;
  const farFadeEnd = Math.min(
    ((_worldHalf - EDGE_MARGIN) * 2 * _focalLength) / _screenW,
    CAMERA_Z + _worldHalf,
  );
  // 不变量：farFadeEnd > MAX_DIST，否则着色器里的远距渐隐会变成 edge0 > edge1。
  // 现行参数下恒成立——_worldHalf 有 2000 硬下限、又乘了 1.1 余量，把上式
  // 化简后横屏约为 2200 − 150/aspect、竖屏不小于 2457，故任意宽高比下
  // farFadeEnd ≥ ≈2073，比 MAX_DIST = 2000 至少宽 73 世界单位。
  // 着色器端另有 MIN_FAR_FADE 兜底，常量被调坏时也不会出现未定义行为。
  // y 半高：远 fade 终点处视锥半高 × 1.1 余量，保证 y 环绕始终在屏外
  _yHalf = Math.ceil(Math.tan(FOV / 2) * farFadeEnd * 1.1);
  // z 范围：可见深度带 [cameraZ - farFadeEnd, cameraZ] + 相机后 1 单位环绕落点
  _zMin = CAMERA_Z - farFadeEnd;
  _zMax = CAMERA_Z + 1;
  // 重新写入 uniforms（如果设备已就绪）
  _writeComputeUniforms();
  _writeRenderUniforms();
}

/**
 * 生成 n 个粒子的初始数据。
 *
 * 每个粒子 8 个 f32：
 *   [posX, posY, posZ, _p0, velX, velY, velZ, _p1]
 *
 * 初始位置在世界盒子内均匀随机分布（x ∈ ±_worldHalf，y ∈ ±_yHalf，
 * z ∈ [_zMin, _zMax]），
 * 初始速度以 baseVy 为基础做锥形扩散（模拟雪花飘落）。
 * _p0 / _p1 分别为粒子局部模拟时钟的初始相位与湍流幅度（个体差异）。
 *
 * @param {number} n - 要生成的粒子数量。
 * @returns {Float32Array} 粒子数据（长度 n × 8）。
 */
function _generateParticleData(n) {
  const data = new Float32Array(n * 8);
  // 基础下落速度（世界单位/物理步，≈ −5.33）。它只是"基础运动"的尺度，速度
  // 调节由滑杆经 speedFactor 在 compute shader 里统一缩放（aSpeed = 2000 时
  // ×0.75 → 约 −4 单位/步）；下面据此做 ±45° 锥形扩散，模拟雪花各向飘落。
  const baseVy = (-8 * 40) / 60;

  for (let i = 0; i < n; i++) {
    const ax = randomRange(-45, 45) * TO_RAD;
    const vy = baseVy * Math.cos(ax);
    let vz = baseVy * Math.sin(ax);

    const ay = randomRange(0, 360) * TO_RAD;
    const vx = vz * Math.sin(ay);
    vz = vz * Math.cos(ay);

    const off = i * 8;
    data[off] = Math.random() * _worldSize - _worldHalf;
    data[off + 1] = Math.random() * (_yHalf * 2) - _yHalf;
    data[off + 2] = _zMin + Math.random() * (_zMax - _zMin);
    data[off + 3] = Math.random() * Math.PI * 2;
    data[off + 4] = vx;
    data[off + 5] = vy;
    data[off + 6] = vz;
    data[off + 7] = randomRange(0.5, 1.2);
  }

  return data;
}

/**
 * 创建粒子存储缓冲区（buf0 / buf1）。
 *
 * 按 MAX_COUNT 一次性分配，大小固定。
 * usage: STORAGE（shader 读写）+ COPY_DST（CPU 写入初始数据）。
 *
 * @returns {void}
 */
function _createParticleBuffers() {
  if (!_device) {
    return;
  }
  const size = MAX_COUNT * 8 * 4;

  _buf0 = _device.createBuffer({
    size,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  _buf1 = _device.createBuffer({
    size,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  _rebuildBindGroups();
}

/**
 * 生成并上传全新粒子初始数据到两个 ping-pong 缓冲区，
 * 并重置 _currentSrc 为 0（下一帧 compute 以 buf0 为 src）。
 *
 * @returns {void}
 */
function _uploadFreshParticleData() {
  if (!_queue || !_buf0 || !_buf1) {
    return;
  }
  const data = _generateParticleData(MAX_COUNT);
  _queue.writeBuffer(_buf0, 0, data);
  _queue.writeBuffer(_buf1, 0, data);
  _currentSrc = 0;
}

/**
 * 重建所有 GPU 绑定组（compute 与 render 各一对，下标 = source 缓冲区）。
 *
 * 依赖 _computePipeline、_renderPipeline、_buf0、_buf1 均已就绪。
 *
 * @returns {void}
 */
function _rebuildBindGroups() {
  if (!_buf0 || !_buf1) {
    return;
  }
  if (!_computePipeline || !_renderPipeline) {
    return;
  }

  _computeBindGroups[0] = _device.createBindGroup({
    layout: _computePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: _buf0 } },
      { binding: 1, resource: { buffer: _buf1 } },
      { binding: 2, resource: { buffer: _computeUniformBuf } },
    ],
  });

  _computeBindGroups[1] = _device.createBindGroup({
    layout: _computePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: _buf1 } },
      { binding: 1, resource: { buffer: _buf0 } },
      { binding: 2, resource: { buffer: _computeUniformBuf } },
    ],
  });

  _renderBindGroups[0] = _device.createBindGroup({
    layout: _renderPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: _buf0 } },
      { binding: 1, resource: { buffer: _renderUniformBuf } },
    ],
  });

  _renderBindGroups[1] = _device.createBindGroup({
    layout: _renderPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: _buf1 } },
      { binding: 1, resource: { buffer: _renderUniformBuf } },
    ],
  });
}

/* ————————————————————————————————————————————
 *  Uniform 更新
 * ———————————————————————————————————————————— */

/**
 * 将 compute uniform 数据写入 GPU 缓冲区。
 *
 * 布局：[speedFactor: f32, worldHalf: f32, yHalf: f32, zMin: f32, zMax: f32, cameraZ: f32, count: u32]
 *
 * @returns {void}
 */
function _writeComputeUniforms() {
  if (!_queue || !_computeUniformBuf) {
    return;
  }
  _computeUniformData[0] = _speedFactor;
  _computeUniformData[1] = _worldHalf;
  _computeUniformData[2] = _yHalf;
  _computeUniformData[3] = _zMin;
  _computeUniformData[4] = _zMax;
  _computeUniformData[5] = CAMERA_Z;
  _computeUniformU32[6] = _count;
  _queue.writeBuffer(_computeUniformBuf, 0, _computeUniformData);
}

/**
 * 将 render uniform 数据写入 GPU 缓冲区。
 *
 * 布局：[focalLength, cameraZ, screenW, screenH, particleRadius, pink, extrapFactor, extrapPhase, worldHalf, yHalf, zMin, zMax]
 * extrapFactor 与 extrapPhase 在这里写入**当前值**：属性回调可能发生在帧间，
 * 缓冲区任意时刻都应自洽。handleFrame 每帧会用最新值覆盖 offset 24 的这两个
 * f32。
 *
 * @returns {void}
 */
function _writeRenderUniforms() {
  if (!_queue || !_renderUniformBuf) {
    return;
  }
  _renderUniformData[0] = _focalLength;
  _renderUniformData[1] = CAMERA_Z;
  _renderUniformData[2] = _screenW;
  _renderUniformData[3] = _screenH;
  _renderUniformData[4] = PARTICLE_RADIUS;
  _renderUniformData[5] = _pink ? 1.0 : 0.0;
  // extrapFactor / extrapPhase：写入当前值（handleFrame 每帧刷新这两个字段）
  _renderUniformData[6] = _speedFactor * (_accum / FIXED_STEP);
  _renderUniformData[7] = _accum / FIXED_STEP / 60;
  _renderUniformData[8] = _worldHalf;
  _renderUniformData[9] = _yHalf;
  _renderUniformData[10] = _zMin;
  _renderUniformData[11] = _zMax;
  _queue.writeBuffer(_renderUniformBuf, 0, _renderUniformData);
}

/* ————————————————————————————————————————————
 *  GPU 初始化（异步）
 * ———————————————————————————————————————————— */

/**
 * 断言条件成立，否则抛出错误。
 * 用于 try 块中快速失败，将控制权交给统一的 catch。
 *
 * @param {*} value - 待检查的值
 * @param {string} message - 错误信息
 * @throws {Error} 当 value 为 null 或 undefined 时抛出。
 * @returns {void}
 */
function _guard(value, message) {
  if (value == null) {
    // 同时覆盖 null 和 undefined
    throw new Error(message);
  }
}

/**
 * 设备初始化入口：重入保护 + 尝试计数；实际工作见 _initGPUResources()。
 *
 * 设备丢失后的重试（_scheduleRetry）也走这里，因此首帧初始化与重试共用
 * 同一条路径，不存在两套初始化逻辑。
 *
 * @returns {Promise<void>}
 */
async function _initGPU() {
  if (_initializing || _device) {
    return;
  }
  _initializing = true;
  _initAttempts++;
  try {
    await _initGPUResources();
  } finally {
    _initializing = false;
  }
}

/**
 * 初始化 WebGPU 设备、管线、缓冲区。
 *
 * 异步获取 GPUAdapter → GPUDevice，创建 compute + render pipeline，
 * 分配粒子缓冲区并写入初始数据。
 *
 * 无参：就绪时直接读取 canvas 当前尺寸计算 _screenW/_screenH/焦距——避免异步初始化
 * 期间发生 resize 后，用启动时的旧尺寸覆盖新尺寸的竞态。
 *
 * 任何失败路径（无 WebGPU 支持、adapter 获取失败、设备创建失败、
 * 上下文/管线/缓冲区创建异常、uncapturederror）均经 _shutdown() 释放设备
 * 并停止可能已在运行的 rAF 循环，此时 CSS 背景层仍持续可见。
 * 设备获取与资源创建类失败走 _abortInit()：重试过程中的失败会再安排一次
 * 重试，首帧就失败（例如机器本就没有 WebGPU）则不再重试。
 *
 * @returns {Promise<void>}
 */
async function _initGPUResources() {
  if (!canvas) {
    // 没有渲染目标：不启动粒子层，也不安排重试；模块本身保持可用。
    _abortInit();
    return;
  }
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    _abortInit();
    return;
  }

  try {
    // 注：Chromium 在 Windows 上会忽略 requestAdapter 的 powerPreference
    // （crbug.com/369219127），GPU 由系统分配给进程，传该选项无效且打警告。
    // 双显卡机型如需指定 GPU，请用户在 Windows「设置 → 系统 → 屏幕 → 显示卡」
    // 中为 wallpaper32.exe / webwallpaper32.exe 指定高性能或节能 GPU。
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      _abortInit();
      return;
    }
    const device = await adapter.requestDevice();
    if (!device) {
      _abortInit();
      return;
    }
    _device = device;
  } catch {
    _abortInit();
    return;
  }

  _queue = _device.queue;
  // 本次创建的设备实例：下面两道监听都以它为准（device 是 try 块内的局部量，
  // 出了块就不可见，所以必须在这里用函数作用域的量捕获）。
  const thisDevice = _device;

  // 设备丢失（驱动重置 / 切换独显核显 / DWM 重置 / 页面抢占等）：先致停，
  // 再安排一次有上限的重试——这类丢失通常是瞬态的，重新取设备即可恢复。
  // 两道监听都以本次创建的 device 为准：重试成功后旧设备的迟到事件不得影响
  // 新设备（否则一个迟到的校验错误会把刚恢复的设备再打掉）。
  _device.lost.then((info) => {
    if (_device !== thisDevice) {
      return;
    }
    console.warn('[particles] WebGPU 设备丢失:', info.reason, info.message);
    _shutdown();
    _scheduleRetry();
  });

  // GPU 校验错误（submit/dispatch 等）不会抛 JS 异常，只走 uncapturederror
  // 事件——原先的 try/catch 抓不到这类错误。此处监听并统一致停，
  // 兑现"任何 GPU 异常停止循环"的行为约定，同时避免每帧重复报错刷屏。
  // 校验错误是确定性的，重试必然复现，因此这里不做重试。
  _device.addEventListener('uncapturederror', (ev) => {
    if (_device !== thisDevice) {
      return;
    }
    console.warn('[particles] 未捕获的 GPU 错误，粒子已停止:', ev.error);
    _shutdown();
  });

  try {
    // 异步等待期间可能发生过 resize，此处读取 canvas 的"当前"尺寸。
    _screenW = canvas.width;
    _screenH = canvas.height;
    _focalLength = _screenH / (2 * Math.tan(FOV / 2));

    _context = canvas.getContext('webgpu');
    _guard(_context, '获取 webgpu 上下文失败');
    _format = navigator.gpu.getPreferredCanvasFormat();
    _context.configure({
      device: _device,
      format: _format,
      alphaMode: 'premultiplied',
      // 画布纹理只作为渲染附件使用（没有任何 copyTextureToBuffer /
      // copyBufferToTexture 针对它），因此不需要声明 COPY_DST。
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });

    _computeUniformBuf = _device.createBuffer({
      size: 28, // 7 个字段（cameraZ + u32 count）
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    _renderUniformBuf = _device.createBuffer({
      size: 48, // 12 个 f32
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const computeModule = _device.createShaderModule({ code: COMPUTE_SHADER });
    const vertexModule = _device.createShaderModule({ code: VERTEX_SHADER });
    const fragmentModule = _device.createShaderModule({
      code: FRAGMENT_SHADER,
    });

    _computePipeline = _device.createComputePipeline({
      layout: 'auto',
      compute: { module: computeModule, entryPoint: 'main' },
    });

    _renderPipeline = _device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: vertexModule,
        entryPoint: 'main',
        buffers: [],
      },
      fragment: {
        module: fragmentModule,
        entryPoint: 'main',
        targets: [
          {
            format: _format,
            blend: {
              color: {
                srcFactor: 'one',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
              alpha: {
                srcFactor: 'one',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
            },
          },
        ],
      },
      primitive: {
        topology: 'triangle-strip',
        stripIndexFormat: undefined,
      },
    });

    _createParticleBuffers();
    // 先按当前 canvas 尺寸定好世界，再播种粒子：异步初始化期间若发生过
    // resize，这里算出的才是这颗 canvas 真正要用的盒子。世界尺寸只由宽高比
    // 决定，因此同比例换分辨率（1080p → 4K）不改变任何边界。
    _updateWorldSize();
    _uploadFreshParticleData();

    // 初始化成功：清空本轮尝试计数，并记下"这台机器能跑 WebGPU"。计数清零让
    // 下一次设备丢失重新拿到完整的重试预算（否则它会跨进程累加，几次丢失之后
    // 就永久退化成纯 CSS 背景）；_everReady 让后续失败仍然值得重试。
    _initAttempts = 0;
    _everReady = true;

    // 竞态兜底：settings.js 在模块加载时（设备就绪前）就调用了 start()，
    // 彼时 _device 为 null 会被跳过——若不在设备就绪后重启循环，帧循环
    // 永远不会开始。start() 幂等：此处已运行则 no-op，未运行则补启动。
    start();
  } catch (err) {
    console.warn('[particles] GPU 初始化失败，回退到纯 CSS 背景:', err);
    _abortInit();
  }
}

/* ————————————————————————————————————————————
 *  帧处理
 * ———————————————————————————————————————————— */

/**
 * 单帧处理：固定步长物理更新 + 渲染。
 *
 * 1. 计算 elapsed → 累加到 _accum
 * 2. 消耗 floor(_accum / FIXED_STEP) 次 compute pass（ping-pong）
 * 3. 写入外推因子 → render pass（instanced draw）
 * 4. submit
 *
 * GPU 设备未就绪时直接返回（等待初始化完成）。
 * 任何 GPU 异常（设备丢失经 .lost、校验错误经 uncapturederror、
 * 帧内同步异常经此处 catch）都会经 _shutdown() 置空设备并真正停止
 * rAF 循环。
 *
 * @param {number} timestamp - requestAnimationFrame 传入的高精度时间戳（ms）。
 * @returns {void}
 */
function handleFrame(timestamp) {
  if (!_device) {
    return;
  }
  if (!_buf0 || _count <= 0) {
    return;
  }

  if (!_lastTime) {
    _lastTime = timestamp;
  }

  // 限制单帧增量，避免壁纸被挂起/切换回来后一次性补帧导致雪花瞬移
  const elapsed = Math.min(timestamp - _lastTime, 200);
  _lastTime = timestamp;
  _accum += elapsed;

  let steps = 0;
  while (_accum >= FIXED_STEP) {
    _accum -= FIXED_STEP;
    steps++;
  }

  try {
    const encoder = _device.createCommandEncoder();

    // compute 侧资源是否就绪（管线 + 两个 ping-pong 绑定组）。单独命名后，
    // 下面这行 if 只表达"本帧是否有物理步进"，其余判断留在赋值表达式里。
    const computeReady =
      _computePipeline && _computeBindGroups[0] && _computeBindGroups[1];
    if (steps > 0 && computeReady) {
      const cp = encoder.beginComputePass();
      cp.setPipeline(_computePipeline);
      let src = _currentSrc;
      for (let s = 0; s < steps; s++) {
        cp.setBindGroup(0, _computeBindGroups[src]);
        cp.dispatchWorkgroups(_workgroupCount);
        src = 1 - src;
      }
      cp.end();
      // 步进结束后 _currentSrc 指向"最后一次被写入的 dst 缓冲区"，
      // 即最新数据所在缓冲区——渲染即从该缓冲区读取。
      _currentSrc = src;
    }

    // extrapFactor：基础速度的分数步外推；
    // extrapPhase：同一分数步对应的风场相位增量（整步为 1/60 相位 = 1 秒）。
    _extrapData[0] = _speedFactor * (_accum / FIXED_STEP);
    _extrapData[1] = _accum / FIXED_STEP / 60;
    _queue.writeBuffer(_renderUniformBuf, 24, _extrapData);

    _colorAttachment.view = _context.getCurrentTexture().createView();
    const rp = encoder.beginRenderPass(_renderPassDescriptor);

    if (_renderPipeline && _renderBindGroups[0] && _renderBindGroups[1]) {
      rp.setPipeline(_renderPipeline);
      rp.setBindGroup(0, _renderBindGroups[_currentSrc]);
      rp.draw(4, _count);
    }

    rp.end();

    _submitArray[0] = encoder.finish();
    _queue.submit(_submitArray);
  } catch (err) {
    console.warn('[particles] 帧渲染失败，粒子已停止:', err);
    _shutdown();
  }
}

/* ————————————————————————————————————————————
 *  rAF 帧循环
 * ———————————————————————————————————————————— */

/**
 * requestAnimationFrame 帧循环回调。
 *
 * 委托 handleFrame 处理帧逻辑，然后仅在循环仍处于运行态
 * （_rafId 非空）时请求下一帧。handleFrame / _shutdown 的致命
 * 错误路径会置空 _rafId，从而在此处真正停下——否则会出现
 * "cancel 之后又 request"导致循环复活、以空设备状态无限空转。
 *
 * @param {number} timestamp - requestAnimationFrame 传入的高精度时间戳（ms）。
 * @returns {void}
 */
function frameLoop(timestamp) {
  handleFrame(timestamp);
  if (_rafId !== null) {
    _rafId = requestAnimationFrame(frameLoop);
  }
}

/**
 * 清空粒子画布（一次性透明清屏）。
 *
 * setCount(0) 停止帧循环后，画布上会残留最后渲染的静止雪花——提交一个
 * 无绘制的 render pass，利用描述符的 loadOp: 'clear' 把画布清为全透明。
 * 仅在设备就绪时执行；失败路径与 handleFrame 一致（致停）。
 *
 * @returns {void}
 */
function _clearParticles() {
  if (!_device || !_context) {
    return;
  }
  try {
    _colorAttachment.view = _context.getCurrentTexture().createView();
    const encoder = _device.createCommandEncoder();
    const rp = encoder.beginRenderPass(_renderPassDescriptor);
    rp.end();
    _submitArray[0] = encoder.finish();
    _queue.submit(_submitArray);
  } catch (err) {
    console.warn('[particles] 清空画布失败，粒子已停止:', err);
    _shutdown();
  }
}

/* ————————————————————————————————————————————
 *  resize 处理（防抖）
 * ———————————————————————————————————————————— */

/** @type {?number} resize 防抖定时器句柄。 */
let _resizeTimer = null;

/** @type {?MediaQueryList} 当前 devicePixelRatio 对应的媒体查询。 */
let _dprQuery = null;

/**
 * 按当前窗口尺寸与 devicePixelRatio 重建 canvas backing store。
 *
 * 重新计算画布物理分辨率与投影焦距，并重算世界尺寸。
 * GPU 尚未就绪时 uniform 写入自行跳过，且 _initGPU 就绪时读取的是 canvas
 * 当前尺寸，故异步初始化期间 resize 不丢失。
 *
 * @returns {void}
 */
function _applyCanvasSize() {
  if (!canvas) {
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  _screenW = Math.max(1, Math.floor(window.innerWidth * dpr));
  _screenH = Math.max(1, Math.floor(window.innerHeight * dpr));
  canvas.width = _screenW;
  canvas.height = _screenH;
  _focalLength = _screenH / (2 * Math.tan(FOV / 2));
  _updateWorldSize();
}

/**
 * 防抖地重建画布（150ms），并按新的 dpr 重新挂载监听。
 *
 * @returns {void}
 */
function _scheduleCanvasRebuild() {
  if (_resizeTimer !== null) {
    clearTimeout(_resizeTimer);
  }
  _resizeTimer = setTimeout(() => {
    _resizeTimer = null;
    _applyCanvasSize();
    _watchDevicePixelRatio();
  }, 150);
}

/**
 * dpr 变化回调（跨屏迁移 / 系统缩放调整）。
 *
 * @returns {void}
 */
function _onDprChange() {
  _scheduleCanvasRebuild();
}

/**
 * 为当前 devicePixelRatio 挂一次变化监听。
 *
 * 只改 dpr、不改 innerWidth/innerHeight 时（把壁纸拖到另一种缩放比的显示器，
 * 或调整系统缩放），部分浏览器不派发 resize，只让
 * matchMedia('(resolution: Xdppx)') 变化——那样画布不会重建，壁纸会保持模糊。
 * 这里为当前 dpr 挂监听，触发后走同一段重建逻辑，并按新 dpr 重新挂载
 * （媒体查询里的 dppx 值必须跟着更新）。
 *
 * @returns {void}
 */
function _watchDevicePixelRatio() {
  if (typeof window.matchMedia !== 'function') {
    return;
  }
  if (_dprQuery) {
    _dprQuery.removeEventListener('change', _onDprChange);
  }
  const dpr = window.devicePixelRatio || 1;
  _dprQuery = window.matchMedia(`(resolution: ${dpr}dppx)`);
  _dprQuery.addEventListener('change', _onDprChange);
}

// 窗口 resize 与 dpr 变化走同一条重建路径。
window.addEventListener('resize', () => {
  _scheduleCanvasRebuild();
});
_watchDevicePixelRatio();

/* ————————————————————————————————————————————
 *  公开 API
 * ———————————————————————————————————————————— */

/**
 * 启动粒子动画帧循环。
 *
 * 幂等调用——如果 rAF 已在运行则忽略。
 * 仅当设备就绪且粒子数 > 0 时才真正启动，避免空转。
 *
 * @returns {void}
 */
export function start() {
  if (_rafId !== null) {
    return;
  }
  if (_device && _count > 0) {
    _rafId = requestAnimationFrame(frameLoop);
  }
}

/**
 * 设置活跃粒子数量。
 *
 * 仅更新 uniform count 和 workgroup 分发数，不重建缓冲区。
 * 值会被 clamp 到 [0, MAX_COUNT] 并向下取整；输入为 null/undefined
 * 或非有限数值（NaN / Infinity）时回退为 500。
 * 设为 0 时停止帧循环（无 GPU 工作，避免 rAF 空转）并清空画布上的
 * 静止粒子，恢复为正数时自动重启循环（重置 _lastTime 与 _accum，
 * 避免一次性补帧）。
 * GPU 就绪前调用仅记录值，待初始化完成后随 uniform 一并生效。
 *
 * @param {number} n - 目标粒子数量。
 * @returns {void}
 */
export function setCount(n) {
  let v;
  if (n == null) {
    v = 500;
  } else {
    const x = Number(n);
    v = Number.isFinite(x)
      ? Math.max(0, Math.min(MAX_COUNT, Math.floor(x)))
      : 500;
  }

  if (v !== _count) {
    _count = v;
    _workgroupCount = Math.ceil(_count / 64);
    _writeComputeUniforms();

    // 0 粒子：停循环并清空画布（否则残留最后一帧的静止雪花）；
    // >0 且设备就绪且循环未运行：重启循环。
    if (v === 0) {
      if (_rafId !== null) {
        cancelAnimationFrame(_rafId);
        _rafId = null;
      }
      _clearParticles();
    } else if (_rafId === null && _device) {
      _lastTime = 0;
      _accum = 0;
      _rafId = requestAnimationFrame(frameLoop);
    }
  }
}

/**
 * 设置粒子降落速度。
 *
 * speedFactor = 1500 / s，s 越大降落越慢。
 * 输入为 null/undefined 时按默认值 2000 处理；s 为 0 / 负数 /
 * 非有限数值时同样回退为默认（1500/2000 = 0.75），避免速度
 * 变成 Infinity 或 NaN 使粒子瞬间飞出世界。
 *
 * @param {number} s - Wallpaper Engine speed 滑杆值（范围 500–3500）。
 * @returns {void}
 */
export function setSpeed(s) {
  const x = s != null ? Number(s) : 2000;
  _speedFactor = Number.isFinite(x) && x > 0 ? 1500 / x : 0.75;
  _writeComputeUniforms();
}

/**
 * 设置粒子颜色模式。
 *
 * @param {boolean} enabled - true 为粉色粒子，false 为白色粒子。
 * @returns {void}
 */
export function setPink(enabled) {
  _pink = !!enabled;
  _writeRenderUniforms();
}

/* ————————————————————————————————————————————
 *  启动
 * ———————————————————————————————————————————— */

// 按屏幕物理分辨率设置 canvas backing store（多少 K 的屏就渲染多少 K），
// 并算好焦距与世界尺寸——与 resize / dpr 变化走同一段逻辑。
_applyCanvasSize();

void _initGPU();
