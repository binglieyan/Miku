/**
 * @file audio.js — 背景音乐播放器
 *
 * **发行包不含任何音频文件。** 音源路径是硬编码的：`index.html` 里的
 * `<audio id="bgm" src="music/bgm.flac">`。用户自行把音频放进 `music/` 并
 * 命名成 `bgm.flac` 即可，操作步骤见 `music/README.md`。
 *
 * 本模块只负责播放策略，不碰音源本身：
 *
 *   - **循环**：由 `<audio loop>` 交给浏览器，模块不干预；
 *   - **自动播放容错**：Wallpaper Engine 的 CEF 放行壁纸自动播放；普通浏览器
 *     预览可能按 Chromium 策略拒绝 `play()`。被拦时不弹提示、不抛异常，
 *     改为静默退避重试（1s → 30s 封顶），并在壁纸页面收到用户交互、窗口
 *     重新聚焦 / 重新可见时再试一次（属性面板点击不算页面手势）。
 *     壁纸上不该出现"点击播放"的提示，所以全程无声失败；
 *   - **淡入淡出**：开 / 关音乐时对 volume 做短斜坡，避免"啪"地切入或切断。
 *
 * 没有音频文件是**预期状态**，不是故障：`error` 事件后停止重试、只提示一次，
 * 壁纸其余部分照常运行。
 *
 * 为了让"没放音乐"这件事在控制台里也安静，两处配合：`<audio preload="none">`
 * 让浏览器不在解析 HTML 时就去抓文件，本模块的开关默认关闭、打开后才第一次
 * `play()`。否则浏览器会固定打一条 `404 / ERR_FILE_NOT_FOUND`，那行由网络层
 * 打印，JS 拦不掉也改写不了。
 *
 * 与 particles.js 一样，缺少 `<audio>` 时模块**必须能成功求值**：它是入口
 * settings.js 的依赖，抛异常会连带打死属性桥。
 *
 * 属性（project.json）：
 *   custommusic  — 背景音乐开关（bool, 默认 false）
 *   customvolume — 音量（slider, 0–100, 默认 35）
 *
 * @module audio
 */

/* ————————————————————————————————————————————
 *  DOM 引用
 * ———————————————————————————————————————————— */

/** @type {?HTMLAudioElement} */
const audio = /** @type {?HTMLAudioElement} */ (document.getElementById('bgm'));

if (!audio) {
  console.warn('[audio] 未找到 #bgm，背景音乐已禁用（不影响其它层）');
}

/* ——— 参数 ————————————————————————————————— */

/** 淡入 / 淡出总时长（ms）：开关音乐用，长到不打断情绪。 */
const FADE_MS = 1200;

/** 音量跟随时长（ms）：拖属性面板的音量滑块时用——短到跟手，长到不爆音。 */
const VOLUME_MS = 140;

/** 斜坡步进（ms）：约一帧 60Hz；音频 quantum 更小，但这个台阶已不可闻。 */
const FADE_STEP_MS = 16;

/** 淡入淡出的动态范围（dB）：0 音量按这个下限参与插值，避免 log(0)。 */
const FADE_FLOOR_DB = -60;

/** 自动播放被拦截后的重试退避：起点、上限（ms）。 */
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30000;

/**
 * 本地调试用：直接用浏览器打开 index.html 时没有引擎回传属性，音乐开关会一直
 * 是关的、听不到效果。加 `?bgm=on` 手动开启。
 */
const DEV_AUTOPLAY = new URLSearchParams(location.search).get('bgm') === 'on';

/* ——— 状态 ————————————————————————————————— */

/** 目标音量 0–1（由 customvolume 的 0–100 换算而来）。 */
let _volume = 0.35;

/**
 * 用户是否希望播放；false 时所有重试直接让路，不再消耗定时器。
 *
 * **默认关闭。** 发行包里没有音频文件，默认就尝试播放的话，`play()` 会立刻
 * 触发一次加载，而浏览器网络层会把"文件不存在"打成一条
 * `Failed to load resource: 404` —— 这条日志由 Chromium 自己打印，JS 既拦不住
 * 也改写不了。对没放音乐的人，它就是纯噪音。所以改成等属性面板把开关打开，
 * 才第一次发起请求；那时文件是否存在已经是用户自己的选择。
 */
let _enabled = DEV_AUTOPLAY;

/** 音量斜坡定时器 / 重试定时器（0 表示未排程）。 */
let _rampTimer = 0;
let _retryTimer = 0;

/** 当前重试间隔，成功后复位。 */
let _retryDelay = RETRY_MIN_MS;

/** 音频文件本身不可用（缺失 / 解码失败）；此时重试没有意义。 */
let _unavailable = false;

/**
 * 关闭状态下先把音量压到 0：避免页面加载时从 `HTMLMediaElement` 默认的
 * `volume = 1` 起一条没有意义的 fade-out，也减少旧 ramp 与 `play()` 的竞态窗口。
 */
if (audio && !_enabled) {
  audio.volume = 0;
}

