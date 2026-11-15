# Snippy

A free, playful desktop video editor for Windows, built with Electron and FFmpeg.

## Download

Get the latest installer from the [Releases page](https://github.com/wellsey001/snippy/releases/latest):
download `Snippy-Setup-<version>.exe` and run it. It's a small download that fetches the rest of
Snippy while it installs. The first time Snippy opens, it downloads its video tools (FFmpeg) once,
with a progress bar. AI features (captions, voices, background removal) download their models the
first time you use them. Installed copies update themselves when a new version is released.

## Run it from the code

1. Install Node.js (the LTS version) from nodejs.org.
2. Open this folder in a terminal and run:

   npm install
   npm start

When run this way, Snippy uses the FFmpeg that `npm install` downloads, so there's no first-run download.

## Build an installer on your own computer

   npm run dist

The small web installer appears in the `dist` folder (with the package it downloads from GitHub).
`npm run dist:offline` makes a single installer that doesn't need to download Snippy itself.

## What it does so far

- Import videos, photos (JPG, PNG, WebP, BMP) and audio (MP3, WAV, M4A and more) with the button or by dragging from Explorer
- Photos work as clips on the main track (3 seconds to start; drag the edge to change it), so slideshows are easy
- Main video track: trim by dragging clip edges, reorder by dragging clips, split at the playhead
- Text track: add captions, move and resize them, set size, position and colour
- Text templates: Add template opens a gallery (Title, Lower third, Subscribe, Countdown, Chapter,
  Meme, Breaking news, Quote, Typewriter) that drops styled text and stickers at the playhead.
  Text can be aligned left, centre or right, nudged up or down, given a box colour, and typed
  out letter by letter
- Animated captions: Pop, Fade or Slide up, word-by-word highlight in a colour you pick,
  an outline or a box behind the text, and ALL CAPS. Quick styles (Classic, Pop, Boxed,
  Karaoke) set these in one click. Captions are drawn by the same code in the preview
  and the export, so the video looks exactly like the editor
- Stickers: Add sticker (or press E) opens a picker of emoji, or paste any emoji.
  Drag a sticker on the preview to move it and drag its corner dot to resize it; set rotation and an
  animation (Pop, Bounce, Wiggle, Spin, Pulse). Stickers have their own timeline row and sit under captions
- Keyframes: animate an overlay's position, size and opacity, a sticker's position, size and
  rotation, and a clip's zoom and pan. Select it, click Add keyframe, move the playhead and change
  anything: Snippy saves it as a keyframe there and glides smoothly between them. Diamonds on the
  timeline mark each keyframe (click one to jump to it); arrows in the panel step between them
- Zoom & pan for clips, with a one-click Ken Burns slow zoom
- Overlay track for picture-in-picture: layer a video or photo (a facecam, a reaction, a logo
  or watermark) on top. Drag it on the preview to move it, drag its corner dot to resize it,
  or use the position buttons. Each overlay has size, opacity, volume and a colour look.
  Click "Overlay" on a media card to add one at the playhead
- Background removal for overlays: select a video or photo overlay and click Remove background.
  An AI cut-out model (MODNet, about 25 MB, downloaded the first time) finds the person in each
  frame on your PC; the result is a see-through video (WebM) or PNG, cached so each file is only
  done once. Restore background switches back
- Audio tools: Auto-duck turns music down while someone in your clips is talking (the preview
  and export use the same curve); Reduce background noise on any clip (applied on export);
  "Even out loudness" in the export settings normalises the mix to -14 LUFS; a level meter
  sits beside the play button
- Audio track for music and sound effects: move, trim, split, volume, fade in and fade out,
  with a waveform so you can see where the beats are
- Volume control (or mute) for each video clip
- Voice changer for clips and audio: Chipmunk, Deep, Robot, Echo, Radio and Alien. The preview
  plays the changed voice in step with the picture; the export uses the same filter
- Sound effects: Whoosh, Pop, Ding, Boing, Record scratch, Drum roll, Air horn and Censor beep,
  generated on your PC (no recordings, so no copyright). Listen first, then Add at the playhead
- Playback: Reverse or Boomerang (forwards then backwards) for clips up to 30 seconds, and
  Freeze frame here, which holds the picture at the playhead for 2 seconds
- Video effects for each clip: Grain, VHS, Old film, Glitch and Shake, live in the preview
- Green screen for overlays: make green, blue or any colour see-through (or pick it from the
  video), with strength and edge-softness sliders
- Beat sync: select a music item and click Find the beat. Beats are marked on the audio track and
  clips snap to them; Cut clips to the beat trims your clips so every cut (or every 2nd or 4th beat)
  lands on the beat
- Speed for each clip, from ¼× slow motion to 4× (sound keeps its pitch)
- Transitions: 18 styles. Crossfade, Dip to black, Flash, Blur, Pixelate, Wipe, Soft wipe,
  Slide, Circle open, Circle close, Clock, Whip pan, Zoom, Spin, Squeeze, Glitch, Shake cut and
  Slices, with a direction for wipes, slides and whip pans. Hover a tile to see it play.
  "Use this transition on every cut" sets them all at once; the first clip can fade in from
  black and the last can fade out
- Canvas presets: 16:9, 9:16 (for TikTok/Reels/Shorts) and 1:1
- Colour looks for each clip (Vivid, Warm, Vintage, Faded, Mono, Noir), previewed on the
  clip's own thumbnail, plus brightness, contrast and saturation sliders.
  "Use this look on all clips" copies the colour to every clip
- Undo and redo
- Smooth 4K editing: videos over 1080p, or in formats the preview can't play (such as iPhone
  HEVC), get a light 720p preview copy made in the background. The preview uses it; exports always
  use your original. Turn it off with "Light preview copies for 4K" in the media panel
