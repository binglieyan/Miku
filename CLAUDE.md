# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Wallpaper Engine "web" type wallpaper — a 4K Miku snow scene. `images/bg.png` renders as a CSS `background` layer, and a transparent WebGPU canvas overlays animated particle snow on top via browser compositing.

## Development commands

```bash
pnpm lint          # Run both oxlint + eslint (with auto-fix)
pnpm lint:oxlint   # oxlint only (fast Rust linter)
pnpm lint:eslint   # eslint only (JS rules + Prettier skip)
pnpm format        # oxfmt formatter (targets js/)
```

**No build step** — vanilla JS (ES modules) served directly to the browser; `project.json` points Wallpaper Engine at `index.html`. **No test suite** — verify by loading the wallpaper (see README §开发流程).

**No local WGSL compiler** — shader edits cannot be compile-checked here: no `tint`/`naga`, the Node Dawn bindings need a postinstall binary that pnpm blocks, and headless Chrome gets no WebGPU adapter (a third-party WGSL parser catches only structural syntax). So verify shader changes by loading the wallpaper: a WGSL error surfaces loudly as `[particles] GPU 初始化失败，回退到纯 CSS 背景` with no particle layer, while the CSS background keeps rendering.

Package manager: pnpm (`pnpm-lock.yaml`). The repo pins no version — there is no `packageManager` field and no `.npmrc`.

## Architecture

`index.html` loads one entry module (`<script type="module" src="js/settings.js">`), which imports the other two:

| Module             | Responsibility                                                                                                                                                                                                                      |
|--------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `js/settings.js`   | Engine bridge: implements `window.wallpaperPropertyListener.applyUserProperties`, the sole engine↔wallpaper interface; forwards each property, no business logic.                                                                     |
| `js/background.js` | `setDisplayMode(mode)` switches CSS `background-size` on `#background` (`cover`/`contain`/`auto`).                                                                                                                                   |
| `js/particles.js`  | WebGPU particle system (compute physics, instanced billboard quads, radial-gradient fragments). Exports `start()`, `setCount(n)`, `setSpeed(s)`, `setPink(bool)`.                                                                     |

**Data flow:** Wallpaper Engine → `wallpaperPropertyListener.applyUserProperties(props)` → per-property branch → GPU buffers / CSS.

The detailed design lives in the `js/particles.js` JSDoc, which is kept in sync with the code; treat it as the reference for anything not stated below. What follows is the map plus the invariants that span files.

## Wallpaper Engine integration

`project.json` holds the metadata and the user-adjustable properties; `type: "Web"` marks a web wallpaper (Workshop id 3755473060). `applyUserProperties` fires on load with all properties and afterwards only with the changed ones, so every branch checks existence.

| Key           | Type   | Range/Options          | Default | Effect                                                             |
|---------------|--------|------------------------|---------|--------------------------------------------------------------------|
| `aNumber`     | slider | 0–1000                 | 500     | → `particles.setCount(n)`                                          |
| `aSpeed`      | slider | 500–3500               | 2000    | → `particles.setSpeed(s)` (larger = slower; `speedFactor = 1500/s`) |
| `customcombo` | combo  | cover / contain / auto | cover   | → `background.setDisplayMode(m)`                                   |
| `custompink`  | bool   | —                      | false   | → `particles.setPink(b)`                                           |

`general.properties.schemecolor` is an engine-UI scheme color (order 0) — not handled in JS.

## WebGPU particle system design

**Buffer strategy:** two storage buffers (`_buf0`, `_buf1`) allocated once at `MAX_COUNT = 1000`; the active count is a uniform, so `setCount()` only rewrites the uniform and the dispatch size — buffers are never resized, so there is no allocation jitter and no particle-state reset. `setCount(0)` stops the rAF loop, clears the frozen frame with one no-draw render pass, and a positive value restarts it.

**Compute pass:** one `beginComputePass()` per frame, inside it `floor(accumulator / FIXED_STEP)` ping-pong dispatches (`_currentSrc` toggles), `_workgroupCount = ceil(count / 64)`; threads with `i >= count` return early and keep their last written state.

**Wind/turbulence model:** turbulence sway, lateral wind and depth wind are part of the simulation, not a render-time offset. Each particle carries its own clock (`_p0`); a step advances it by `PHASE_PER_STEP = 1/PHYSICS_HZ` and adds the *difference* of the wind field between the old and the new phase to the position — the difference form keeps the contribution bounded instead of accumulating as an absolute offset. `WindDelta`, `windDelta` and `wrapRange` live in the `WGSL_COMMON` chunk interpolated into both shaders, so the compute and vertex sides cannot drift apart. `TIME_WRAP = 200π` is a common period of every frequency in play (each `100 × f` is an integer). `nearScale = clamp((cameraZ - p.posZ) / 500, 0.35, 1)` damps all four terms on both sides. The vertex shader calls the same functions with the fractional-step phase `extrapPhase`, so no render-only displacement remains.

**Render pass:** instanced draw (4 vertices × `_count` instances, `triangle-strip`). The vertex shader projects and extrapolates both the base velocity and the wind phase; the fragment shader draws radial-gradient circles with premultiplied alpha (blend `one` / `one-minus-src-alpha`, canvas `premultiplied`). Screen radius caps at `MAX_SR = 48 px`, particles fade out below `NEAR_DIST = 35` world units, and a symmetric far fade — from `cameraZ + FAR_PLANE_OFFSET` to `cameraZ − zMin`, driven by the pre-wrap predicted depth — makes every boundary wrap happen at a fully transparent depth. Fully faded or behind-camera particles collapse to zero-area quads (no fragment cost).

