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

/** @type {HTMLCanvasElement} */
const canvas = document.getElementById('canvas');

/* ————————————————————————————————————————————
 *  WGSL 着色器
 * ———————————————————————————————————————————— */

/**
 * 物理步进 compute shader（WGSL）。
 *
 * 每个线程处理一个粒子：位移 + 边界环绕。
 * 活跃粒子数由 uniform count 控制（i >= count 的线程直接返回，
 * 对应粒子不再步进、各自保留最后一次被写入的状态——不重置、无闪烁），
 * 工作组分发数 = ceil(count / 64)。
 *
 * @constant {string}
 */
const COMPUTE_SHADER = /* wgsl */ `
struct Particle {
  posX: f32, posY: f32, posZ: f32, _p0: f32,  // _p0：湍流摆动相位
  velX: f32, velY: f32, velZ: f32, _p1: f32,  // _p1：湍流摆动幅度
}

struct Uniforms {
  speedFactor: f32,
  worldHalf:   f32,   // x 半宽
  worldSize:   f32,   // x 总宽
  yHalf:       f32,   // 盒子世界：y 半高（小于 x）
  zMin:        f32,   // 盒子世界：z 下限（可见深度带远端）
  zMax:        f32,   // 盒子世界：z 上限（相机后 1 单位环绕落点）
  count:       u32,
}

@group(0) @binding(0) var<storage, read>       src: array<Particle>;
@group(0) @binding(1) var<storage, read_write>  dst: array<Particle>;
@group(0) @binding(2) var<uniform>              u:   Uniforms;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= u.count) { return; }

  var p = src[i];

  p.posX += p.velX * u.speedFactor;
  p.posY += p.velY * u.speedFactor;
  p.posZ += p.velZ * u.speedFactor;

  // Y 单向环绕（粒子只下落；盒子世界 y 半高小于 x）
  if (p.posY < -u.yHalf) { p.posY += 2.0 * u.yHalf; }

  // X 双向环绕
  if (p.posX > u.worldHalf) {
    p.posX -= u.worldSize;
  } else if (p.posX < -u.worldHalf) {
    p.posX += u.worldSize;
  }

  // Z 双向环绕（盒子世界：z 范围 = 可见深度带 + 相机后环绕落点）
  if (p.posZ > u.zMax) {
    p.posZ -= u.zMax - u.zMin;
  } else if (p.posZ < u.zMin) {
    p.posZ += u.zMax - u.zMin;
  }

  dst[i] = p;
}
`;

/**
 * 顶点着色器（WGSL）— 实例化 billboard 四边形 + 时间外推。
 *
 * 每个实例 = 一个粒子，4 个顶点组成正方形（triangle-strip）。
 * 外推：根据 u.extrapFactor 将粒子位置沿速度方向前推，
 * 使渲染位置对齐到当前时间点而非上一个物理步时间点。
 * 轨迹增强：在外推基础上叠加湍流摆动 + 空间风场 + 阵风脉冲（仅渲染期，
 * 不写回物理缓冲），近处粒子按深度收敛幅度。
 * 近距处理：屏幕半径封顶 MAX_SR（防 1/dist 病态填充率尖峰），
 * dist < NEAR_DIST 的粒子 alpha 平滑渐隐至 0（镜头前"化开"，替代贴脸圆盘）。
 * 可见性门控：物理上在相机后方的粒子恒不可见（渲染期风场可能把渲染深度
 * 推到镜头前，使 z 环绕落点在阵风峰值时闪现）；物理位置越出视锥横向
 * 范围时按越界量渐隐（风场可能把渲染位置推入屏内，造成屏幕边缘闪现）。
 * 远距处理：按物理深度（未受渲染期风场扰动）越过远平面（cameraZ + 1000）
 * 后平滑淡出，在盒子世界 z 下限（cameraZ - zMin）处完全透明——此后所有
 * z/x/y 环绕都在不可见区域发生，消除远距小粒子凭空消失 / 凭空冒出 /
 * 远距闪现；用物理深度使渐隐不随风场摆动，避免透明度"呼吸"。
 *
 * @constant {string}
 */