/* ——— 内部实现 ————————————————————————————— */

/**
 * 把音量钳制到 0–1。
 *
 * @param {number} v - 任意音量值。
 * @returns {number} 合法音量。
 */
function clampVolume(v) {
  return Math.min(1, Math.max(0, v));
}

/**
 * 音量 → 分贝：0 音量钳到 FADE_FLOOR_DB（log(0) 无定义）。
 *
 * @param {number} v - 音量 0–1。
 * @returns {number} 分贝值。
 */
function volumeToDb(v) {
  return v > 0 ? 20 * Math.log10(v) : FADE_FLOOR_DB;
}

/**
 * 分贝 → 音量。
 *
 * @param {number} db - 分贝值。
 * @returns {number} 音量 0–1（可能略小于 1，调用方自行钳制）。
 */
function volumeFromDb(db) {
  return 10 ** (db / 20);
}

/**
 * 把音量斜坡到目标值。
 *
 * 插值在**分贝域**做，而不是线性插值幅度：人耳对响度的感知近似对数，线性
 * amplitude 斜坡的听感是"前快后慢"——走完一半时间就已经到 -6 dB（听起来接近
 * 满音量），后一半时间只是在补最后那 6 dB。按 dB 等速推进才是均匀的呼吸感。
 *
 * 进度按 `performance.now()` 的真实时间来算，而不是"每次 tick 加一格"：
 * 定时器会漂移，页面进入后台时更会被节流到每秒一次——按步数走的斜坡在那种
 * 情况下会把 1.2s 的淡入拖成几十秒。按时间算则只是台阶变粗，时长不变。
 *
 * 斜坡用 setInterval 而非 rAF：壁纸窗口失焦时 rAF 会被直接停掉，音量会卡在
 * 斜坡中途（听感上等于"开了没声"）。
 *
 * @param {number} target - 目标音量 0–1。
 * @param {number} ms - 斜坡时长。
 * @param {() => void} [onDone] - 斜坡走完后的回调。
 * @returns {void}
 */
function rampTo(target, ms, onDone) {
  if (!audio) {
    return;
  }

  clearInterval(_rampTimer);
  _rampTimer = 0;

  const to = clampVolume(target);
  const fromDb = volumeToDb(audio.volume);
  const toDb = volumeToDb(to);

  // 同值时没必要跑一条空斜坡；0→0 还会在过程中写入 0.001（-60 dB），
  // 到最后一步才归 0。直接写精确目标并完成。
  if (fromDb === toDb) {
    audio.volume = to;
    if (onDone) {
      onDone();
    }
    return;
  }

  const startedAt = performance.now();
  const duration = Math.max(1, ms);

  _rampTimer = setInterval(() => {
    const ratio = Math.min(1, (performance.now() - startedAt) / duration);
    if (ratio >= 1) {
      // 末步直接写成精确目标值，不留 dB↔线性往返的尾差。
      audio.volume = to;
      clearInterval(_rampTimer);
      _rampTimer = 0;
      if (onDone) {
        onDone();
      }
      return;
    }
    audio.volume = clampVolume(volumeFromDb(fromDb + (toDb - fromDb) * ratio));
  }, FADE_STEP_MS);
}

/**
 * 排下一次重试（指数退避到 RETRY_MAX_MS）。
 *
 * @returns {void}
 */
function scheduleRetry() {
  if (!_enabled || _unavailable || _retryTimer) {
    return;
  }

  const delay = _retryDelay;
  _retryTimer = setTimeout(() => {
    _retryTimer = 0;
    play();
  }, delay);
  _retryDelay = Math.min(_retryDelay * 2, RETRY_MAX_MS);
}

/**
 * 尝试开始播放；被自动播放策略拦下时进入静默退避重试。
 *
 * @returns {void}
 */
function play() {
  // 任何一次显式播放都取消旧的退避计时器；否则成功播放后还会多一次空 timer。
  clearTimeout(_retryTimer);
  _retryTimer = 0;

  if (!audio || !_enabled || _unavailable || !audio.paused) {
    return;
  }

  // 开始播放前取消可能仍在进行的旧淡入/淡出：典型场景是页面加载时
  // setMusicEnabled(false) 起了一条 1→0 的 fade，用户在它结束前打开音乐。
  // 不清掉的话，旧 interval 会在 play() pending 期间继续改 volume。
  clearInterval(_rampTimer);
  _rampTimer = 0;

  // 从 0 起淡入：即使被策略拦下，音量也停在 0，下一次重试没有副作用。
  audio.volume = 0;

  const started = audio.play();
  if (!started || typeof started.then !== 'function') {
    rampTo(_volume, FADE_MS);
    return;
  }

  started.then(
    () => {
      // play() 可能在用户关闭音乐之后才 resolve：此时不能再淡入，否则会
      // 取消 setMusicEnabled(false) 正在进行的 fade-out，甚至跳过 pause。
      if (!_enabled || _unavailable) {
        return;
      }
      _retryDelay = RETRY_MIN_MS;
      rampTo(_volume, FADE_MS);
    },
    () => {
      // 被策略拦截：不打印、不弹窗，退避后重试。
      scheduleRetry();
    },
  );
}