**3D world:** box world with per-axis bounds recomputed by `_updateWorldSize()` on load and after each resize. `_worldHalf` comes from the frustum extent at `MAX_DIST` (= `CAMERA_Z + FAR_PLANE_OFFSET`, the one constant shared with the shader's fade start): `max(ceil(max(halfW, halfH) × 1.1), 2000)`. `_yHalf` comes from the frustum half-height at the far-fade end, and z spans `[CAMERA_Z − farFadeEnd, CAMERA_Z + 1]` — the visible depth band plus a 1-unit wrap destination behind the camera. Keeping y/z tight (instead of a full cube) keeps most of the budget on screen rather than idling behind the camera or past the far plane. Boundary wrapping uses the same per-axis modulo (`wrapRange`) and the same bounds (`±worldHalf`, `±yHalf`, `[zMin, zMax)`) on both sides, so any overshoot is normalized in one step rather than once per frame.

**Resize:** a 150 ms debounce shared by `window.resize` and a `matchMedia('(resolution: Xdppx)')` listener — the latter catches dpr-only changes (another monitor, a system-scale change) where no `resize` fires. `_applyCanvasSize()` recomputes the backing store, `focalLength` and the world (`_watchDevicePixelRatio()` re-arms the media query); it also runs once at module load.

**Failure handling:** device loss (`.lost`), GPU validation errors (`uncapturederror` — these never throw JS exceptions) and in-frame sync errors all funnel into `_shutdown()`, which nulls `_device`/`_queue` **and every GPU resource reference** (each holds a device reference, so nulling only `_device` would keep the dead device graph alive) and truly stops the rAF loop; the CSS layer keeps rendering. Policy: loss is retried — `_scheduleRetry()` re-runs `_initGPU()` after 2 s, capped at `MAX_INIT_ATTEMPTS = 3` per episode, plus a rate limit of more than `MAX_LOSSES_PER_WINDOW = 5` losses per `LOSS_WINDOW_MS = 10 min`, so a device that dies right after every recovery cannot rebuild the GPU forever; `uncapturederror` is deterministic and deliberately **not** retried; a machine that never got a device (`_everReady` still false) never retries, so it cannot spin. Three traps: `_shutdown()` deliberately leaves the canvas as-is (a non-GPU blank would turn each loss→retry gap into "snow disappears, then returns"); a missing `#canvas` is not fatal — the module still evaluates and the property bridge keeps working, with no particle layer; and `_initGPU` re-calls `start()` on success, because the engine may have called it before the device existed (`start()` is gated on `_device` and idempotent).

**Device init:** `requestAdapter()` is called without `powerPreference` — Chromium on Windows ignores that option (crbug.com/369219127) and logs a warning; on dual-GPU machines the GPU is chosen by the OS (Windows Settings → System → Display → Graphics for wallpaper32.exe / webwallpaper32.exe).

### Design invariants (do not break)

1. JS ↔ WGSL uniform layouts must match: render 12 f32 (48 B), with `[extrapFactor, extrapPhase]` written at offset 24 per frame; compute 7 fields (28 B).
2. `farFadeEnd > MAX_DIST` at every aspect ratio, otherwise the shader's far fade degenerates into `edge0 > edge1`.
3. Physics and rendering share `windDelta` / `wrapRange`, the same bounds, the same accumulation order, and the phase semantics (1 phase unit = 1 real second).
4. Per-frame JS stays allocation-free; `_renderPassDescriptor` plus its `_colorAttachment` alias are the one preallocated exception — keep the alias instead of inlining the lookup chain.
5. Every wrap plane stays outside the frustum at all visible depths, so wraps always land off-screen or fully faded.

## Linting & formatting configuration

- **oxlint** (`.oxlintrc.json`): `correctness` at error level; plugins `eslint`, `unicorn`, `oxc`; browser env. Four style rules — off by default — are enabled explicitly: `curly`, `object-shorthand`, `prefer-arrow-callback`, `prefer-template`.
- **eslint** (`eslint.config.js`): `@eslint/js` recommended + `eslint-config-prettier` + the oxlint plugin. Its one block, `app/eslint-only-style`, must sit **after** `skipFormatting` to add the two rules oxlint lacks: `semi` (prettier-config turns it off) and `camelcase` (oxlint has no such rule, and ignores all-caps constants like `MAX_COUNT`).
- **oxfmt** (`.oxfmtrc.json`): 2-space indent, single quotes, trailing commas, semicolons, 80-char print width. Formatting rules belong here — oxlint implements none, so one added to `.oxlintrc.json` fails with "Rule not found".

## Editor setup

`jsconfig.json` enables `checkJs` (with `strict: false`, `@webgpu/types`, `moduleResolution: "bundler"`) and includes `types/**/*.d.ts`; a check with TypeScript 7 is clean, though `tsc` is not a repo dependency. Two non-obvious constraints keep it clean, so do not undo them:

- `types/wallpaper-engine.d.ts` declares the engine's non-standard global `window.wallpaperPropertyListener`. Without that declaration TS reports an unknown property **and silently skips checking the literal assigned to it**, which would leave the bridge's callback signature unverified.
- TS 7 mis-applies a JSDoc type annotation written *on a destructuring declaration* (it blames the element type for missing an iterator, and a plain number array reproduces it), so `_colorAttachment` is deliberately left unannotated — its type is inferred.

## Licensing

Code is MIT (`LICENSE`). `images/bg.png` and `preview.jpg` are © 原画师 千夜QYS3 (Pixiv ID 7210261), used with permission — they are excluded from the MIT grant by the "License scope" notice appended to `LICENSE`; do not extract or redistribute them. `images/bg.png` (3840×2160) is a lossless in-repo re-compression (15.32 MB → 9.18 MB, pixel-identical); the artist's original bytes remain recoverable from git history.