- Export to MP4 (H.264 + AAC) with no watermark. Choose 720p, 1080p or 4K, 24, 30 or 60 fps,
  and Smaller file, Balanced or Best quality. Your last choice is remembered
- Snapping: dragged items and edges lock onto the playhead, cuts and other items' edges
  (a white line shows where). Turn it off with the Snap button, or hold Alt while dragging
- Auto-save: while you have unsaved changes, a copy is kept every minute. If Snippy or your PC
  crashes, Snippy offers to restore it next time it starts
- Save and open projects (.snippy files), with a warning before closing unsaved work
- Auto captions: Whisper runs on your PC, writes timed captions onto the text track,
  in short CapCut-style chunks or full sentences, using the Pop style with word highlighting.
  Each word is timed from the speech itself, so the highlight lands as it's spoken
  (captions are split at pauses and at the end of sentences) The model (~80 MB) downloads the first
  time and is cached in %APPDATA%/Snippy/models
- "Use this style for all text" restyles every caption at once
- Select several things at once: Ctrl+click items, or drag a box over them from an empty part of
  the timeline (Ctrl+A selects everything). Drag one to move them all, press Delete to remove them
  all, and with several captions selected, style changes apply to every one of them
- Copy and paste with Ctrl+C / Ctrl+X / Ctrl+V, also between projects: pasted items land at the
  playhead, and any videos they need are added to the new project's media
- Media panel: search by name, show only videos, photos or audio, sort by name, length or type,
  and "Remove unused media" to tidy the panel (your files are never deleted)
- Moved files: if a project's videos aren't where they were, Snippy lists them so you can point to
  each one, or search a folder and it finds them by name (others from the same folder are picked up
  automatically)
- A modern "Glow" look: frosted panels on a soft colour backdrop, icons throughout, and a
  violet-to-pink accent. All the colours are set at the top of src/styles.css, with the look itself in
  one block at the end
- Home screen: Snippy opens on your recent projects (with thumbnails) and big buttons to start a
  portrait 9:16, landscape 16:9 or square 1:1 video. Click the logo to come back to it
- Smart tools (timeline toolbar):
  - Remove pauses: finds the quiet gaps in talking clips and cuts them, leaving a little breathing
    room. Choose the pause length and how quiet counts as a pause; text, stickers and music move
    along to stay in step. It works from the sound level, so "um"s that are spoken aloud stay in
  - Auto reframe: follows the person in a landscape clip so it fills a portrait or square canvas,
    with a calm, smooth camera move written as zoom and pan keyframes you can adjust. It uses the same
    person-finding model as background removal (about 25 MB, downloaded the first time). Snippy also
    offers it when you change the canvas shape
- Voiceover: type a script, pick one of ten voices (British and American) and a speed, and a natural
  voice track is made on your PC, with matching captions if you like. The voice model (Kokoro, about
  90 MB) downloads the first time. Voiceovers are saved in Documents\Snippy\Voiceovers
- A free pack of 28 real sound effects (whooshes, applause, laughs, crickets, camera shutter, cork pop,
  boom, glass smash and more), downloaded once from the Sounds panel (about 12 MB). They're studio
  recordings from BigSoundBank.com by Joseph Sardin, released as CC0, so they can go in any video,
  commercial or not, with no credit needed. Snippy trims each one, shortens long recordings with a
  fade and evens out their levels. If some fail to download, "Try again" fetches just those
