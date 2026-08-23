# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Wallpaper Engine "web" type wallpaper — a 4K Miku snow-scene wallpaper. The background image (`images/bg.png`) is rendered as a CSS `background` layer, and a transparent WebGPU canvas overlays animated particle snow on top via browser compositing.

## Development commands

```bash
pnpm lint          # Run both oxlint + eslint (with auto-fix)
pnpm lint:oxlint   # oxlint only (fast Rust linter)
pnpm lint:eslint   # eslint only (JS rules + Prettier skip)
pnpm format        # oxfmt formatter (targets js/)
```

**No build step** — this is vanilla JS (ES modules) served directly to the browser. Wallpaper Engine loads `index.html` as specified in `project.json`.

**No test suite** — testing is done by loading the wallpaper in Wallpaper Engine: create a "Web"-type wallpaper, set its URL to the local `index.html` path (`file:///...`), then refresh the wallpaper after JS edits (see README §开发流程).

pnpm pinned via `packageManager` (`pnpm@11.22.0`).

## Architecture

Three JS modules loaded from `index.html` via a single `<script type="module" src="js/settings.js">` entry point:

| Module             | Responsibility                                                                                                                                                                                                                                                                                                                                  |
|--------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `js/settings.js`   | Wallpaper Engine property listener bridge. Implements `window.wallpaperPropertyListener.applyUserProperties` — the sole interface between the engine and the wallpaper. Pure forwarding; no business logic.                                                                                                                                     |
| `js/background.js` | CSS `background-size` switching for the `#background` div. Exports `setDisplayMode(mode)` where mode is `cover`/`contain`/`auto`.                                                                                                                                                                                                               |
| `js/particles.js`  | WebGPU particle system. Compute shader steps particle physics (position + boundary wrapping), vertex shader does instanced billboard quads with temporal extrapolation + render-only turbulence/wind trajectory enhancement, fragment shader renders radial-gradient circles. Exports `start()`, `setCount(n)`, `setSpeed(s)`, `setPink(bool)`. |

**Data flow:** Wallpaper Engine → `wallpaperPropertyListener.applyUserProperties(props)` → per-property branches call into `particles.js` or `background.js` → GPU buffers / CSS updated.

## Wallpaper Engine integration

The `project.json` defines the wallpaper metadata and user-adjustable properties. The `type: "Web"` field signals this is a web wallpaper — Wallpaper Engine embeds it as a browser view and calls `applyUserProperties` on the global listener. The wallpaper is published to the Steam Workshop (id 3755473060).

**Properties** (defined in `project.json` → `general.properties`):

| Key           | Type   | Range/Options          | Default | Effect in `js/settings.js`                                          |
|---------------|--------|------------------------|---------|---------------------------------------------------------------------|
| `aNumber`     | slider | 0–1000                 | 500     | → `particles.setCount(n)`                                           |
| `aSpeed`      | slider | 500–3500               | 2000    | → `particles.setSpeed(s)` (larger = slower; `speedFactor = 1500/s`) |
| `customcombo` | combo  | cover / contain / auto | cover   | → `background.setDisplayMode(m)`                                    |
| `custompink`  | bool   | —                      | false   | → `particles.setPink(b)`                                            |

`general.properties.schemecolor` is an engine-UI scheme color (order 0) — not handled in JS.

## WebGPU particle system design

**Buffer strategy:** Two storage buffers (`_buf0`, `_buf1`) allocated once at `MAX_COUNT = 6000`. Active particle count is a uniform — `setCount()` only updates the uniform and workgroup dispatch count; buffers are never resized on count changes, avoiding GPU allocation jitter and particle-state resets; `setCount(0)` stops the rAF loop, clears the canvas of frozen particles (one no-draw render pass), and positive values restart it.

**Compute pass:** Ping-pong dispatch — `_currentSrc` toggles each step. Each thread processes one particle (position += velocity × speedFactor, boundary wrapping). `_workgroupCount = ceil(count / 64)`.

