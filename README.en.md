# Snowy Miku — Wallpaper Engine Web Wallpaper

[简体中文](README.md)

> **Snowy Miku** is a 4K Wallpaper Engine web wallpaper: a winter snow scene with a
> WebGPU-driven particle snow layer, made for a quiet, romantic winter atmosphere.

[![Steam Workshop](https://img.shields.io/badge/Steam-Workshop-1a1a2e?logo=steam)](https://steamcommunity.com/sharedfiles/filedetails/?id=3755473060)

---

## 🎨 Preview

![Preview](preview.jpg)

## 🖼️ Artwork

- **Artist**: 千夜 QYS3 ([Pixiv ID: 7210261](https://www.pixiv.net/users/7210261))
- **License**: used with the artist's permission

---

## ✨ Features

- **WebGPU particle system** — GPU-accelerated snow physics using a compute shader, rendering up to 1,000 particles at once
- **Temporal extrapolation** — particle positions are extrapolated in the vertex shader so the animation is decoupled from the monitor refresh rate
- **Adjustable parameters** — particle count, fall speed, color (white/pink), and wallpaper display mode can be changed live from the Wallpaper Engine properties panel
- **Background music** — off by default and looped when enabled; the toggle and volume are both in the properties panel. Wallpaper Engine allows autoplay; if a normal browser preview blocks `play()`, the player retries silently instead of showing a prompt
- **Date & time overlay** — center-origin positioning, with default properties placing it at the bottom-right. The display language follows the browser; because CEF often forces English, system timezones in mainland China, Hong Kong, Macau, and Taiwan fall back to Chinese, while other locales use English. 12/24-hour format, visibility, and X/Y position are independent properties, and the clock refreshes on second boundaries
- **CSS layer composition** — the background image stays on a CSS layer; a transparent WebGPU canvas overlays it with particles, and the browser compositor handles the blend
- **Flicker-free changes** — particle buffers are preallocated at maximum capacity; changing the count only updates a uniform and the dispatch size, so existing particles keep their animation state
- **Native 4K support** — optimized for high-resolution displays with `devicePixelRatio`-aware canvas sizing

---

## 🎮 Properties

Right-click the wallpaper in Wallpaper Engine → **Wallpaper** → **Properties**:

| Property | Type | Range / Options | Default | Description |
|----------|------|-----------------|---------|-------------|
| Particle Count | Slider | 0–1000 | 500 | Number of active particles (roughly one third are visible on screen) |
| Fall Speed | Slider | 500–3500 | 2000 | Higher values make the snow fall more slowly |
| Display Mode | Combo | Fill / Fit / Original Size | Fill | How the background image is scaled |
| Pink Particles | Toggle | On / Off | Off | Turns the snow pink (#F5B3BC) |
| Background Music | Toggle | On / Off | Off | Requires `music/bgm.flac`; off by default so a missing file never triggers a request |
| Music Volume | Slider | 0–100 | 35 | Volume changes use a short smooth ramp |
| Show Date & Time | Toggle | On / Off | On | Hides the overlay and stops its refresh timer |
| Time Format | Combo | 24-hour / 12-hour | 24-hour | Independent of Chinese/English; chooses `HH:mm:ss` or `h:mm:ss AM/PM` |
| Horizontal Offset | Slider | -100–100 | 100 | 0 = screen center, -100 = left edge, 100 = right edge; the default sits at the right edge |
| Vertical Offset | Slider | -100–100 | 95 | 0 = screen center, -100 = top edge, 100 = bottom edge; the default sits near the bottom |

> **Background music is off by default and no audio is shipped in this repository
> (`.flac` only).** If your wallpaper folder has no `music/bgm.flac`, put your own
> audio in `music/`, rename it to `bgm.flac`, switch to another wallpaper and back,
> then enable the music toggle in the properties panel. Full instructions, including
> hidden file extensions and Workshop updates, are in
> **[`music/README.en.md`](music/README.en.md)**.
> mp3 / m4a / wav / ogg will not play; convert them to FLAC first
> (`ffmpeg -i your-music.mp3 bgm.flac`). Without the file, the rest of the wallpaper
> keeps working and the console reports the load failure only once.

---

## 🏗️ Architecture

```
Miku/
├── README.en.md         # English documentation (this file)
├── README.md            # Chinese documentation
├── index.html           # Entry HTML — CSS background + WebGPU canvas + date/time overlay
├── project.json         # Wallpaper Engine metadata and property definitions
├── preview.jpg          # Steam Workshop preview
├── images/
│   └── bg.png           # 4K background artwork
├── music/
│   ├── README.en.md     # English "how to add music" guide
│   ├── README.md        # Chinese "how to add music" guide
│   └── bgm.flac         # User-supplied music, not tracked by git
├── js/
│   ├── settings.js      # Wallpaper Engine property bridge — engine ↔ JS modules
│   ├── particles.js     # WebGPU particle system — compute/render pipelines, buffers, frame loop
│   ├── audio.js         # Background music — looping, fades, silent autoplay retry
│   ├── datetime.js      # Date/time overlay — local time, second-aligned refresh
│   └── background.js    # Background display mode — CSS background-size switching
├── types/
│   └── wallpaper-engine.d.ts   # Engine-injected global typings for IDE type checking
└── CLAUDE.md            # Development notes for AI-assisted work
```

### Data flow

```
Wallpaper Engine properties panel
        │
        ▼
window.wallpaperPropertyListener.applyUserProperties(props)
        │
        ├──→ particles.setCount(n)       → GPU uniform update
        ├──→ particles.setSpeed(s)       → GPU uniform update
        ├──→ particles.setPink(bool)     → GPU uniform update
        ├──→ audio.setVolume(level)      → smooth <audio> volume ramp
        ├──→ audio.setMusicEnabled(bool) → fade in / fade out and pause
        ├──→ datetime.setVisible(bool)   → show / hide the clock
        ├──→ datetime.setTimeFormat(v)   → switch 12/24-hour format
        ├──→ datetime.setOffsetX(v)      → horizontal offset
        ├──→ datetime.setOffsetY(v)      → vertical offset
        └──→ background.setDisplayMode() → update CSS background-size
```

`datetime.js` chooses its display language from the browser, outside the properties
panel. `settings.js` calls its `start()` at boot and forwards
`customtimeformat` / `customdatetime` / `customoffsetx` / `customoffsety` to the
corresponding setters.

### WebGPU particle design

```
Compute pass (ping-pong, fixed 1/60s steps)
├─ buf0 ──→ compute shader ──→ buf1    physics step + boundary wrapping
├─ buf1 ──→ compute shader ──→ buf0    ping-pong alternation
│
Render pass (every frame)
├─ Vertex shader: instanced billboards + temporal extrapolation
├─ Fragment shader: radial-gradient discs (smoothstep falloff)
└─ Blend mode: premultiplied alpha
```

- **Buffer strategy**: two storage buffers preallocated at `MAX_COUNT = 1000`, used
  in ping-pong fashion; the active count is a uniform, so changing it never rebuilds
  a buffer
- **Fixed-step physics**: simulation advances at a fixed 60 Hz step, independent of
  the monitor refresh rate
- **Temporal extrapolation**: the renderer extrapolates positions using the remaining
  accumulator time, removing the gap between physics steps and display frames

### Background music

The audio source is the `<audio id="bgm" loop>` element in `index.html`;
`js/audio.js` only handles playback policy:

- **Autoplay fallback**: Wallpaper Engine allows playback. A normal browser preview
  may reject `play()` under its autoplay policy; the player stays silent, retries
  with exponential backoff (1s → 30s), and tries again on page interaction, window
  focus, or visibility change. A desktop wallpaper should never show a "click to
  play" prompt
- **Fades**: enabling or disabling music ramps `volume` over 1.2s, avoiding a hard
  cut. The ramp advances evenly in the **dB domain** (a linear amplitude ramp sounds
  front-loaded) and is based on wall-clock time, so background throttling only makes
  the steps coarser, not the fade longer
- **Responsive volume**: the properties-panel volume slider uses a 140ms ramp, not
  1.2s, so it follows the slider and settles immediately. The volume ramp uses a 6ms
  step instead of the 16ms fade step, avoiding zipper noise on large jumps. It runs
  on `setInterval`, not `rAF`, because `rAF` stops when the wallpaper loses focus
- **No request without music**: `preload="none"` plus an off-by-default toggle means
  a missing `bgm.flac` causes no request and no console noise. The first `play()`
  happens only after the user enables music; if the file is still missing, the player
  reports it once and stops retrying
- **Missing files are not fatal**: the `error` path stops retries and logs once; the
  CSS background and particles are unaffected
- **Audio format**: the path is hardcoded to `music/bgm.flac`, and the user-facing
  docs deliberately advertise **FLAC only** — supporting more formats would mean
  asking users to edit code. FLAC is an open codec that Chromium/CEF always decodes,
  without the licensing gaps of stripped-down AAC/MP3 builds; the tradeoff is roughly
  5–10× the size of a 320 kbps mp3 (32-bit float FLAC is not supported; use 16/24-bit)

---

## 🚀 Development

### Requirements

- [pnpm](https://pnpm.io/)

### Install

```bash
pnpm install
```

### Lint & format

```bash
pnpm lint          # oxlint + eslint (auto-fix)
pnpm lint:oxlint   # oxlint only (fast Rust linter)
pnpm lint:eslint   # eslint only
pnpm format        # oxfmt formatting
```

### Workflow

This is a **pure static web project** with no build step. All code is native browser
ES modules and loads directly in Wallpaper Engine:

1. Create a **Web** wallpaper in Wallpaper Engine
2. Point its Web URL at the local `index.html`
3. Edit the JS files and refresh the wallpaper to see the result

> **Tip**: `jsconfig.json` includes `@webgpu/types`, so VS Code and similar IDEs get
> WebGPU API completion and type checking.

---

## 📦 Stack

| Technology | Purpose |
|------------|---------|
| WebGPU (WGSL) | GPU compute and rendering — compute-shader physics + instanced rendering |
| CSS Background | Background image layer, composited natively by the browser |
| ES Modules | Modular JS with zero bundling and zero transpilation |
| oxlint + eslint | Static analysis and code-quality rules |
| oxfmt | Code formatting |

---

## 📄 License

The project's **source code** is released under the [MIT License](LICENSE).

**Third-party artwork is not covered by that license**: `images/bg.png` and
`preview.jpg` are works by **千夜 QYS3** (Pixiv ID 7210261), used with permission in
this wallpaper project. They are not "Software" under the MIT license and may not be
extracted, redistributed separately, or used in other projects. This scope is
documented in the "License scope" section appended to [LICENSE](LICENSE).

**Background music is also outside the MIT license**: audio files under `music/` are
provided by the user. The repository ships no audio and makes no claim about its
licensing — make sure you have the right to use and redistribute it.

---

## 🔗 Links

- [Steam Workshop](https://steamcommunity.com/sharedfiles/filedetails/?id=3755473060)
- [Wallpaper Engine](https://www.wallpaperengine.io/)
- [WebGPU specification](https://www.w3.org/TR/webgpu/)
- [WGSL specification](https://www.w3.org/TR/WGSL/)
