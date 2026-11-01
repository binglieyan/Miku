/**
 * @file datetime.js — 右下角日期时间显示
 *
 * 纯展示模块：读取本地系统时间，渲染到 index.html 的 #datetime。
 * 由 settings.js 入口调用 start() 启动，属性通过 settings.js 转发到 setter。
 *
 * 显示语言优先看 Intl/navigator 的 zh-*；CEF 强制英文时用系统时区兜底，
 * 中国 / 香港 / 澳门 / 台湾时区按中文，其余英文。
 * 12/24 小时制由 customtimeformat 属性独立控制，与语言无关；
 * customdatetime 控制整层显隐，隐藏时停掉刷新定时器。
 *
 * 日期/时间文本由纯函数 formatClock() 生成，render() 只负责写 DOM；
 * 日期文本按天缓存，避免每秒重复写日期行。
 *
 * 刷新按整秒边界对齐：每次 setTimeout 到下一个整秒，而不是固定 setInterval，
 * 避免长时间运行后的相位漂移；页面重新可见时立即刷新并重新对齐。
 *
 * 缺少 DOM 时只警告，不抛异常：它是 settings.js 的依赖，抛异常会连带打死
 * 属性桥。
 *
 * @module datetime
 */

/* ————————————————————————————————————————————
 *  DOM 引用
 * ———————————————————————————————————————————— */

const root = document.getElementById('datetime');
const dateEl = document.getElementById('datetime-date');
const timeEl = document.getElementById('datetime-time');

if (!root || !dateEl || !timeEl) {
  console.warn('[datetime] 未找到 #datetime，日期时间层已禁用');
}

/* ————————————————————————————————————————————
 *  格式配置
 * ———————————————————————————————————————————— */

/** @type {string[]} 中文星期短名，索引与 Date#getDay 对齐。 */
const ZH_WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** @type {string[]} 英文星期全名，索引与 Date#getDay 对齐。 */
const EN_WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/** @type {string[]} 英文月份短名，索引与 Date#getMonth 对齐。 */
const EN_MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * CEF 经常把浏览器语言强制成 en-US；这些系统时区仍按中文区域处理。
 *
 * @type {Set<string>}
 */
const ZH_TIMEZONES = new Set([
  'Asia/Shanghai',
  'Asia/Chongqing',
  'Asia/Harbin',
  'Asia/Urumqi',
  'Asia/Kashgar',
  'Asia/Hong_Kong',
  'Asia/Macau',
  'Asia/Taipei',
]);

/* ————————————————————————————————————————————
 *  状态
 * ———————————————————————————————————————————— */

/**
 * 本地调试用：?time=12 强制 12 小时制；引擎属性会覆盖它。
 *
 * @type {boolean}
 */
const DEV_HOUR12 = new URLSearchParams(location.search).get('time') === '12';

/** @type {number} 下一次刷新的 setTimeout 句柄；0 表示未排程。 */
let _timer = 0;

/** @type {boolean} start() 是否已经执行过。 */
let _started = false;

/** @type {boolean} 日期时间层是否显示；由 customdatetime 控制。 */
let _visible = true;

/** @type {boolean} 12 小时制开关；默认 24 小时制。 */
let _hour12 = DEV_HOUR12;

/** @type {number} 水平偏移（-100..100，正数向右）；默认 100 = 右边缘。 */
let _offsetX = 100;

/** @type {number} 垂直偏移（-100..100，正数向下）；默认 95 = 右下角。 */
let _offsetY = 95;

/** @type {string} 最近一次写入 DOM 的日期文本，避免每秒重复写日期。 */
let _lastDate = '';

/* ————————————————————————————————————————————
 *  内部实现
 * ———————————————————————————————————————————— */

/**
 * 补零到两位。
 *
 * @param {number} n - 非负整数。
 * @returns {string} 两位字符串。
 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 中文日期：2026年11月1日 周日。
 *
 * @param {Date} now - 当前时间。
 * @returns {string} 日期文本。
 */