- Button feel: buttons dip when pressed with a soft ripple, choices pop when picked, play/pause
  bounces, Export throws a few sparks, menus and windows ease in, and new items drop on to the
  timeline. All of it switches off when Windows is set to reduce animations
- More stickers: 16 animated "fun" stickers drawn by Snippy (speech bubbles with your own words,
  YES!/BOOM! shouts, NEW!/SALE bursts, a bouncing arrow, a hand-drawn circle, sparkles, floating
  hearts, confetti, a Subscribe button that gets clicked, and a loading bar), 40 animated emoji from
  Google's Noto set (downloaded when first used; CC BY 4.0, so credit "Animated emoji: Google Noto
  Emoji, CC BY 4.0" in your description), and your own GIFs, animated WebPs and PNGs, which keep
  their see-through backgrounds and loop. Dropping a GIF on the window adds it as a sticker
- Stabilise (clip panel): Light, Medium or Strong smoothing for shaky handheld footage. Uses FFmpeg's
  two-pass vid.stab when available, otherwise its simpler deshake filter
- Speed curves (clip panel): Montage, Hero, Bullet, Flash in, Flash out and Jumper styles, or drag the
  five points yourself (0.1× to 10×). The sound follows the curve in short steps, keeping its pitch
- Overlay shapes: circle, rounded, heart, star or diamond masks with optional soft edges, and boxes
  (square, 9:16, 16:9, 4:5) that crop the picture to fit, with sliders to choose what shows
- Split screens: side by side, top and bottom, three across or stacked, a grid of four, or a big
  picture with a circle bubble, made from the overlays at the playhead
- Music library (Music button): your own tracks in Documents\Snippy\Music, sorted into mood folders.
  "Use" fits a track under the whole video: looped with soft joins if it's short, faded out at the
  end, and lowered automatically under speech. Only add music you're allowed to use
- Export queue: tick "Also export as" to save the same edit in the other canvas shapes too, each
  auto reframed to keep people in shot
- Check-up (project panel, "Run a check-up"): tests FFmpeg's features, folders, free space, internet
  access for downloads, and which models and packs are ready. "Copy results" makes it easy to share
- Export presets for TikTok / Reels / Shorts, YouTube and Instagram posts (Snippy tells you if your
  canvas is the wrong shape for the one you pick), and animated GIF export with its own colour palette
- AutoCut follows the music more closely: Energetic gets a speed ramp (fast, slow motion on the
  big hit, fast again), zoom pulses on the strong beats and quick flashes on the very biggest;
  Cinematic gets a smooth slow-motion moment; Smooth gets gentle pulses and colour pops. Beats are
  rated by how hard they hit, so only the big ones get effects
- Smooth slow motion: clips on a speed curve or at half speed or slower get new in-between frames
  made in the export (following the motion), instead of each frame being shown two or three times
- Faster exports with your graphics card (NVIDIA, Intel or AMD): Export → Speed. Snippy checks
  which card actually works, and if it fails part-way it carries on with the normal encoder
- AutoCut is on the home screen too: click it (or drop clips on it), pick your clips, and a new
  project opens straight into AutoCut, shaped to suit your clips (portrait, landscape or square)
  unless you choose a shape
- AutoCut (Smart tools, at the top): pick your clips and Snippy edits them for you, then lets you
  flip between a few finished versions before keeping one. Montage: it finds the best moments
  (lively, and skipping dark, blurry or wobbly bits), cuts them to the beat of your music and makes
  Smooth, Energetic, Cinematic and Memories versions: shots of 1 to 5 seconds, mostly clean cuts on
  the beat, gentle camera moves and a fade at the end. With no music, one continuous stretch of the
  clips' own sound plays under the whole edit, so the sound never jumps at the cuts. Shuffle picks new moments. Talking: it cuts out the
  pauses, adds captions and makes Clean, Punchy (jump zooms, bold box captions, emoji), Bouncy and
  Story versions, with quiet music underneath if you have some. Editing anything keeps the version
  you're on; Undo puts back what you had before
- Templates (Smart tools → "Make from a template"): Quick cuts, Smooth travel, Hype, Memories, Photo
  slideshow and Day in my life. Pick your clips and a song and Snippy cuts on the beat, with matching
  transitions, look, camera moves, a title and stickers. Ctrl+Z puts your old edit back
- Auto edit (Smart tools): give it long footage and it finds the liveliest moments (movement and
  loud bits) and builds a short highlight reel in any template style
