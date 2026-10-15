// Wallpaper Engine 注入的全局接口。
//
// `wallpaperPropertyListener` 不是 Web 标准，TypeScript 的 DOM 类型库里没有它；
// 不声明的话，`js/settings.js` 里对 window 的赋值会报 TS2339，而且 TS 会连带
// 跳过那次赋值的类型检查（注解被忽略）。声明在这里之后，赋值既不再报错，也能
// 真正被检查——签名写错会立刻报错。
//
// 类型本身仍以 js/settings.js 的 JSDoc typedef 为唯一来源，这里只做引用。

import type { WPPropertyListener } from '../js/settings.js';

declare global {
  interface Window {
    /** 引擎在属性加载与变更时调用的监听器，见 `js/settings.js`。 */
    wallpaperPropertyListener: WPPropertyListener;
  }
}
