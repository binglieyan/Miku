# 雪中 Miku — Wallpaper Engine 动态壁纸

> **「雪中 Miku」** 是一张 4K 分辨率的 Wallpaper Engine 网页壁纸，以冬季雪景为背景，叠加 WebGPU 驱动的粒子雪花动画，营造静谧浪漫的冬日氛围。

[![Steam 创意工坊](https://img.shields.io/badge/Steam-创意工坊-1a1a2e?logo=steam)](https://steamcommunity.com/sharedfiles/filedetails/?id=3755473060)

---

## 🎨 预览

![预览图](preview.jpg)

## 🖼️ 原画信息

- **原画师**：千夜 QYS3（[Pixiv ID: 7210261](https://www.pixiv.net/users/7210261)）
- **授权状态**：已获得原画师授权使用

---

## ✨ 特性

- **WebGPU 粒子系统** — 基于 compute shader 的 GPU 加速雪花物理模拟，支持最多 1000 个粒子同时渲染
- **时间外推渲染** — 顶点着色器内对粒子位置进行时间外推，使动画与显示器刷新率解耦，告别帧率波动带来的卡顿感
- **可调节参数** — 通过 Wallpaper Engine 属性面板实时调整粒子数量、降落速度、颜色（白/粉）和壁纸显示方式
- **CSS 图层叠加** — 背景图片由 CSS 层常驻渲染，WebGPU 透明 canvas 叠加粒子层，浏览器合成器高效合成
- **零闪烁切换** — 粒子缓冲区按最大容量预分配，调整数量时只改 uniform 与分发数量（不重建缓冲区），已有粒子保持动画状态不重置
- **4K 原生支持** — 针对高分辨率显示器优化，结合 `devicePixelRatio` 自适应画布分辨率

---

## 🎮 可调节属性

在 Wallpaper Engine 中右键壁纸 → **「壁纸」** → **「属性」** 即可调整：

| 属性         | 类型 | 范围 / 选项            | 默认值 | 说明                          |
|--------------|------|------------------------|--------|-------------------------------|
| 粒子数量     | 滑块 | 0 – 1000               | 500    | 控制粒子数量（活跃粒子总数，屏幕可见约为三成） |
| 粒子速度     | 滑块 | 500 – 3500             | 2000   | 数值越大雪花降落越慢          |
| 壁纸显示方式 | 下拉 | 填充 / 等比缩放 / 原始尺寸 | 填充   | 控制背景图片的缩放方式        |
| 使用粉色粒子 | 开关 | 开 / 关                | 关     | 开启后雪花变为粉色（#F5B3BC） |

---

## 🏗️ 技术架构

```
Miku/
├── index.html           # 入口 HTML — CSS 背景层 + WebGPU canvas 叠加
├── project.json         # Wallpaper Engine 壁纸元数据 & 属性定义
├── preview.jpg          # 创意工坊预览图
├── images/
│   └── bg.png           # 4K 背景原画
├── js/
│   ├── settings.js      # Wallpaper Engine 属性监听桥 — 引擎 ↔ JS 模块的桥梁
│   ├── particles.js     # WebGPU 粒子系统 — compute/render pipeline、缓冲区管理、帧循环
│   └── background.js    # 背景显示模式 — CSS background-size 切换
└── CLAUDE.md            # 项目开发文档（面向 AI 辅助开发）
```

### 数据流

```
Wallpaper Engine 属性面板
        │
        ▼
window.wallpaperPropertyListener.applyUserProperties(props)
        │
        ├──→ particles.setCount(n)       → GPU uniform 更新
        ├──→ particles.setSpeed(s)       → GPU uniform 更新
        ├──→ particles.setPink(bool)     → GPU uniform 更新
        └──→ background.setDisplayMode() → CSS background-size 更新
```

### WebGPU 粒子系统设计

```
Compute Pass（ping-pong，按固定步长 1/60s 循环）
├─ buf0 ──→ compute shader ──→ buf1    物理步进 + 边界环绕
├─ buf1 ──→ compute shader ──→ buf0    ping-pong 交替
│
Render Pass（每帧）
├─ 顶点着色器：实例化 billboard + 时间外推
├─ 片元着色器：径向渐变圆（smoothstep 衰减）
└─ 混合模式：premultiplied alpha
```

- **缓冲区策略**：两个存储缓冲区按 `MAX_COUNT = 1000` 预分配，ping-pong 交替读写；活跃粒子数由 uniform 控制，调整时无缓冲区重建
- **固定步长物理**：物理模拟以 60fps 固定步长推进，不受显示器刷新率影响
- **时间外推**：渲染时根据累加器余量外推粒子位置，消除物理步进与显示帧之间的时间差

---

## 🚀 开发

### 环境要求

- [pnpm](https://pnpm.io/) 包管理器

### 安装依赖

```bash
pnpm install
```

### 代码检查 & 格式化

```bash
pnpm lint          # 运行 oxlint + eslint（自动修复）
pnpm lint:oxlint   # 仅 oxlint（快速 Rust linter）
pnpm lint:eslint   # 仅 eslint
pnpm format        # oxfmt 代码格式化
```

### 开发流程

本项目为 **纯静态网页**（零构建步骤），所有代码均为浏览器原生 ES 模块，无需编译即可直接在 Wallpaper Engine 中加载：

1. 在 Wallpaper Engine 中创建一张 **「网页」** 类型壁纸
2. 将 `index.html` 的本地路径填入 Web URL
3. 修改 JS 文件后刷新壁纸即可看到效果

> **提示**：`jsconfig.json` 已配置 `@webgpu/types`，在 VS Code 等 IDE 中可获得 WebGPU API 的自动补全和类型提示。

---

## 📦 技术栈

| 技术            | 用途                                                           |
|-----------------|----------------------------------------------------------------|
| WebGPU (WGSL)   | GPU 计算与渲染 — compute shader 物理模拟 + instanced rendering |
| CSS Background  | 背景图片图层，浏览器原生合成                                   |
| ES Modules      | 模块化 JS（零打包、零转译）                                    |
| oxlint + eslint | 静态分析与代码规范                                             |
| oxfmt           | 代码格式化                                                     |

---

## 📄 许可

本项目的**源代码**采用 [MIT 许可证](LICENSE) 开源。

**第三方美术素材不在该许可范围内**：`images/bg.png` 与 `preview.jpg` 是原画师 **千夜 QYS3**（Pixiv ID 7210261）的作品，已获授权在本壁纸项目中使用；它们不属于 MIT 许可所定义的 Software，不得单独提取、二次分发或用于其它项目。这一范围说明写在 [LICENSE](LICENSE) 正文之后的「License scope」一节。

---

## 🔗 相关链接

- [Steam 创意工坊](https://steamcommunity.com/sharedfiles/filedetails/?id=3755473060)
- [Wallpaper Engine](https://www.wallpaperengine.io/)
- [WebGPU 规范](https://www.w3.org/TR/webgpu/)
- [WGSL 规范](https://www.w3.org/TR/WGSL/)
