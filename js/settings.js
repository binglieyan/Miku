/**
 * @file settings.js — Wallpaper Engine 属性监听桥
 *
 * 实现 wallpaperPropertyListener 接口，
 * 监听 Wallpaper Engine 属性面板的变更并转发到各模块。
 *
 * 这是 Wallpaper Engine "web" 类型壁纸与引擎交互的唯一入口——
 * 引擎在属性变更时调用 applyUserProperties，传入变更的属性集合。
 * 模块职责：纯转发，不做业务逻辑。
 *
 * 属性列表（本模块只处理这 4 项；project.json 里的 schemecolor 由引擎 UI 使用，
 * 不经 JS）：
 *   aNumber      — 雪花数量（slider, 0–1000, 默认 500）
 *   aSpeed       — 降落速度（slider, 500–3500, 默认 2000, 越大越慢）
 *   custompink   — 使用粉色粒子（bool, 默认 false）
 *   customcombo  — 壁纸显示方式（combo: cover / contain / auto）
 *
 * @module settings
 */

import { setDisplayMode } from './background.js';
import { start, setCount, setSpeed, setPink } from './particles.js';

/* ——— Wallpaper Engine 属性监听接口 ————————— */

/**
 * Wallpaper Engine 传入的属性集合：key 为属性名，value 形如 {value: ...}。
 *
 * @typedef {Record<string, {value: *}>} WPProperties
 */

/**
 * Wallpaper Engine 属性监听器类型定义。
 *
 * @typedef {Object} WPPropertyListener
 * @property {(props: WPProperties) => void} applyUserProperties - 属性回调。
 */

/**
 * Wallpaper Engine 标准属性监听器。
 *
 * 引擎在以下时机调用 applyUserProperties：
 *   - 壁纸首次加载时（传入所有属性的当前值）
 *   - 用户在属性面板中修改任意属性时（仅传入变更的属性）
 *
 * 因此每个属性分支都需要用 if (props.xxx) 做存在性检查，
 * 未被修改的属性不会出现在 props 中。
 *
 * @type {WPPropertyListener}
 */
window.wallpaperPropertyListener = {
  /**
   * 属性变更回调（由 Wallpaper Engine 调用，IDE 不可见）。
   *
   * @param {WPProperties} props - 变更的属性集合。
   * @returns {void}
   */
  applyUserProperties(props) {
    // 引擎只会传对象；这一行避免 props 为空时整个回调抛异常，导致后面所有
    // 属性分支一起失效（各分支自身也都有类型强制，不会因取值异常抛出）。
    if (!props) {
      return;
    }

    /** 粒子数量 */
    if (props.aNumber) {
      setCount(props.aNumber.value);
    }

    /** 降落速度（越大越慢） */
    if (props.aSpeed) {
      setSpeed(props.aSpeed.value);
    }

    /** 壁纸显示模式：填充 / 等比缩放 / 原始尺寸 */
    if (props.customcombo) {
      setDisplayMode(props.customcombo.value);
    }

    /** 粒子颜色：粉色 / 白色 */
    if (props.custompink) {
      setPink(props.custompink.value);
    }
  },
};

/* ——— 启动 —————————————————————————————————— */

// 壁纸加载时申请启动。此刻设备尚未就绪（_initGPU 仍在等 requestAdapter），
// start() 是空操作；真正的启动发生在 particles.js 的初始化成功路径（那里也调
// start()，幂等），本行只表达"加载即申请启动"的意图。
start();