function formatZhDate(now) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  return `${y}年${m}月${d}日 ${ZH_WEEKDAYS[now.getDay()]}`;
}

/**
 * 中文时间：24 小时制 HH:mm:ss，或 12 小时制 上午/下午 h:mm:ss。
 *
 * @param {Date} now - 当前时间。
 * @param {boolean} hour12 - 是否使用 12 小时制。
 * @returns {string} 时间文本。
 */
function formatZhTime(now, hour12) {
  const h = now.getHours();
  const mm = pad2(now.getMinutes());
  const ss = pad2(now.getSeconds());

  if (!hour12) {
    return `${pad2(h)}:${mm}:${ss}`;
  }

  const suffix = h < 12 ? '上午' : '下午';
  return `${suffix} ${h % 12 || 12}:${mm}:${ss}`;
}

/**
 * 英文日期：Sunday Nov 1 2026。
 *
 * @param {Date} now - 当前时间。
 * @returns {string} 日期文本。
 */
function formatEnDate(now) {
  const weekday = EN_WEEKDAYS[now.getDay()];
  const month = EN_MONTHS_SHORT[now.getMonth()];
  return `${weekday} ${month} ${now.getDate()} ${now.getFullYear()}`;
}

/**
 * 英文时间：24 小时制 HH:mm:ss，或 12 小时制 h:mm:ss AM/PM。
 *
 * @param {Date} now - 当前时间。
 * @param {boolean} hour12 - 是否使用 12 小时制。
 * @returns {string} 时间文本。
 */
function formatEnTime(now, hour12) {
  const h = now.getHours();
  const mm = pad2(now.getMinutes());
  const ss = pad2(now.getSeconds());

  if (!hour12) {
    return `${pad2(h)}:${mm}:${ss}`;
  }

  const suffix = h < 12 ? 'AM' : 'PM';
  return `${h % 12 || 12}:${mm}:${ss} ${suffix}`;
}

/**
 * @typedef {Object} ClockLocale
 * @property {(now: Date) => string} formatDate - 日期格式化函数。
 * @property {(now: Date, hour12: boolean) => string} formatTime - 时间格式化函数。
 */

/** @type {Record<'zh'|'en', ClockLocale>} */
const LOCALES = {
  zh: { formatDate: formatZhDate, formatTime: formatZhTime },
  en: { formatDate: formatEnDate, formatTime: formatEnTime },
};

/**
 * 是否是中文语言标签。
 *
 * @param {string} tag - BCP 47 语言标签。
 * @returns {boolean} 是否 zh / zh-*。
 */
function isZhTag(tag) {
  return /^zh(?:[-_]|$)/i.test(tag);
}

/**
 * 是否是英文语言标签。
 *
 * @param {string} tag - BCP 47 语言标签。
 * @returns {boolean} 是否 en / en-*。
 */
function isEnTag(tag) {
  return /^en(?:[-_]|$)/i.test(tag);
}

/**
 * 先看 Intl/navigator 语言；CEF 常把两者都固定成 en-US，所以两者都是英文时，
 * 再用系统时区兜底：中国 / 香港 / 澳门 / 台湾时区按中文处理，其余英文。
 * 其他非英文语言（ja、fr 等）不会因时区被判成中文。
 *
 * @returns {'zh'|'en'} 显示语言。
 */
function detectLocale() {
  const intl = Intl.DateTimeFormat().resolvedOptions();
  const languages = navigator.languages;
  const navTag = (languages && languages[0]) || navigator.language || '';
  const intlTag = intl.locale || '';

  if (isZhTag(intlTag) || isZhTag(navTag)) {
    return 'zh';
  }

  const englishOnly = isEnTag(navTag || intlTag) || !navTag;
  if (englishOnly && ZH_TIMEZONES.has(intl.timeZone)) {
    return 'zh';
  }

  return 'en';
}

/** @type {ClockLocale} 当前语言对应的格式器。 */
const _locale = LOCALES[detectLocale()];

