/**
 * @file background.js — 背景图片管理器
 *
 * 背景图片由 CSS #background 层常驻显示（index.html），
 * 浏览器合成器将透明 canvas 粒子层叠加在上层。
 *
 * 本模块仅负责 CSS background-size 切换。
 *
 * @module background
 */

/**
 * 将 Wallpaper Engine combo 值映射为 CSS background-size 值。
 *
 * @param {string} mode - Wallpaper Engine combo 值（cover / contain / auto）。
 * @returns {string} 对应的 CSS background-size 值。
 */
function toCss(mode) {
  if (mode === 'cover' || mode === 'contain') {
    return mode;
  }
  return 'auto';
}

/**
 * 设置壁纸背景的 CSS background-size 属性。
 *
 * cover   — 等比填满容器，超出部分裁剪。
 * contain — 等比完整显示，留黑边。
 * auto    — 原始尺寸，不缩放；超出视口则居中裁切（#background 声明为 no-repeat，
 *           见 index.html，因此不会平铺）。
 *
 * @param {string} mode - Wallpaper Engine combo 值（cover / contain / auto）。
 * @returns {void}
 */
export function setDisplayMode(mode) {
  const el = document.getElementById('background');
  if (el) {
    el.style.backgroundSize = toCss(mode);
  }
}