const VERTEX_SHADER = /* wgsl */ `
struct Particle {
  posX: f32, posY: f32, posZ: f32, _p0: f32,  // _p0：湍流摆动相位
  velX: f32, velY: f32, velZ: f32, _p1: f32,  // _p1：湍流摆动幅度
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
  time:           f32,   // 渲染期时间（秒），用于轨迹增强
  worldHalf:      f32,   // 动态世界 x 半宽（由 JS 根据视锥计算）
  worldSize:      f32,   // 动态世界 x 总宽
  yHalf:          f32,   // 盒子世界：y 半高
  zMin:           f32,   // 盒子世界：z 下限
  zMax:           f32,   // 盒子世界：z 上限
}

// 近距处理常量：屏幕半径封顶（物理像素）与近距渐隐距离（世界单位）
const MAX_SR: f32 = 48.0;
const NEAR_DIST: f32 = 35.0;

// 轨迹增强的最大位移（world units），用于视锥横向门控的渐隐带宽：
// 横向 swayX(±50) + windX(±58) ≈ ±110；纵向 swayY ≈ ±16
const WIND_SWAY_X: f32 = 110.0;
const SWAY_Y: f32 = 16.0;

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

  // —— 时间外推 ——
  var px = p.posX + p.velX * u.extrapFactor;
  var py = p.posY + p.velY * u.extrapFactor;
  var pz = p.posZ + p.velZ * u.extrapFactor;

  // 边界环绕（与 compute shader 一致：x/y/z 各自的范围）
  if (py < -u.yHalf) { py += 2.0 * u.yHalf; }
  if (px > u.worldHalf) {
    px -= u.worldSize;
  } else if (px < -u.worldHalf) {
    px += u.worldSize;
  }
  if (pz > u.zMax) {
    pz -= u.zMax - u.zMin;
  } else if (pz < u.zMin) {
    pz += u.zMax - u.zMin;
  }

  // —— 轨迹增强（仅渲染期，不改动物理缓冲）——
  let t = u.time;
  // 单片湍流：两路正弦叠加，每片雪花独立相位 / 幅度（个体差异）
  let swayX = (sin(t * 2.0 + p._p0) * 26.0
             + sin(t * 1.0 + p._p0 * 1.71) * 16.0) * p._p1;
  let swayY = cos(t * 2.2 + p._p0) * 13.0 * p._p1;

  // 阵风脉冲：周期约 35s，整体风力"一阵一阵"
  let gustPulse = 0.55 + 0.45 * sin(t * 0.18 + 2.0);

  // 空间采样风场：相位随粒子位置变化（行波），不同区域风向不同
  let wind =
      sin(px * 0.006 + t * 0.8 + 1.3) * 16.0
    + sin(py * 0.005 - t * 0.35 + 0.7) * 20.0
    + sin((px + py) * 0.0025 - t * 0.12) * 22.0;
  let windX = wind * gustPulse;

  // 深度风：前后方向的缓慢飘移，增强立体感
  let windZ = sin(px * 0.0035 + py * 0.0035 + t * 0.25) * 45.0 * gustPulse;

  // 近处雪花适当收敛，避免贴脸时过于剧烈
  let nearScale = clamp((u.cameraZ - pz) / 500.0, 0.35, 1.0);
  px += (swayX + windX) * nearScale;
  py += swayY * nearScale;
  pz += windZ * nearScale;

  let dist = u.cameraZ - pz;

  var out: VertexOut;
  out.uv = UV[v];

  // 近距渐隐：dist < NEAR_DIST 的粒子 alpha 平滑衰减至 0（镜头前"化开"）。
  // 相机后方（dist <= 0）同样 fade = 0，天然不可见。
  var fade: f32 = 1.0;
  if (dist <= NEAR_DIST) {
    fade = smoothstep(0.0, NEAR_DIST, dist);
  }

  // 物理深度门控：物理上在相机后方（含 z 环绕落点 +1001）的粒子恒不可见。
  // 渲染期风场（windZ ±45×gustPulse）可能把渲染深度推到镜头前，使环绕
  // 到达的粒子在阵风峰值时以满透明度闪现——近距渐隐无法覆盖这种情况
  // （渲染深度 > NEAR_DIST 时它不生效），必须用物理深度做可见性兜底。
  let physDist = u.cameraZ - p.posZ;
  if (physDist <= 0.0) {
    fade = 0.0;
  }

  // 远距渐隐基于物理深度（physDist，未受渲染期风场扰动）：越过远平面
  // （cameraZ + 1000，即 JS 侧 MAX_DIST）后平滑淡出，到世界 z 下限对应的
  // 深度（cameraZ - zMin，盒子世界远端环绕平面）时完全透明。该深度之后
  // 所有环绕（z 环绕落点、x/y 环绕）都发生在屏外或已完全淡出——消除：
  // ① 远距粒子 z 环绕瞬移到相机后方（凭空消失）；② 相机后方粒子 z 环绕
  // 落到远距可见区（凭空冒出）；③ 远距 x/y 环绕在屏内闪现。
  // 必须用物理深度而非渲染深度：windZ（±45 世界单位）会使渲染深度在
  // 渐隐带内来回穿越，造成透明度"呼吸"（半透明 → 清晰 → 半透明）。
  let farFadeStart = u.cameraZ + 1000.0;
  if (physDist > farFadeStart) {
    fade *= 1.0 - smoothstep(farFadeStart, u.cameraZ - u.zMin, physDist);
  }

  // 视锥横向门控：物理位置在视锥横向范围之外时，渲染期风场/湍流摆动
  // （横向最多 ±110 世界单位、纵向 ±16）可能把渲染位置推入屏内，风一转
  // 又瞬间离开——按物理横向越界量渐隐（渐隐带宽 = 风场最大位移），越界
  // 粒子在风场可触及的范围内已完全透明，屏幕边缘的闪现消失。物理越界
  // 粒子本就渲染在屏外，此门控不影响正常可见粒子。
  let halfW = physDist * u.screenW / (2.0 * u.focalLength);
  let halfH = physDist * u.screenH / (2.0 * u.focalLength);
  if (abs(p.posX) > halfW) {
    fade *= 1.0 - smoothstep(halfW, halfW + WIND_SWAY_X, abs(p.posX));
  }
  if (abs(p.posY) > halfH) {
    fade *= 1.0 - smoothstep(halfH, halfH + SWAY_Y, abs(p.posY));
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
  time:           f32,  // 顶点着色器专用，此处不读取
  worldHalf:      f32,  // 顶点着色器专用，此处不读取
  worldSize:      f32,  // 顶点着色器专用，此处不读取
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

/** @type {?GPUBindGroup} */
let _computeBG_AB = null;

/** @type {?GPUBindGroup} */
let _computeBG_BA = null;

/** @type {?GPUBindGroup} */
let _renderBG_0 = null;

/** @type {?GPUBindGroup} */
let _renderBG_1 = null;

/**
 * Compute uniform 共用缓冲区（Float32Array 视图）。
 * 布局：[speedFactor, worldHalf, worldSize, yHalf, zMin, zMax, count(u32)]
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
 * 布局：[focalLength, cameraZ, screenW, screenH, particleRadius, pink, extrapFactor, time, worldHalf, worldSize, yHalf, zMin, zMax]
 * 共 13 个 f32 → 52 字节。
 *
 * @type {Float32Array}
 */
const _renderUniformData = new Float32Array(13);

/**
 * 每帧 render uniform 临时缓冲区（两个 f32，写入 offset 24）：
 * [extrapFactor, time(秒)]。time 供顶点着色器渲染期轨迹增强使用。
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
 * colorAttachment 引用缓存（V8 写法优化）：handleFrame 每帧只做一次
 * 模块上下文槽加载 + 属性写入，省去每帧两层属性寻址。
 *
 * @type {GPURenderPassColorAttachment}
 */
const _colorAttachment = _renderPassDescriptor.colorAttachments[0];

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
let W;

/** @type {number} 画布高度（物理像素）。 */
let H;

/** @type {number} 投影焦距。 */
let _focalLength;

/** @type {number} 固定物理步长（ms），对应 60fps。 */
const FIXED_STEP = 1000 / 60;

/** @type {number} 当前 workgroup 分发数 = ceil(count / 64)。 */
let _workgroupCount = Math.ceil(500 / 64);

/* ——— 3D 世界常量（动态） —————————————————— */

/** @type {number} 世界 x 半宽（世界范围为 [-WORLD_HALF, WORLD_HALF]）。 */
let WORLD_HALF = 2000;   // 初始值，稍后会被 _updateWorldSize 覆盖

/** @type {number} 世界 x 总宽。 */
let WORLD_SIZE = 4000;

/** @type {number} 世界 y 半高（盒子世界：远 fade 终点视锥半高 + 余量）。 */
let Y_HALF = 2000;

/** @type {number} 世界 z 下限（盒子世界：可见深度带远端环绕平面）。 */
let Z_MIN = -2000;

/** @type {number} 世界 z 上限（盒子世界：相机后 1 单位环绕落点）。 */
let Z_MAX = 1001;

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
 * @returns {void}
 */
function _shutdown() {
  _device = null;
  _queue = null;
  if (_rafId !== null) {
    cancelAnimationFrame(_rafId);
    _rafId = null;
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
  const halfW = halfH * (W / H);
  const newHalf = Math.ceil(Math.max(halfW, halfH) * 1.1);
  // 下限 2000：极窄屏（竖屏）下视锥变小，仍保证世界体积不至于过小
  WORLD_HALF = Math.max(newHalf, 2000);
  WORLD_SIZE = WORLD_HALF * 2;

  // 盒子世界：y/z 不再跟随 x 走满整个世界。
  // farFadeEnd = 远距渐隐终点。理论值 = 世界 x 边界与视锥相交的临界深度，
  // 但顶点着色器的渲染期风场/湍流摆动会使粒子的渲染位置横向偏移最多
  // ~110 世界单位（swayX ±50 + windX ±58），因此再扣减 WIND_MARGIN——
  // 保证 x 环绕的渲染落点（±WORLD_HALF ± 风场偏移）在渐隐完成时仍落在
  // 屏外，消除远距屏幕边缘的淡粒子闪现/跳动（竖屏时受最大可见距离约束）。
  const WIND_MARGIN = 115;
  const farFadeEnd = Math.min(
    ((WORLD_HALF - WIND_MARGIN) * 2 * _focalLength) / W,
    CAMERA_Z + WORLD_HALF,
  );
  // y 半高：远 fade 终点处视锥半高 × 1.1 余量，保证 y 环绕始终在屏外
  Y_HALF = Math.ceil(Math.tan(FOV / 2) * farFadeEnd * 1.1);
  // z 范围：可见深度带 [cameraZ - farFadeEnd, cameraZ] + 相机后 1 单位环绕落点
  Z_MIN = CAMERA_Z - farFadeEnd;
  Z_MAX = CAMERA_Z + 1;
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
 * 初始位置在世界盒子内均匀随机分布（x ∈ ±WORLD_HALF，y ∈ ±Y_HALF，
 * z ∈ [Z_MIN, Z_MAX]），
 * 初始速度以 baseVy 为基础做锥形扩散（模拟雪花飘落）。
 * _p0 / _p1 为渲染期湍流摆动的独立相位与幅度（个体差异）。
 *
 * @param {number} n - 要生成的粒子数量。
 * @returns {Float32Array} 粒子数据（长度 n × 8）。
 */
function _generateParticleData(n) {
  const data = new Float32Array(n * 8);
  const baseVy = (-8 * 40) / 60;

  for (let i = 0; i < n; i++) {
    const ax = randomRange(-45, 45) * TO_RAD;
    const vy = baseVy * Math.cos(ax);
    let vz = baseVy * Math.sin(ax);

    const ay = randomRange(0, 360) * TO_RAD;
    const vx = vz * Math.sin(ay);
    vz = vz * Math.cos(ay);

    const off = i * 8;
    data[off] = Math.random() * WORLD_SIZE - WORLD_HALF;
    data[off + 1] = Math.random() * (Y_HALF * 2) - Y_HALF;
    data[off + 2] = Z_MIN + Math.random() * (Z_MAX - Z_MIN);
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
  if (!_device) return;
  const size = MAX_COUNT * 8 * 4;

  _buf0 = _device.createBuffer({
    size: size,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  _buf1 = _device.createBuffer({
    size: size,
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
  if (!_queue || !_buf0 || !_buf1) return;
  const data = _generateParticleData(MAX_COUNT);
  _queue.writeBuffer(_buf0, 0, data);
  _queue.writeBuffer(_buf1, 0, data);
  _currentSrc = 0;
}

/**
 * 重建所有 GPU 绑定组（compute AB/BA + render 0/1）。
 *
 * 依赖 _computePipeline、_renderPipeline、_buf0、_buf1 均已就绪。
 *
 * @returns {void}
 */
function _rebuildBindGroups() {
  if (!_buf0 || !_buf1) return;
  if (!_computePipeline || !_renderPipeline) return;

  _computeBG_AB = _device.createBindGroup({
    layout: _computePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: _buf0 } },
      { binding: 1, resource: { buffer: _buf1 } },
      { binding: 2, resource: { buffer: _computeUniformBuf } },
    ],
  });

  _computeBG_BA = _device.createBindGroup({
    layout: _computePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: _buf1 } },
      { binding: 1, resource: { buffer: _buf0 } },
      { binding: 2, resource: { buffer: _computeUniformBuf } },
    ],
  });

  _renderBG_0 = _device.createBindGroup({
    layout: _renderPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: _buf0 } },
      { binding: 1, resource: { buffer: _renderUniformBuf } },
    ],
  });

  _renderBG_1 = _device.createBindGroup({
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
 * 布局：[speedFactor: f32, worldHalf: f32, worldSize: f32, yHalf: f32, zMin: f32, zMax: f32, count: u32]
 *
 * @returns {void}
 */
function _writeComputeUniforms() {
  if (!_queue || !_computeUniformBuf) return;
  _computeUniformData[0] = _speedFactor;
  _computeUniformData[1] = WORLD_HALF;
  _computeUniformData[2] = WORLD_SIZE;
  _computeUniformData[3] = Y_HALF;
  _computeUniformData[4] = Z_MIN;
  _computeUniformData[5] = Z_MAX;
  _computeUniformU32[6] = _count;
  _queue.writeBuffer(_computeUniformBuf, 0, _computeUniformData);
}

/**
 * 将 render uniform 数据写入 GPU 缓冲区。
 *
 * 布局：[focalLength, cameraZ, screenW, screenH, particleRadius, pink, extrapFactor, time, worldHalf, worldSize, yHalf, zMin, zMax]
 * extrapFactor 与 time 不在此函数中写入，由 handleFrame 每帧单独更新（offset 24）。
 *
 * @returns {void}
 */
function _writeRenderUniforms() {
  if (!_queue || !_renderUniformBuf) return;
  _renderUniformData[0] = _focalLength;
  _renderUniformData[1] = CAMERA_Z;
  _renderUniformData[2] = W;
  _renderUniformData[3] = H;
  _renderUniformData[4] = PARTICLE_RADIUS;
  _renderUniformData[5] = _pink ? 1.0 : 0.0;
  _renderUniformData[6] = 0;   // extrapFactor（每帧覆盖）
  _renderUniformData[7] = 0;   // time（每帧覆盖）
  _renderUniformData[8] = WORLD_HALF;
  _renderUniformData[9] = WORLD_SIZE;
  _renderUniformData[10] = Y_HALF;
  _renderUniformData[11] = Z_MIN;
  _renderUniformData[12] = Z_MAX;
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
  if (value == null) { // 同时覆盖 null 和 undefined
    throw new Error(message);
  }
}

/**
 * 初始化 WebGPU 设备、管线、缓冲区。
 *
 * 异步获取 GPUAdapter → GPUDevice，创建 compute + render pipeline，
 * 分配粒子缓冲区并写入初始数据。
 *
 * 无参：就绪时直接读取 canvas 当前尺寸计算 W/H/焦距——避免异步初始化
 * 期间发生 resize 后，用启动时的旧尺寸覆盖新尺寸的竞态。
 *
 * 任何失败路径（无 WebGPU 支持、adapter 获取失败、设备创建失败、
 * 上下文/管线/缓冲区创建异常、uncapturederror）均经 _shutdown() 置空
 * _device 并停止可能已在运行的 rAF 循环，此时 CSS 背景层仍持续可见。
 *
 * @returns {Promise<void>}
 */
async function _initGPU() {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    _shutdown();
    return;
  }

  try {
    // 注：Chromium 在 Windows 上会忽略 requestAdapter 的 powerPreference
    // （crbug.com/369219127），GPU 由系统分配给进程，传该选项无效且打警告。
    // 双显卡机型如需指定 GPU，请用户在 Windows「设置 → 系统 → 屏幕 → 显示卡」
    // 中为 wallpaper32.exe / webwallpaper32.exe 指定高性能或节能 GPU。
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      _shutdown();
      return;
    }
    const device = await adapter.requestDevice();
    if (!device) {
      _shutdown();
      return;
    }
    _device = device;
  } catch {
    _shutdown();
    return;
  }

  _queue = _device.queue;

  // 设备丢失（驱动重置 / 页面抢占等）：停止循环，回退纯 CSS 背景。
  _device.lost.then(function (info) {
    console.warn('[particles] WebGPU 设备丢失:', info.reason, info.message);
    _shutdown();
  });

  // GPU 校验错误（submit/dispatch 等）不会抛 JS 异常，只走 uncapturederror
  // 事件——原先的 try/catch 抓不到这类错误。此处监听并统一致停，
  // 兑现"任何 GPU 异常停止循环"的行为约定，同时避免每帧重复报错刷屏。
  _device.addEventListener('uncapturederror', function (ev) {
    console.warn('[particles] 未捕获的 GPU 错误，粒子已停止:', ev.error);
    _shutdown();
  });

  try {
    // 异步等待期间可能发生过 resize，此处读取 canvas 的"当前"尺寸。
    W = canvas.width;
    H = canvas.height;
    _focalLength = H / (2 * Math.tan(FOV / 2));

    _context = canvas.getContext('webgpu');
    _guard(_context, '获取 webgpu 上下文失败');
    _format = navigator.gpu.getPreferredCanvasFormat();
    _context.configure({
      device: _device,
      format: _format,
      alphaMode: 'premultiplied',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
    });

    _computeUniformBuf = _device.createBuffer({
      size: 28,  // 7 个 f32
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    _renderUniformBuf = _device.createBuffer({
      size: 52,  // 13 个 f32
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const computeModule = _device.createShaderModule({ code: COMPUTE_SHADER });
    const vertexModule = _device.createShaderModule({ code: VERTEX_SHADER });
    const fragmentModule = _device.createShaderModule({ code: FRAGMENT_SHADER });

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
    _uploadFreshParticleData();
    _updateWorldSize();

    // 竞态兜底：settings.js 在模块加载时（设备就绪前）就调用了 start()，
    // 彼时 _device 为 null 会被跳过——若不在设备就绪后重启循环，帧循环
    // 永远不会开始。start() 幂等：此处已运行则 no-op，未运行则补启动。
    start();
  } catch (err) {
    console.warn('[particles] GPU 初始化失败，回退到纯 CSS 背景:', err);
    _shutdown();
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
  if (!_device) return;
  if (!_buf0 || _count <= 0) return;

  if (!_lastTime) _lastTime = timestamp;

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

    if (steps > 0 && _computePipeline && _computeBG_AB && _computeBG_BA) {
      const cp = encoder.beginComputePass();
      cp.setPipeline(_computePipeline);
      let src = _currentSrc;
      for (let s = 0; s < steps; s++) {
        cp.setBindGroup(0, src === 0 ? _computeBG_AB : _computeBG_BA);
        cp.dispatchWorkgroups(_workgroupCount);
        src = 1 - src;
      }
      cp.end();
      // 步进结束后 _currentSrc 指向"最后一次被写入的 dst 缓冲区"，
      // 即最新数据所在缓冲区——渲染即从该缓冲区读取。
      _currentSrc = src;
    }

    // 高精度时间：取模 200π，保证所有 sin 频率周期对齐，避免 f32 精度退化。
    const TIME_WRAP = 200 * Math.PI;
    _extrapData[0] = _speedFactor * (_accum / FIXED_STEP);
    _extrapData[1] = (timestamp / 1000) % TIME_WRAP;
    _queue.writeBuffer(_renderUniformBuf, 24, _extrapData);

    _colorAttachment.view = _context.getCurrentTexture().createView();
    const rp = encoder.beginRenderPass(_renderPassDescriptor);

    if (_renderPipeline && _renderBG_0 && _renderBG_1) {
      rp.setPipeline(_renderPipeline);
      rp.setBindGroup(0, _currentSrc === 0 ? _renderBG_0 : _renderBG_1);
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
  if (!_device || !_context) return;
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

/**
 * 窗口 resize 事件处理（150ms 防抖）。
 *
 * 重新计算 canvas backing store（含 devicePixelRatio），
 * 更新投影焦距并重新写入 render uniform。
 * GPU 尚未就绪时 _writeRenderUniforms 自行跳过，且 _initGPU
 * 就绪时读取的是 canvas 当前尺寸，故异步初始化期间 resize 不丢失。
 *
 * @returns {void}
 */
window.addEventListener('resize', function () {
  if (_resizeTimer !== null) clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(function () {
    _resizeTimer = null;
    const dpr = window.devicePixelRatio || 1;
    const newW = Math.max(1, Math.floor(window.innerWidth * dpr));
    const newH = Math.max(1, Math.floor(window.innerHeight * dpr));

    W = newW;
    H = newH;
    canvas.width = W;
    canvas.height = H;
    _focalLength = H / (2 * Math.tan(FOV / 2));
    _updateWorldSize();
  }, 150);
});

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
  if (_rafId !== null) return;
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
    v = Number.isFinite(x) ? Math.max(0, Math.min(MAX_COUNT, Math.floor(x))) : 500;
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

// 按屏幕物理分辨率设置 canvas backing store（多少 K 的屏就渲染多少 K）。
const dpr = window.devicePixelRatio || 1;
canvas.width = Math.max(1, Math.floor(window.innerWidth * dpr));
canvas.height = Math.max(1, Math.floor(window.innerHeight * dpr));
W = canvas.width;
H = canvas.height;
_focalLength = H / (2 * Math.tan(FOV / 2));

// 直接调用函数完成初始世界尺寸计算（函数内部会安全处理设备未就绪的情况）
_updateWorldSize();

void _initGPU();