- Colour grading: curves (drag the points, or start from Punchy, Soft, Matte, Brighter or Moody) on clips and overlays,
  .cube LUTs with a strength slider, and adjustment layers ("Adjust +" above the timeline) that grade
  everything underneath them for as long as they run
- Studio voice (clip panel → Voice) cleans and evens out speech, and "Even out loudness" (project
  panel → Sound) brings every clip to the same loudness (-16 LUFS, what YouTube and TikTok aim for)
- Overlays get as many tracks as you need: drag one up or down to change its track; higher tracks
  sit on top
- Ripple delete (Shift+Delete) removes a clip and pulls everything after it along, texts, stickers
  and sounds included. J / K / L play backwards, stop and play forwards; press J or L again for 2×, 4×, 8×
- Shortcuts can be changed in the project panel (click a key, then press the new one)
- Captions in other languages: Whisper understands about 100 languages, and can write English
  captions for speech in any of them. "Translate captions" (Smart tools) turns captions into Spanish,
  French, German, Italian, Dutch, Swedish, Russian, Ukrainian, Arabic, Hindi or Chinese, replacing
  them or adding a second line. Each language model downloads once (about 80 MB) and runs offline
- Free transform for the main video: click it on the preview, then drag to move it anywhere,
  scroll or drag a corner to resize it (10% to 400%), and drag the round handle to turn it (it clicks
  to straight at 0°/90°; hold Shift for 15° steps). It snaps to the middle with guide lines (hold Alt to
  stop that). The Transform tab also has exact sliders, quarter turns, flips, Fill, Ken Burns and crop.
  Scrolling over an overlay, sticker or text resizes that instead. With keyframes, every change is
  saved as a keyframe at the playhead. Projects from older versions are converted automatically
- Keyframe buttons next to the timecode (previous, add/remove, next) work on the selected clip,
  overlay, sticker, text or sound, whichever settings tab is open. Shortcut Alt+K
- Text can be dragged around the preview and keyframed: move, zoom, turn and opacity (text panel →
  Motion tab)
- Volume keyframes on music, sounds and voiceovers: the volume line is drawn across the sound on the
  timeline, so you can dip music under one line and bring it back
- Motion tracking (Motion tab of a sticker, text or overlay, or right-click → Track motion): draw a
  box round something in the video and the item follows it from the playhead, growing and shrinking
  with it if you like. It turns the path into keyframes you can adjust. Works best on things with
  clear detail; if it loses track it stops there and tells you
- The settings panel on the right is split into tabs for whatever is selected: Edit, Speed, Audio,
  Motion and Colour for clips; Layout, Shape, Motion, Cut out and Colour for overlays; Text, Style and
  Animation for text; and so on. Snippy remembers the last tab for each kind of item
- Blur and pixelate boxes (Sticker → Hide things): Blur box, Blur circle or Pixelate, with strength,
  soft edges and width. Drag and resize them on the preview, keyframe them, or use Track motion to
  keep a face or number plate hidden as it moves
- Blend modes for overlays (Layout tab): Screen, Add, Lighten, Multiply, Darken, Overlay, Soft light
  and Difference. Screen is the one for light leaks, sparks and smoke shot on black; Multiply for
  textures on white
- Edit by text (Smart tools): your captions as a transcript. Click a word to jump there; drag across
  words and press Delete to cut them from the video, and everything after moves up. "Find filler
  words" highlights um, uh and words said twice ("I I think") so you can cut them all at once.
  Needs auto captions first (the speech model sometimes leaves out "um"s as it writes)
- Caption looks (text → Style tab, or pick one when making auto captions): Bold box, Bounce,
  Karaoke, Pop in, Neon, Big word, One word, Highlight and Clean. Each word animates as it's said.
  Picking a look on an auto caption changes all of them. Also: key words in colour, and auto emoji
  (💰 for money, 🔥 for fire and so on) that pop up above the caption as the words are said
- Right-click menus: on timeline items (split here, freeze frame, speed, mute, play backwards,
  stabilise, bring forward / send backward for overlays, duplicate, copy, cut, delete), on empty
  timeline space (paste or add text, stickers, sounds and adjustment layers right there), on media
  (add, add as overlay, show in folder, remove) and on the preview. Arrow keys and Escape work in them
- A short welcome tour on first launch. See it again with "Show the welcome tour" in the
  project panel (click an empty part of the timeline to see it)

- Markers: press M to drop a marker at the playhead, [ and ] to jump between them. Drag a marker
  to move it, click it twice to name it, and right-click the ruler to add one on every 4th beat of
  the music. Clips, texts and stickers snap to markers, beats and the playhead