/**
 * 立即重试一次（用户交互 / 窗口重新可见、聚焦时调用）。
 *
 * 交互是最可靠的一次机会，所以这里顺手清掉退避定时器并复位间隔——
 * 否则可能白等最多 30s 才出声。
 *
 * @returns {void}
 */
function resume() {
  if (!audio || !_enabled || _unavailable || !audio.paused) {
    return;
  }

  clearTimeout(_retryTimer);
  _retryTimer = 0;
  _retryDelay = RETRY_MIN_MS;
  play();
}

/* ——— 事件绑定 ————————————————————————————— */

if (audio) {
  // 文件缺失 / 解码失败：没有可播内容，停掉所有重试（否则每 30s 刷一条控制台）。
  audio.addEventListener('error', () => {
    if (_unavailable) {
      return;
    }
    _unavailable = true;
    clearTimeout(_retryTimer);
    _retryTimer = 0;
    clearInterval(_rampTimer);
    _rampTimer = 0;
    audio.pause();

    const code = audio.error ? audio.error.code : 0;
    const src = audio.getAttribute('src') || 'music/bgm.flac';
    const reasons = [
      '未知错误',
      '加载被中止',
      '文件读取/网络错误',
      '音频解码失败（例如 32-bit float FLAC）',
      '文件不存在或格式不支持',
    ];
    const reason = reasons[code] || '未知错误';

    // 浏览器自己会先打一条 `Failed to load resource: 404` / `ERR_FILE_NOT_FOUND`，
    // 那条改不掉也拦不住，所以这里紧接着把"该怎么做"讲清楚，让它不至于像报错。
    console.info(
      [
        `[audio] 音频加载失败（MediaError ${code}：${reason}）：${src}`,
        '        安静运行中，壁纸其它功能不受影响。',
        '        要加音乐：把 .flac 文件放进 music/ 并改名成 bgm.flac，然后重新加载壁纸。',
        '        步骤见 music/README.md，或创意工坊页面上的说明。',
      ].join('\n'),
    );
  });

  // 任意一次用户交互都是重开播放的机会。
  for (const type of ['pointerdown', 'keydown', 'touchstart']) {
    document.addEventListener(type, resume, { passive: true });
  }

  window.addEventListener('focus', resume);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      resume();
    }
  });
}

/* ——— 对外接口 ————————————————————————————— */

/**
 * 开关背景音乐：开启时淡入播放，关闭时先淡出再暂停。
 *
 * @param {boolean} enabled - 是否播放背景音乐。
 * @returns {void}
 */
export function setMusicEnabled(enabled) {
  _enabled = Boolean(enabled);
  if (!audio) {
    return;
  }

  if (_enabled) {
    _retryDelay = RETRY_MIN_MS;
    clearTimeout(_retryTimer);
    _retryTimer = 0;

    // 上次 error 后用户重新打开：无论此刻 paused 是什么状态，都先给文件
    // 一次重新加载的机会，再决定 play 还是把淡出中的音量拉回去。
    if (_unavailable) {
      _unavailable = false;
      audio.load(); // 重置媒体管线，重新走一遍加载
    }

    if (audio.paused) {
      // 上一次可能因为文件不存在失败过。用户重新打开开关时给文件一次机会：
      // 也许他刚把 bgm.flac 放进去，不必为此重启整个壁纸。
      play();
    } else {
      // 已经出声（例如关闭后又迅速打开）：把淡出中被打断的音量拉回去。
      rampTo(_volume, FADE_MS);
    }
    return;
  }

  clearTimeout(_retryTimer);
  _retryTimer = 0;
  // 先淡出再暂停，直接 pause 会听出一个断口；回调里再查一次 _enabled，
  // 以免淡出期间用户又打开了音乐却被这里补上一记 pause。
  rampTo(0, FADE_MS, () => {
    if (!_enabled) {
      audio.pause();
    }
  });
}

/**
 * 设置音量。
 *
 * 播放中即时跟随（VOLUME_MS 的短斜坡）；暂停中只记录，下次淡入时使用。
 *
 * 这里**不能**用 FADE_MS：属性面板的滑块拖动时会连续发来一串值，每个值都排
 * 一条 1.2s 的斜坡，声音会永远落后滑块一截，松手后还要再追 1 秒多才到位。
 *
 * @param {number} level - 音量 0–100（Wallpaper Engine slider 值）。
 * @returns {void}
 */
export function setVolume(level) {
  if (level == null) {
    return;
  }
  const n = Number(level);
  if (!Number.isFinite(n)) {
    return;
  }

  _volume = clampVolume(n / 100);

  if (audio && _enabled && !audio.paused) {
    rampTo(_volume, VOLUME_MS);
  }
}

/**
 * 启动背景音乐（幂等）。
 *
 * @returns {void}
 */
export function start() {
  if (!audio) {
    return;
  }

  audio.loop = true;
  play();
}