**Render pass:** Instanced draw (4 vertices × `_count` instances, `triangle-strip`). Vertex shader does perspective projection + temporal extrapolation (positions advanced by `extrapFactor = speedFactor × (accumulator / FIXED_STEP)`), then applies render-only trajectory enhancement (per-particle turbulence sway using phase/amplitude stored in the struct's `_p0`/`_p1` fields, spatial wind field, ~35s gust pulse, depth wind; near particles scaled down via `nearScale`). Screen radius is capped at `MAX_SR` (48 px) and particles fade out below `NEAR_DIST` (35 world units) to prevent near-camera fill-rate spikes; a symmetric far fade (from `cameraZ + 1000` to `cameraZ − zMin`, the box's far z-boundary — `zMin` is inset by the max render-only wind sway (~110 world units) so a wrap's wind-displaced render position can never land on-screen; computed from the physics depth `cameraZ - p.posZ` so the render-only wind can't make opacity "breathe") makes all boundary wraps happen at fully transparent depths — no far particles popping in/out of thin air, no far-edge flash; particles whose physics depth is behind the camera are hard-gated to invisible (the wind could otherwise push the wrap's landing position in front of the lens and flash at gust peaks); particles whose physics position is outside the frustum's lateral extent fade by their overshoot (fade band = max wind sway) so the wind can never pull an off-frustum particle onto the screen (no edge flash); fully faded / behind-camera particles collapse to zero-area quads (no fragment cost). Fragment shader outputs premultiplied alpha (blend srcFactor `one`) and draws radial-gradient circles (`premultiplied` alpha mode on the canvas context). Per-frame JS is allocation-free except WebGPU-mandated objects: `_renderPassDescriptor` is a preallocated template and `_colorAttachment` (a cached alias of its `colorAttachments[0]`) is the only per-frame mutation — a V8-style micro-optimization; keep the alias rather than inlining the lookup chain.

**3D world:** Box world with dynamic per-axis bounds computed by `_updateWorldSize()` on load and after each resize. x half-width (`WORLD_HALF`) comes from the far-plane frustum extent at `MAX_DIST` (= `CAMERA_Z + 1000`): `halfH = tan(FOV/2) × MAX_DIST`, `halfW = halfH × aspect`, `WORLD_HALF = max(ceil(max(halfW, halfH) × 1.1), 2000)`. y half-height (`Y_HALF`) is the frustum half-height at the far-fade end × 1.1, and z spans `[CAMERA_Z − farFadeEnd, CAMERA_Z + 1]` — the visible depth band plus a 1-unit wrap destination behind the camera. The `MAX_COUNT`/default-count budget (1000 / 500) maps to ~300 / ~150 flakes on screen on 16:9. Keeping y/z tight (instead of a full cube) stops most of the budget from idling behind the camera or beyond the far plane: ~30% of particles are on-screen at any moment on 16:9 (vs ~7% for a cube; the geometric ceiling for uniform spawn in a box enclosing the frustum is 1/3). Boundary wrapping (compute physics + vertex-shader extrapolation, same per-axis bounds: `worldHalf`/`worldSize` for x, `yHalf` for y, `zMin`/`zMax` for z) always lands off-screen or fully faded. Initial positions spawn uniformly over the box.

**Resize:** Debounced (150ms) listener on `window.resize` that recalculates canvas backing store (accounting for `devicePixelRatio`), updates `focalLength`, and reruns `_updateWorldSize()`.

**Failure handling:** Device loss (`.lost`), GPU validation errors (`uncapturederror` — these never throw JS exceptions), and in-frame sync errors all funnel into `_shutdown()`, which nulls `_device`/`_queue` and truly stops the rAF loop (frameLoop only requests the next frame while `_rafId` is non-null); the CSS background layer keeps rendering. `_initGPU` calls `start()` at the end of its success path to cover the race where the engine calls `start()` before the device is ready (start() is gated on `_device`).

**Device init:** `_initGPU` calls `requestAdapter()` without `powerPreference` — Chromium on Windows ignores that option (crbug.com/369219127) and logs a warning; on dual-GPU machines the GPU is chosen by the OS (Windows Settings → System → Display → Graphics for wallpaper32.exe / webwallpaper32.exe).

## Linting & formatting configuration

- **oxlint** (`.oxlintrc.json`): `correctness` category at error level, plugins: `eslint`, `unicorn`, `oxc`. Browser env.
- **eslint** (`eslint.config.js`): Extends `@eslint/js` recommended, `eslint-config-prettier` (formatting rules skipped), oxlint plugin for compatibility. Browser globals.
- **oxfmt** (`.oxfmtrc.json`): 2-space indent, single quotes, trailing commas, semicolons, 80-char print width.

## Editor setup

`jsconfig.json` enables type checking (`checkJs: true`, `strict: false`) with `@webgpu/types` for WebGPU API completions. The `moduleResolution: "bundler"` setting allows ES module imports to resolve correctly in the IDE.

## Licensing

Code is MIT (`LICENSE`). `images/bg.png` and `preview.jpg` are © 原画师 千夜QYS3 (Pixiv ID 7210261), used with permission — they are excluded from the MIT license; do not extract or redistribute them.