- Masks on the main video (Mask tab): circle, rounded box, box, heart, star, diamond or a shape you
  draw round something on the preview. Outside it can be black, dimmed or blurred, with a soft
  edge and a swap option. Drag on the preview to move it and scroll to resize; keyframes animate
  it, and "Follow something" tracks it on to a moving person. Exports match the preview
- Groups: select texts, stickers, sounds or overlays and press Ctrl+G so they move together
  (Alt+click picks just one; Ctrl+Shift+G ungroups). Combine into one clip: select clips that sit
  next to each other (and any texts or stickers over them) and they're rendered into a single
  clip, which can be split back into the originals from its right-click menu
- Sharing presets: TikTok, Instagram Reels, YouTube Shorts, YouTube, Instagram post and WhatsApp
  (a small 720p file aiming for under 15 MB). The safe-zones button under the preview shows
  roughly where each app's buttons, captions and bars cover the video

- Find Shorts (Smart menu): Snippy listens to a long video (podcast, stream, vlog, talk) and
  suggests the moments that work on their own, scored on the opening line, a finished thought,
  pace, a lively voice and few pauses or "um"s. Play each one, move its start or end by a
  sentence, then export the ones you tick as portrait Shorts (1080×1920) with captions kept clear
  of the apps' buttons, the opening line as a title, pauses cut and the speaker kept in shot.
  Or open one as its own project to keep editing. The transcript is remembered, so trying
  another length is instant
- Thumbnail maker (Smart menu): suggests the sharpest, most colourful frames of your edit; add
  big text (Impact, heavy or clean, six styles) and emoji stickers, boost the colours, darken
  the edges and zoom the picture. Save as JPG (kept under YouTube's 2 MB) or PNG, for YouTube,
  a 9:16 cover or square. "Use as the video's cover" stores it inside exported MP4s

- A loading screen: the logo pops in, the scissors snip and the name slides up with a flash of light (1.8 seconds).
  The editor opens when the animation finishes, or as soon as it's ready if it takes longer

## Shortcuts

Space play/pause, J/K/L shuttle, Alt+K keyframe, S split, Shift+Delete ripple delete, T add text, E add sticker, Delete remove selected,
Left/Right step one frame, M add a marker, [ / ] previous and next marker, Ctrl+click select several, Ctrl+A select all, Ctrl+G group, Ctrl+Shift+G ungroup,
Ctrl+C / Ctrl+X / Ctrl+V copy, cut and paste, Ctrl+Z undo, Ctrl+Y redo, Ctrl+S save, Ctrl+Shift+S save a copy, Ctrl+O open, Ctrl+N new, Ctrl+scroll zoom timeline, F12 dev tools.

## Notes

- Volume goes from muted to 200%. Music that runs past the end of the video is cut off on export.

- Preview uses Chromium's built-in decoder. Some phone videos (HEVC/H.265) may not preview,
  but they still export because export uses FFmpeg.
- Project files store links to your videos, not copies. If you move or rename a video,
  Snippy will tell you it's missing when you open the project.
- Auto captions need an internet connection the first time only. Version 0.10 switched to a
  speech model that can time each word, so it downloads once more (about 80 MB).

- Snippy used to be called Cutline. Old .cutline project files still open.


## Updating to a new version

Download the new snippy.zip, then in your snippy folder run:

    node update.js

It finds the newest snippy zip in your Downloads folder (or give it a path: `node update.js C:\path\snippy.zip`),
copies the new files in, and updates package.json without losing your install-script approvals or
release settings. It never touches node_modules, and it installs any new packages the update needs.
If npm then lists packages with install scripts to approve, approve them and you're done.

## Releasing a new version (GitHub)

The code lives at https://github.com/wellsey001/snippy. GitHub builds the installer itself, so
nothing needs building or uploading on your computer:

1. Put the new version's code on GitHub (commit and push, for example with GitHub Desktop).
   The version number comes from `package.json` (`node update.js` raises it for each new zip).
2. On GitHub, open **Actions** > **Release Snippy** > **Run workflow**.
3. About 10 minutes later the release appears on the Releases page, and installed copies of
   Snippy offer "Restart to update".

The same build also keeps the video tools (the `components-v1` release) up to date: FFmpeg and
FFprobe, squeezed with gzip, with a list of each file's size and fingerprint. Snippy checks the
fingerprint after downloading, so a damaged download is never used. Don't delete that release:
new installs download their video tools from it.
