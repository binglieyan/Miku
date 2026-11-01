# Adding Background Music

[简体中文](README.md)

This **repository** does not include any audio files; whether a published package
includes music is up to its author. If your wallpaper folder has no
`music/bgm.flac`, put your own music in this folder and rename it to `bgm.flac`.
The music toggle is off by default, so you still need to enable it in the properties
panel after adding the file.

> ## ⚠️ FLAC only
>
> **This wallpaper plays `.flac` files only.** mp3, m4a, wav, ogg, and aac will not
> work — renaming the file is not enough, because the player path is hardcoded to
> `music/bgm.flac`.
>
> If your music is in another format, **convert it to FLAC first**, then copy it in.
> Conversion instructions are [below](#format-requirements-flac-only). This is the
> only extra step.

Four steps, about a minute.

---

## Step 1: Find the wallpaper folder

**For a Workshop wallpaper** (the usual case)

1. Open Wallpaper Engine and select the wallpaper under **Installed**
2. **Right-click → Open in Explorer**

The path will look like:

```
...\Steam\steamapps\workshop\content\431960\3755473060\
```

**For a manually downloaded wallpaper package**

Open the folder where you extracted the package; it should contain `index.html`.
You should see `index.html`, `images`, `js`, and `music`.

## Step 2: Put the audio in the `music` folder

Drag the **already converted `.flac` file** into `music/`. The filename does not
matter yet.

## Step 3: Rename it to `bgm.flac`

Rename it to **`bgm`**, with the extension **`.flac`**.

It should end up like this:

```
music\
└── bgm.flac
```

> ### ⚠️ This is the most common failure point
>
> Windows Explorer hides **known file extensions** by default. If you rename the
> file to `bgm`, Windows may actually leave it as `bgm.mp3`; the extension is still
> mp3, the wallpaper stays silent, and the filename looks correct.
>
> **Turn on file extensions first**: Explorer → **View** → enable **File name
> extensions** (Windows 11: **View → Show → File name extensions**).
>
> You will then see the full name, such as `bgm.mp3`. Rename it to `bgm.flac` and
> confirm the warning about changing the extension.

## Step 4: Reload the wallpaper

The audio element is read when the page loads, so you must reload after changing the
file:

- Switch to another wallpaper in **Installed**, then switch back; or
- Restart Wallpaper Engine.

Then open the wallpaper's **Properties** panel and check:

- **Background Music** is **on** — it is **off by default**, and a wallpaper with no
  audio file never requests one
- **Music Volume** is not 0 (default: 35)

---

## Format requirements: FLAC only

| Format | Plays? | What to do |
|---|---|---|
| **`.flac`** | ✅ | Rename it to `bgm.flac`; no code changes needed |
| `.mp3` | ❌ | Convert to FLAC |
| `.m4a` / `.aac` | ❌ | Convert to FLAC |
| `.wav` | ❌ | Convert to FLAC (this also reduces the size) |
| `.ogg` / `.opus` | ❌ | Convert to FLAC |
| 32-bit / float FLAC | ❌ | Convert to 16-bit or 24-bit |

**Why FLAC**: it is an open, lossless codec. Windows and the browser engine used by
Wallpaper Engine always include a decoder, unlike mp3/aac in some stripped-down
builds where the licensed decoder may be missing.

### Converting to FLAC

**Install and use ffmpeg (one command, easiest)**

```bash
ffmpeg -i "your-music.mp3" "bgm.flac"
```

**Use a GUI tool**

- **Foobar2000**: right-click the track → Convert → choose FLAC
- **Format Factory**: choose **Audio → FLAC**
- **Audacity**: open the audio → File → Export → Export as FLAC

Rename the result to `bgm.flac` and put it in `music\`.

> **Size note**: FLAC is lossless and roughly 5–10× the size of a 320 kbps mp3 for
> the same duration. A four-minute track is usually 20–40 MB. If that is too large,
> use 16-bit / 44.1 kHz FLAC: it is smaller and the audible difference is negligible.

**Bit depth**: 16-bit or 24-bit at 44.1 or 48 kHz is the safe range. 32-bit float
FLAC cannot be decoded; the console will print
`[audio] 音频加载失败（MediaError code …）` once, the wallpaper stays silent, and
everything else keeps working.

---

## No sound? Check in this order

| Symptom | Cause | Fix |
|---|---|---|
| No sound at all, and the file is mp3 / m4a / wav | **Wrong format; FLAC only** | Convert to FLAC (see above) |
| No sound, but the filename looks correct | Extensions are hidden; the file is actually `bgm.flac.mp3` or `bgm.mp3` | Enable extensions and rename again |
| No sound, and the file really is `bgm.flac` | The page was not reloaded | Switch to another wallpaper and back |
| No sound, everything above is correct | **Background Music** is off (**default**) or the volume is 0 | Enable it and raise the volume in Properties |
| Sound is very quiet | Default volume is 35 | Raise Music Volume |
| Console shows `[audio] 音频加载失败（MediaError code …）` | 32-bit float FLAC, or a corrupted file | Convert to 16/24-bit FLAC; code 3 = decode failure, code 4 = missing/unsupported file |
| Music disappeared after an update | Workshop updates **reinstall the whole project folder** | Add the file again (see below) |

---

## Two things to know

**1. Workshop updates remove your music**

When the author updates a subscribed wallpaper, Steam downloads the entire project
folder again. Your `bgm.flac` is not part of the update package and will be removed.
Add it again after each wallpaper update.

**2. Copyright**

`bgm.flac` is provided by you and is not distributed with the wallpaper, so this
project does not redistribute it. **You are still responsible for what you add and
how you use it**: local personal listening is unrestricted; if you share the whole
wallpaper folder with someone else, make sure you have the right to redistribute the
track.

---

## For developers

- The audio path is **hardcoded** to `music/bgm.flac`; the only definition is in
  `index.html`:
  `<audio id="bgm" src="music/bgm.flac" loop preload="none">`. The user-facing docs
  therefore advertise FLAC only — supporting more formats would mean asking users to
  edit code. To change the format, update that `src`, and keep `music/README.md` and
  the `description` in `project.json` in sync (all three must agree).
- Do not change `preload="none"` back to `auto`: `auto` fetches `bgm.flac` while
  parsing the HTML. The toggle is off by default, so a missing file produces no
  request and no 404; only an explicit user enable starts the first `play()` and the
  one-time failure report.
- When previewing `index.html` directly in a browser, there is no engine property
  callback, so the module's switch stays off by design (see `preload` above).
  `?bgm=on` turns it on for debugging; actual playback still depends on the browser's
  autoplay policy. In Wallpaper Engine it is off by default and must be enabled in
  the properties panel.
- Looping is handled by `<audio loop>`. Ideally the track should loop seamlessly;
  a normal song will produce an audible seam at the loop point.
- Wallpaper Engine allows autoplay and normally needs no user gesture; only a plain
  browser preview or another restricted host may block it. `js/audio.js` keeps a
  silent exponential retry (1s → 30s) and also retries on click/keypress, window
  focus, or visibility change. Clicking the properties panel is not a page gesture.
- On a missing or undecodable file, the `error` handler stops retries and reports
  once with the `MediaError` code; the rest of the wallpaper is unaffected.
- Audio in this folder is ignored by `.gitignore` (only the two guides are tracked),
  so it is not distributed with the **git repository**. Wallpaper Engine publishes
  the project folder, however: if a local `music/bgm.flac` exists, it will be
  uploaded to the Workshop too. Make sure you have the right to distribute it. If
  you want to commit a track you created yourself or a CC0 track, remove the three
  `music/*`, `!music/README.md`, and `!music/README.en.md` rules from `.gitignore`.
- This guide may be deleted.