/**
 * @typedef {Object} ClockText
 * @property {string} date - 日期文本。
 * @property {string} time - 时间文本。
 */

/**
 * 把 Date 格式化为日期和时间文本（纯函数，不读写 DOM）。
 *
 * @param {Date} now - 当前时间。
 * @returns {ClockText} 日期与时间文本。
 */
export function formatClock(now) {
  return {
    date: _locale.formatDate(now),
    time: _locale.formatTime(now, _hour12),
  };
}

/**
 * 设置 12/24 小时制（由 Wallpaper Engine 的 customtimeformat 调用）。
 *
 * @param {string|number|boolean} value - 12/24，或布尔值。
 * @returns {void}
 */
export function setTimeFormat(value) {
  const next = value === '12' || value === 12 || value === true;
  if (next === _hour12) {
    return;
  }

  _hour12 = next;
  if (_started && _visible) {
    render(new Date());
  }
}

/**
 * 把任意输入钳制到 -100..100。
 *
 * @param {*} value - 属性值。
 * @returns {number} 偏移量。
 */
function clampOffset(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.max(-100, Math.min(100, n));
}

/**
 * 把 -100..100 映射到 0..100%：
 * 0 是屏幕中心，-100 让左/上边缘贴住活动区，100 让右/下边缘贴住活动区。
 *
 * @returns {void}
 */
function applyPosition() {
  if (!root) {
    return;
  }

  const x = (_offsetX + 100) / 2;
  const y = (_offsetY + 100) / 2;
  root.style.left = `${x}%`;
  root.style.top = `${y}%`;
  root.style.transform = `translate(-${x}%, -${y}%)`;
}

/**
 * 设置水平偏移；负数向左，正数向右。
 *
 * @param {*} value - -100..100。
 * @returns {void}
 */
export function setOffsetX(value) {
  _offsetX = clampOffset(value);
  applyPosition();
}

/**
 * 设置垂直偏移；正数向下，负数向上。
 *
 * @param {*} value - -100..100。
 * @returns {void}
 */
export function setOffsetY(value) {
  _offsetY = clampOffset(value);
  applyPosition();
}

/**
 * 显示 / 隐藏日期时间层（由 customdatetime 控制）。
 *
 * @param {boolean} value - true 显示，false 隐藏。
 * @returns {void}
 */
export function setVisible(value) {
  const next = value !== false;
  if (next === _visible) {
    return;
  }

  _visible = next;
  if (root) {
    root.hidden = !_visible;
  }

  if (!_started) {
    return;
  }

  if (_visible) {
    resync();
  } else {
    clearTimeout(_timer);
    _timer = 0;
  }
}

/**
 * 把当前时间写入 DOM。
 *
 * @param {Date} now - 当前时间。
 * @returns {void}
 */
function render(now) {
  if (!dateEl || !timeEl) {
    return;
  }

  const { date, time } = formatClock(now);
  if (date !== _lastDate) {
    dateEl.textContent = date;
    _lastDate = date;
  }
  timeEl.textContent = time;
}

/**
 * 渲染一次，并把下一次刷新排到下一个整秒。
 *
 * @returns {void}
 */
function tick() {
  if (!_visible || !dateEl || !timeEl) {
    return;
  }

  const now = new Date();
  render(now);
  _timer = setTimeout(tick, 1000 - now.getMilliseconds());
}

/**
 * 页面重新可见时立即刷新，并重新对齐到整秒。
 *
 * @returns {void}
 */
function resync() {
  if (document.hidden || !_visible || !dateEl || !timeEl) {
    return;
  }

  clearTimeout(_timer);
  tick();
}

/* ————————————————————————————————————————————
 *  对外接口
 * ———————————————————————————————————————————— */

/**
 * 启动日期时间刷新（幂等）。
 *
 * @returns {void}
 */
export function start() {
  if (_started) {
    return;
  }
  if (!root || !dateEl || !timeEl) {
    return;
  }

  _started = true;
  document.addEventListener('visibilitychange', resync);
  if (_visible) {
    tick();
  }
}
