<div align="center">

<img src="docs/splash.gif" alt="Snippy's logo: a pair of scissors snipping, and the name lighting up" width="480">

# Snippy

**A free, playful video editor for Windows.**<br>
Edit like CapCut, with no watermark, no account and no subscription. Everything runs on your own computer.

[![Download for Windows](https://img.shields.io/github/v/release/wellsey001/snippy?label=Download%20for%20Windows&style=for-the-badge&color=c084fc)](https://github.com/wellsey001/snippy/releases/latest)

[![Release build](https://img.shields.io/github/actions/workflow/status/wellsey001/snippy/release.yml?label=build)](https://github.com/wellsey001/snippy/actions/workflows/release.yml)
![Windows 10 and 11](https://img.shields.io/badge/Windows-10%20%7C%2011-0078d4)
![Built with Electron and FFmpeg](https://img.shields.io/badge/built%20with-Electron%20%2B%20FFmpeg-8b5cf6)

</div>

---

## Highlights

| | |
|---|---|
| **AutoCut** | Pick your clips and a song, and Snippy edits them on the beat for you, then lets you flip between finished versions (Smooth, Energetic, Cinematic, Memories). It can also turn talking clips into a tight edit with captions. Optionally, type what you want (*"30 seconds, start with the sunset, lots of the dog, no shots of the car, end where he says 'see you next time'"*) and AutoCut looks and listens through your clips to match it. |
| **Find Shorts** | Drop in a long podcast, stream or vlog. Snippy finds the moments that work on their own and exports them as portrait Shorts with captions, the speaker kept in shot. |
| **Auto captions** | Speech-to-text runs on your PC in about 100 languages, timed word by word, with animated caption looks (Bold box, Karaoke, Bounce, Neon and more) and auto emoji. |
| **Keyframes and motion** | Move, zoom and turn anything straight on the preview, add keyframes with one click, and track a moving person or object so text, stickers and blur boxes follow it. |
| **Smart tools** | Remove pauses, edit by text (delete words to cut the video), auto reframe for TikTok, background removal, stabilise, studio voice and AI voiceovers. |
| **Made for sharing** | One-click presets for TikTok, Reels, Shorts, YouTube and WhatsApp, safe-zone guides, a thumbnail maker and fast exports using your graphics card. |

## Download and install

1. Download **`Snippy-Setup-<version>.exe`** from the [latest release](https://github.com/wellsey001/snippy/releases/latest) and run it.
2. If Windows shows "Windows protected your PC", click **More info** and then **Run anyway**. (Snippy isn't code-signed yet, so Windows doesn't recognise it.)

The installer is under 1 MB and downloads the rest of Snippy while it installs. Extras download only when they're needed, once each: the video tools (FFmpeg, about 50 MB) the first time Snippy opens, and the AI tools (about 30 MB) plus each AI model the first time you use an AI feature. After that, Snippy updates itself whenever a new version is released.

**You need:** Windows 10 or 11 (64-bit). A graphics card from NVIDIA, Intel or AMD makes exports faster, but isn't required.

## Features

<details>
<summary><b>Editing</b></summary>

- Import videos, photos and audio with the button or by dragging from Explorer. Photos work as clips, so slideshows are easy
- Trim by dragging clip edges, reorder by dragging, split at the playhead, and ripple delete (everything after moves up)
- Speed from ¼× to 4× with the pitch kept, speed curves (Montage, Hero, Bullet and more), reverse, boomerang and freeze frame
- Smooth slow motion: new in-between frames are made in the export instead of repeating frames
- 18 transitions (crossfade, whip pan, zoom, glitch, slices and more). Click the + between two clips to pick one, with hover previews, a length slider and a quick play of the cut. Use one on every cut, or Mix it up for a different one at each cut
- Snapping to the playhead, cuts, beats and markers. Markers (M) can also go on every 4th beat
- Source viewer: double-click anything in the media panel to open it on its own, mark the part you want (I and O), then Insert (,) it at the playhead, pushing everything after along, or Overwrite (.) what's there
- Pro trims: Alt+drag a clip edge to roll the cut, Alt+drag a clip to slip it, Alt+Shift+drag to slide it, Q and W to trim to the playhead and close the gap, and Alt+arrow keys to trim a frame at a time
- Sound apart from the picture: detach a clip's sound, or pick a J cut (the next sound leads in) or an L cut (the sound runs on) from the + between two clips
- Track controls: lock, hide, mute and solo each track, small, medium or large track heights (right-click a track's name), and Fit (\\) to see the whole edit
- Select several things, group them so they move together (Ctrl+G), or combine clips into one
- Copy and paste, including between projects, plus undo and redo
- Canvas shapes: 16:9, 9:16 and 1:1
- Resizable side panels: drag the grips beside the preview to widen the media or settings panel (double-click to reset). Portrait and square projects start with wider panels
- Smooth 4K editing: light preview copies are made in the background, and exports always use your originals

</details>

<details>
<summary><b>Text, captions and stickers</b></summary>

- Auto captions with Whisper, timed word by word, in short CapCut-style chunks or full sentences
- Caption looks: Bold box, Bounce, Karaoke, Pop in, Neon, Big word, One word, Highlight and Clean, with key words in colour and auto emoji
- Translate captions into Spanish, French, German, Italian, Dutch, Swedish, Russian, Ukrainian, Arabic, Hindi or Chinese
- Edit by text: delete words in the transcript to cut them from the video, and find "um"s and repeated words
- Text templates: title, lower third, subscribe, countdown, chapter, meme, breaking news, quote and typewriter, plus kinetic titles (Rising title, Glitch, Bounce in, Cinematic, Word by word, Neon sign, Impact). Hover over one to see it play
- Text animations in three parts: coming in (14 styles, including drop, focus, wipe, spin, glitch, letter by letter and word by word), going out (10 styles) and while on screen (pulse, float, wiggle, shake, flicker, glow). Each tile plays when you hover over it
- Nine fonts for any text or caption: Impact, Heavy, Bahnschrift, Trebuchet, Georgia, Comic, Script, Mono and Snippy's own
- Emoji stickers, 16 animated "fun" stickers, animated emoji, and your own GIFs and see-through PNGs

</details>

<details>
<summary><b>Motion, masks and layers</b></summary>

- Free transform on the preview: drag to move, scroll to resize, drag the handle to turn, with guide lines
- Keyframes for clips, overlays, stickers, text and volume, using buttons beside the timecode
- Motion tracking: draw a box around something, and a sticker, text, overlay or blur box follows it
- Masks on the main video: circle, heart, star, or a shape you draw yourself, with black, dimmed or blurred outside, keyframed or tracked
- Picture-in-picture overlays on as many tracks as you need, with shapes, blend modes, green screen and AI background removal
- Split screens, blur and pixelate boxes, and adjustment layers

</details>

<details>
<summary><b>Look and sound</b></summary>

- Colour looks, curves, .cube LUTs, and brightness, contrast and saturation
- Touch up: light, medium or strong skin smoothing with a little extra light, for faces close to the camera
- Effects: grain, VHS, old film, glitch and shake. Stabilise for shaky footage
- Beat detection: cut clips to the beat, with beats rated by how hard they hit
- Auto-duck music under speech, reduce background noise, studio voice, and even out loudness
- Voice changer (chipmunk, deep, robot, echo, radio, alien) and sound effects, including a free pack of 28 real recordings
- AI voiceovers from a script, with ten British and American voices, made on your PC
- Your own music library, sorted by mood, which fits a track under the whole video

</details>

<details>
<summary><b>Smart tools</b></summary>

- **AutoCut:** montage and talking-head edits made for you, in several versions to choose from
- **AutoCut prompt (optional):** describe what you want in plain words (length, style, what to show more of or leave out, how to open and end, words someone says, topics to keep from talking clips) and AutoCut matches it, showing what it understood as you type
- **Find Shorts:** the best moments of a long video, as captioned portrait Shorts
- **Templates:** Quick cuts, Smooth travel, Hype, Memories, Photo slideshow and Day in my life, cut to your song
- **Auto edit:** a highlight reel from long footage
- **Remove pauses** in talking clips
- **Auto reframe:** follows the person when changing a landscape video to portrait or square
- **Auto zoom-ins:** zooms in on the stressed words in talking clips (said louder, strong words, punchlines) and back out when the sentence ends, as a quick punch or a gentle push
- **Brand kit:** your colours, font, caption look, logo, intro and outro, saved once. Apply them to any project in one click, and add your logo as a watermark on every export

</details>

<details>
<summary><b>Export and sharing</b></summary>

- MP4 with no watermark, at 720p, 1080p or 4K, and 24, 30 or 60 fps. Animated GIF export too
- Presets for TikTok, Instagram Reels, YouTube Shorts, YouTube, Instagram posts and WhatsApp (a small file under 15 MB)
- Safe-zone guides showing where each app's buttons and captions cover the video
- Export in other shapes at the same time, each auto reframed
- Faster exports with your graphics card, falling back to the normal encoder if the card fails
- Thumbnail maker: it suggests the best frames, then you add big text and stickers. Save it as a JPG or PNG, or embed it as the MP4's cover

</details>

<details>
<summary><b>Projects</b></summary>

- A home screen with recent projects, AutoCut ready to drop clips on, and the version number with a **Restart to update** button once a new version has downloaded
- Save and open `.snippy` projects. Auto-save keeps a copy every minute and offers it back after a crash
- Missing files can be found again by searching a folder
- Right-click menus everywhere, shortcuts you can change, a welcome tour, and a check-up that tests everything is working

</details>

## Keyboard shortcuts

| Key | Action | Key | Action |
|---|---|---|---|
| Space | Play / pause | J / K / L | Play backwards / stop / play forwards (press again to go faster) |
| S | Split at the playhead | Shift+Delete | Ripple delete |
| T | Add text | E | Add a sticker |
| M | Add a marker | [ / ] | Previous / next marker |
| Alt+K | Add or remove a keyframe | ← / → | Step one frame |
| Ctrl+G | Group | Ctrl+Shift+G | Ungroup |
| Ctrl+C / X / V | Copy, cut, paste | Ctrl+Z / Ctrl+Y | Undo / redo |
| Ctrl+S | Save | Ctrl+O / Ctrl+N | Open / new project |
| Q / W | Trim to the playhead (start / end) | Alt+← / Alt+→ | Trim the end a frame |
| , / . | Insert / overwrite from the source viewer | \\ | Fit the timeline |

You can change these in the project panel.

## Privacy

Your videos never leave your computer. Captions, voices, translations, background removal and tracking all run locally. Snippy only goes online to download its tools and models (once each), optional sticker and sound packs, and updates.

## Run it from the code

1. Install [Node.js](https://nodejs.org) (the LTS version).
2. In this folder, run:

   ```
   npm install
   npm start
   ```

When you run it this way, Snippy uses the FFmpeg that `npm install` downloads, so there's no first-run download.

To update a copy of the code from a new `snippy.zip`, run `node update.js`. It copies the new files in, keeps your settings and installs any new packages.

To build installers yourself, run `npm run dist` for the small web installer, or `npm run dist:offline` for a single installer that doesn't need to download Snippy. Both appear in the `dist` folder.

## Releasing a new version

GitHub builds the installer itself:

1. Raise the version in `package.json` and push the code.
2. Open **Actions** → **Release Snippy** → **Run workflow**.
3. About 10 minutes later, the release appears on the [Releases page](https://github.com/wellsey001/snippy/releases), and installed copies offer "Restart to update".

The same build keeps the **components-v1** release up to date. It holds FFmpeg and FFprobe, which new installs download on first run, with a fingerprint for each file so a damaged download is never used. Don't delete that release.

## Credits

- [Electron](https://www.electronjs.org) and [FFmpeg](https://ffmpeg.org). The Windows FFmpeg build is from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/), via [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static)
- AI models run with [Transformers.js](https://github.com/huggingface/transformers.js):
  - captions: [Whisper](https://huggingface.co/onnx-community/whisper-base_timestamped)
  - voiceovers: [Kokoro](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)
  - background removal and reframing: [MODNet](https://huggingface.co/Xenova/modnet)
  - translation: [OPUS-MT](https://huggingface.co/Helsinki-NLP)
- Sound effects pack: [BigSoundBank](https://bigsoundbank.com) by Joseph Sardin (CC0)
- Animated emoji: [Google Noto Emoji](https://googlefonts.github.io/noto-emoji-animation/) (CC BY 4.0). Credit them in your video's description if you use them

Snippy used to be called Cutline, and old `.cutline` projects still open.
