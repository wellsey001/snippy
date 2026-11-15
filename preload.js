const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickFiles: () => ipcRenderer.invoke('dialog:import'),
  probe: (filePath) => ipcRenderer.invoke('media:probe', filePath),
  pickExportPath: (format) => ipcRenderer.invoke('dialog:export', format),
  exportVideo: (project, outPath) => ipcRenderer.invoke('export:start', project, outPath),
  hwEncoders: () => ipcRenderer.invoke('encoders:hw'),
  compoundPath: () => ipcRenderer.invoke('compound:path'),
  componentsStatus: () => ipcRenderer.invoke('components:status'),
  installComponents: () => ipcRenderer.invoke('components:install'),
  cancelComponents: () => ipcRenderer.invoke('components:cancel'),
  onComponentsProgress: (cb) => { const f = (_e, p) => cb(p); ipcRenderer.on('components:progress', f); return () => ipcRenderer.removeListener('components:progress', f); },
  getTranscript: (filePath, key) => ipcRenderer.invoke('transcript:get', filePath, key),
  putTranscript: (filePath, key, data) => ipcRenderer.invoke('transcript:put', filePath, key, data),
  saveImage: (dataUrl, name) => ipcRenderer.invoke('image:save', dataUrl, name),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  onExportProgress: (cb) => {
    const handler = (_e, value) => cb(value);
    ipcRenderer.on('export:progress', handler);
    return () => ipcRenderer.removeListener('export:progress', handler);
  },
  showInFolder: (filePath) => ipcRenderer.invoke('shell:show', filePath),
  pathForFile: (file) => webUtils.getPathForFile(file),

  openProject: () => ipcRenderer.invoke('project:open'),
  relinkPick: (name) => ipcRenderer.invoke('relink:pick', name),
  translateLangs: () => ipcRenderer.invoke('translate:langs'),
  translateTexts: (texts, lang) => ipcRenderer.invoke('translate:run', texts, lang),
  cancelTranslate: () => ipcRenderer.invoke('translate:cancel'),
  onTranslateProgress: (cb) => { const f = (_e, p) => cb(p); ipcRenderer.on('translate:progress', f); return () => ipcRenderer.removeListener('translate:progress', f); },
  measureLoudness: (src, a, b) => ipcRenderer.invoke('loudness:measure', src, a, b),
  findSilences: (src, a, b, opts) => ipcRenderer.invoke('silence:find', src, a, b, opts),
  trackSubject: (src, a, b, w, h, id) => ipcRenderer.invoke('reframe:track', src, a, b, w, h, id),
  cancelReframe: () => ipcRenderer.invoke('reframe:cancel'),
  trackMotion: (filePath, a, b, box, srcW, srcH, id) => ipcRenderer.invoke('track:run', filePath, a, b, box, srcW, srcH, id),
  cancelTrack: () => ipcRenderer.invoke('track:cancel'),
  onTrackProgress: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('track:progress', handler);
    return () => ipcRenderer.removeListener('track:progress', handler);
  },
  onReframeProgress: (cb) => { const f = (_e, p) => cb(p); ipcRenderer.on('reframe:progress', f); return () => ipcRenderer.removeListener('reframe:progress', f); },
  ttsVoices: () => ipcRenderer.invoke('tts:voices'),
  makeVoiceover: (text, voice, speed, opts) => ipcRenderer.invoke('tts:make', text, voice, speed, opts),
  cancelVoiceover: () => ipcRenderer.invoke('tts:cancel'),
  onVoiceoverProgress: (cb) => { const f = (_e, p) => cb(p); ipcRenderer.on('tts:progress', f); return () => ipcRenderer.removeListener('tts:progress', f); },
  runCheckup: () => ipcRenderer.invoke('checkup:run'),
  analyzeHighlights: (filePath, dur, hasAudio, id, opts) => ipcRenderer.invoke('highlights:analyze', filePath, dur, hasAudio, id, opts),
  onHighlightsProgress: (cb) => { const f = (_e, p) => cb(p); ipcRenderer.on('highlights:progress', f); return () => ipcRenderer.removeListener('highlights:progress', f); },
  pickLut: () => ipcRenderer.invoke('lut:pick'),
  readLut: (p) => ipcRenderer.invoke('lut:read', p),
  pickStickerFile: () => ipcRenderer.invoke('sticker:pickFile'),
  stickerBytes: (p) => ipcRenderer.invoke('sticker:bytes', p),
  notoSticker: (code) => ipcRenderer.invoke('sticker:noto', code),
  musicList: () => ipcRenderer.invoke('music:list'),
  openMusicFolder: () => ipcRenderer.invoke('music:openFolder'),
  addMusic: (mood) => ipcRenderer.invoke('music:add', mood),
  recentProjects: () => ipcRenderer.invoke('recent:list'),
  addRecent: (entry) => ipcRenderer.invoke('recent:add', entry),
  removeRecent: (p) => ipcRenderer.invoke('recent:remove', p),
  openProjectPath: (p) => ipcRenderer.invoke('project:openPath', p),
  relinkSearch: (names) => ipcRenderer.invoke('relink:search', names),
  initialProject: () => ipcRenderer.invoke('project:initial'),
  saveProject: (filePath, text) => ipcRenderer.invoke('project:save', filePath, text),
  saveProjectAs: (text) => ipcRenderer.invoke('project:saveAs', text),
  setProjectState: (s) => ipcRenderer.send('project:state', s),
  writeRecovery: (text) => ipcRenderer.invoke('recovery:write', text),
  readRecovery: () => ipcRenderer.invoke('recovery:read'),
  clearRecovery: () => ipcRenderer.invoke('recovery:clear'),

  generateCaptions: (clips, opts) => ipcRenderer.invoke('captions:generate', clips, opts),
  cancelCaptions: () => ipcRenderer.invoke('captions:cancel'),
  removeBackground: (filePath, kind) => ipcRenderer.invoke('cutout:make', filePath, kind),
  cancelCutout: () => ipcRenderer.invoke('cutout:cancel'),
  detectBeats: (filePath, start, end) => ipcRenderer.invoke('beats:detect', filePath, start, end),
  audioLevels: (filePath) => ipcRenderer.invoke('audio:levels', filePath),
  findProxy: (filePath) => ipcRenderer.invoke('proxy:find', filePath),
  makeVoice: (filePath, fx) => ipcRenderer.invoke('voice:make', filePath, fx),
  listSoundEffects: () => ipcRenderer.invoke('sfx:list'),
  makeSoundEffect: (id) => ipcRenderer.invoke('sfx:make', id),
  downloadSoundPack: () => ipcRenderer.invoke('pack:download'),
  cancelSoundPack: () => ipcRenderer.invoke('pack:cancel'),
  onSoundPackProgress: (cb) => { const f = (_e, p) => cb(p); ipcRenderer.on('pack:progress', f); return () => ipcRenderer.removeListener('pack:progress', f); },
  makeDerived: (filePath, a, b, mode, hasAudio, id, stab) => ipcRenderer.invoke('derived:make', filePath, a, b, mode, hasAudio, id, stab),
  onDerivedProgress: (cb) => {
    const handler = (_e, value) => cb(value);
    ipcRenderer.on('derived:progress', handler);
    return () => ipcRenderer.removeListener('derived:progress', handler);
  },
  grabFrame: (filePath, t) => ipcRenderer.invoke('frame:grab', filePath, t),
  appVersion: () => ipcRenderer.invoke('app:version'),
  updateState: () => ipcRenderer.invoke('update:state'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (cb) => {
    const handler = (_e, value) => cb(value);
    ipcRenderer.on('update:status', handler);
    return () => ipcRenderer.removeListener('update:status', handler);
  },
  makeProxy: (filePath, duration, id) => ipcRenderer.invoke('proxy:make', filePath, duration, id),
  onProxyProgress: (cb) => {
    const handler = (_e, value) => cb(value);
    ipcRenderer.on('proxy:progress', handler);
    return () => ipcRenderer.removeListener('proxy:progress', handler);
  },
  onCutoutProgress: (cb) => {
    const handler = (_e, value) => cb(value);
    ipcRenderer.on('cutout:progress', handler);
    return () => ipcRenderer.removeListener('cutout:progress', handler);
  },
  onCaptionsProgress: (cb) => {
    const handler = (_e, value) => cb(value);
    ipcRenderer.on('captions:progress', handler);
    return () => ipcRenderer.removeListener('captions:progress', handler);
  },
});
