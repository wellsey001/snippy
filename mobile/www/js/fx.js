'use strict';
// Effects on the graphics card: every effect in the library is one shader (shared/effects.js).
// run(source, passes) draws the source through each effect in turn and returns a canvas.

class FxRunner {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    if (!this.gl) return;
    const gl = this.gl;
    const vs = '#version 300 es\nin vec2 p; out vec2 uv; void main() { uv = vec2(p.x * .5 + .5, .5 - p.y * .5); gl_Position = vec4(p, 0, 1); }';
    const sh = (type, src) => { const x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) console.error('[fx]', gl.getShaderInfoLog(x)); return x; };
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, SnippyFx.shaderSource()));
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) { console.error('[fx]', gl.getProgramInfoLog(pr)); this.gl = null; return; }
    gl.useProgram(pr);
    this.u = {};
    for (const n of ['img', 'fx', 't', 'k', 'env', 'bc', 'dur', 'ar', 'res', 'flip']) this.u[n] = gl.getUniformLocation(pr, n);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = () => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      return t;
    };
    this.srcTex = tex();
    this.pp = [0, 1].map(() => ({ tex: tex(), fb: gl.createFramebuffer(), w: 0, h: 0 }));
  }

  get ok() { return Boolean(this.gl); }

  // passes: [{ id, t, k, dur, env, bc }]. The source must be a canvas the size wanted out.
  run(src, passes) {
    const gl = this.gl;
    const cw = src.width;
    const ch = src.height;
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.uniform1i(this.u.img, 0);
    gl.uniform2f(this.u.res, cw, ch);
    gl.uniform1f(this.u.ar, cw / ch);
    let input = this.srcTex;
    passes.forEach((p, i) => {
      const last = i === passes.length - 1;
      const target = last ? null : this.pp[i % 2];
      if (target && (target.w !== cw || target.h !== ch)) {
        gl.bindTexture(gl.TEXTURE_2D, target.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cw, ch, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.tex, 0);
        target.w = cw; target.h = ch;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
      gl.viewport(0, 0, cw, ch);
      gl.bindTexture(gl.TEXTURE_2D, input);
      gl.uniform1f(this.u.flip, i > 0 ? 1 : 0);
      gl.uniform1i(this.u.fx, SnippyFx.shaderIndex(p.id));
      gl.uniform1f(this.u.t, p.t);
      gl.uniform1f(this.u.k, p.k);
      gl.uniform1f(this.u.dur, p.dur);
      gl.uniform1f(this.u.env, p.env);
      gl.uniform1f(this.u.bc, p.bc);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (target) input = target.tex;
    });
    return this.canvas;
  }
}

// The five original effects (made for the desktop's CSS preview) drawn on a 2D canvas instead.
function classicFx(ctx, id, W, H, t) {
  if (id === 'grain' || id === 'vhs' || id === 'oldfilm') {
    // A small tile of noise, repeated: cheap enough for every frame.
    if (!classicFx.noise) classicFx.noise = document.createElement('canvas');
    const n = classicFx.noise;
    n.width = 128; n.height = 128;
    const g = n.getContext('2d');
    const d = g.createImageData(128, 128);
    for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() * 255; d.data[i] = v; d.data[i + 1] = v; d.data[i + 2] = v; d.data[i + 3] = 255; }
    g.putImageData(d, 0, 0);
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = id === 'vhs' ? 0.12 : 0.22;
    ctx.fillStyle = ctx.createPattern(n, 'repeat');
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    if (id === 'vhs') {
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = '#000';
      const step = Math.max(3, Math.round(H / 270));
      for (let y = 0; y < H; y += step) ctx.fillRect(0, y, W, 1);
      ctx.restore();
    }
    if (id === 'oldfilm') {
      ctx.save();
      const gr = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) / 2);
      gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.55)');
      ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  }
}
// Per-frame canvas filters for the classic effects (applied while the clip is drawn).
function classicFilter(id, t) {
  if (id === 'vhs') return 'saturate(1.35) contrast(1.08)';
  if (id === 'oldfilm') return `grayscale(1) contrast(1.1) brightness(${(1 + 0.04 * Math.sin(t * 31)).toFixed(3)})`;
  if (id === 'glitch') return t % 1.7 < 0.15 ? 'saturate(1.6) hue-rotate(-20deg)' : '';
  return '';
}
function classicOffset(id, t, H) {
  if (id === 'shake') return [H * 0.006 * Math.sin(t * 37), H * 0.006 * Math.cos(t * 29)];
  if (id === 'glitch' && t % 1.7 < 0.15) return [H * 0.02 * Math.sin(t * 90), 0];
  return [0, 0];
}
