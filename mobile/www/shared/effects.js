'use strict';

// Snippy's video effects library. Each effect is written twice from the same numbers: once as a
// GLSL shader for the live preview (drawn on the graphics card) and once as FFmpeg filters for the
// export, so what you see is what you get. Shared by the editor (window.SnippyFx) and the export
// (require('./src/effects')).
//
// Every effect gets: t (seconds since the effect started), k (strength, 0 to 1), dur (its length)
// and, for the beat effects, env (a pulse that jumps to 1 on each beat and dies away) and bc (how
// many beats so far). Without music beats, the beat effects pulse at 120 beats a minute.

(function () {
  const F = (x) => (Math.round(x * 10000) / 10000).toString();

  // ----- "fields": soft light shapes (light leaks, flares, burns) worked out on a small grid and
  // stretched, in the export; the preview works out the same formulas for every pixel.
  // Formulas use u, v (0 to 1 across and down), t, k and ar (width ÷ height), and the functions
  // sin cos exp abs min max pow sqrt floor and clip(x, lo, hi).
  function fieldToGlsl(expr) {
    return expr
      .replace(/\bclip\(/g, 'clamp(')
      .replace(/(?<![\w.])(\d+)(?![\w.])/g, '$1.0');
  }
  function fieldToFf(expr, vars, x) {
    let e = expr;
    // Named parts first (they may use one another), then the inputs.
    for (let pass = 0; pass < 12; pass++) {
      const before = e;
      for (const [name, v] of Object.entries(vars)) e = e.replace(new RegExp(`\\b${name}\\b`, 'g'), `(${v})`);
      if (e === before) break;
    }
    return e
      .replace(/\bu\b/g, '((X+0.5)/W)')
      .replace(/\bv\b/g, '((Y+0.5)/H)')
      .replace(/\bt\b/g, 'T')
      .replace(/\bk\b/g, F(x.k))
      .replace(/\bar\b/g, F(x.W / x.H));
  }
  function fieldGlsl(f) {
    const lines = Object.entries(f.vars || {}).map(([n, v]) => `float ${n} = ${fieldToGlsl(v)};`);
    return `float u = uv.x; float v = uv.y;\n${lines.join('\n')}\n` +
      `vec3 fc = clamp(vec3(${fieldToGlsl(f.r)}, ${fieldToGlsl(f.g)}, ${fieldToGlsl(f.b)}), 0., 1.);\no = screen(o, fc);`;
  }
  function fieldFf(f, x) {
    const vars = f.vars || {};
    const ch = (e) => `'255*clip(${fieldToFf(e, vars, x)},0,1)'`;
    const u = x.u;
    return `format=gbrp,split[${u}a][${u}b];[${u}b]scale=96:54,format=gbrp,geq=r=${ch(f.r)}:g=${ch(f.g)}:b=${ch(f.b)},` +
      `scale=${x.W}:${x.H}:flags=bilinear,format=gbrp[${u}f];[${u}a][${u}f]blend=all_mode=screen`;
  }

  // Zoom into the middle by z (an FFmpeg expression), optionally moved by dx, dy pixels.
  const zoomCrop = (x, z, dx = '0', dy = '0') => {
    const ZW = `(trunc(${x.W}*(${z})/2)*2)`;
    const ZH = `(trunc(${x.H}*(${z})/2)*2)`;
    return `scale=w='${ZW}':h='${ZH}':eval=frame,crop=${x.W}:${x.H}:x='clip((${ZW}-${x.W})/2+(${dx}),0,${ZW}-${x.W})':y='clip((${ZH}-${x.H})/2+(${dy}),0,${ZH}-${x.H})',setsar=1`;
  };
  const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
  const smooth = (q) => `(${q}*${q}*(3-2*${q}))`;

  const CATS = [
    ['camera', 'Camera & motion'],
    ['light', 'Light & colour'],
    ['retro', 'Retro & texture'],
    ['beat', 'Party & beat'],
  ];

  // The five original effects stay as they were (drawn with CSS in the preview, fxFilters in the
  // export); they're listed here so the Effects panel shows them too.
  const CLASSIC = [
    { id: 'shake', name: 'Shake', cat: 'camera', classic: true, desc: 'A handheld wobble' },
    { id: 'glitch', name: 'Glitch', cat: 'camera', classic: true, desc: 'Colour fringes and sideways jumps' },
    { id: 'grain', name: 'Grain', cat: 'retro', classic: true, desc: 'Fine film grain' },
    { id: 'vhs', name: 'VHS', cat: 'retro', classic: true, desc: 'Old videotape' },
    { id: 'oldfilm', name: 'Old film', cat: 'retro', classic: true, desc: 'Black and white, flicker and grain' },
  ];

  const EFFECTS = [
    // ---------------- camera & motion
    {
      id: 'zoomblur', name: 'Zoom blur', cat: 'camera', desc: 'Rushing towards the middle',
      glsl: `vec3 a = vec3(0); for (int i = 0; i < 4; i++) { float s = 1. - k * .08 * float(i) / 3.; a += S((uv - .5) * s + .5); } o = a / 4.;`,
      ff: (x) => {
        const u = x.u;
        const parts = [0, 1, 2, 3].map((i) => {
          const z = 1 / (1 - (x.k * 0.08 * i) / 3);
          return i === 0 ? `[${u}0]null[${u}z0]` : `[${u}${i}]scale=${even(x.W * z)}:${even(x.H * z)},crop=${x.W}:${x.H},setsar=1[${u}z${i}]`;
        });
        return `format=gbrp,split=4[${u}0][${u}1][${u}2][${u}3];${parts.join(';')};[${u}z0][${u}z1][${u}z2][${u}z3]mix=inputs=4`;
      },
    },
    {
      id: 'sway', name: 'Sway', cat: 'camera', desc: 'A gentle rocking tilt',
      glsl: `float a = k * .06 * sin(t * 2.2); float z = 1. + k * .12; vec2 d = (uv - .5) * vec2(ar, 1.); d = mat2(cos(a), sin(a), -sin(a), cos(a)) * d; o = S(d / vec2(ar, 1.) / z + .5);`,
      ff: (x) => `scale=${even(x.W * (1 + x.k * 0.12))}:${even(x.H * (1 + x.k * 0.12))},rotate=a='${F(x.k * 0.06)}*sin(t*2.2)':ow=${x.W}:oh=${x.H}:c=black,setsar=1`,
    },
    {
      id: 'push', name: 'Slow push', cat: 'camera', desc: 'A smooth zoom in over its length',
      glsl: `float q = clamp(t / max(dur, .01), 0., 1.); float z = 1. + k * .25 * q * q * (3. - 2. * q); o = S((uv - .5) / z + .5);`,
      ff: (x) => zoomCrop(x, `1+${F(x.k * 0.25)}*${smooth(`clip(t/${F(Math.max(0.01, x.dur))},0,1)`)}`),
    },
    {
      id: 'wobble', name: 'Wobble', cat: 'camera', desc: 'Wavy, like heat haze or a dream',
      glsl: `o = S(uv + vec2(k * .012 * sin(uv.y * 20. + t * 6.) / ar, 0.));`,
      // A map of how far each row moves (worked out for one narrow column, then stretched).
      ff: (x) => {
        const u = x.u;
        const s = `${F(x.k * 0.012 * x.H)}*sin((Y+0.5)/H*20+T*6)`;
        return `format=gbrp,split=3[${u}m][${u}x][${u}y];[${u}x]scale=2:${x.H},format=gray,geq=lum='clip(128+(${s}),0,255)',scale=${x.W}:${x.H}[${u}xm];` +
          `[${u}y]scale=2:${x.H},format=gray,geq=lum=128,scale=${x.W}:${x.H}[${u}ym];[${u}m][${u}xm][${u}ym]displace=edge=smear`;
      },
    },
    {
      id: 'mirror', name: 'Mirror', cat: 'camera', desc: 'The left half reflected',
      glsl: `vec2 p = uv; if (p.x > .5) p.x = 1. - p.x; o = S(p);`,
      ff: (x) => `format=gbrp,crop=${Math.floor(x.W / 2)}:${x.H}:0:0,split[${x.u}a][${x.u}b];[${x.u}b]hflip[${x.u}c];[${x.u}a][${x.u}c]hstack,scale=${x.W}:${x.H},setsar=1`,
    },
    {
      id: 'mirror4', name: 'Mirror ×4', cat: 'camera', desc: 'Reflected four ways, like a kaleidoscope',
      glsl: `o = S(.5 - abs(uv - .5));`,
      ff: (x) => `format=gbrp,crop=${Math.floor(x.W / 2)}:${Math.floor(x.H / 2)}:0:0,split[${x.u}a][${x.u}b];[${x.u}b]hflip[${x.u}c];[${x.u}a][${x.u}c]hstack,split[${x.u}d][${x.u}e];[${x.u}e]vflip[${x.u}f];[${x.u}d][${x.u}f]vstack,scale=${x.W}:${x.H},setsar=1`,
    },
    {
      id: 'quad', name: 'Split ×4', cat: 'camera', desc: 'Four copies in a grid',
      glsl: `o = S(fract(uv * 2.));`,
      ff: (x) => `format=gbrp,scale=${Math.floor(x.W / 2)}:${Math.floor(x.H / 2)},split=4[${x.u}a][${x.u}b][${x.u}c][${x.u}d];[${x.u}a][${x.u}b]hstack[${x.u}r];[${x.u}c][${x.u}d]hstack[${x.u}s];[${x.u}r][${x.u}s]vstack,scale=${x.W}:${x.H},setsar=1`,
    },
    {
      id: 'fisheye', name: 'Fisheye', cat: 'camera', desc: 'A bulging wide lens',
      glsl: `vec2 d = (uv - .5) * vec2(ar, 1.); vec2 hd = vec2(ar, 1.) * .5; float r2 = dot(d, d) / dot(hd, hd); float m = (1. + .5 * k * r2) / (1. + .5 * k); o = SB(.5 + (uv - .5) * m);`,
      // Bent on a bigger copy, then the middle kept, so the bend never reaches past the picture's edge.
      ff: (x) => {
        const z = 1 + 0.5 * x.k;
        return `scale=${even(x.W * z)}:${even(x.H * z)},lenscorrection=k1=${F(0.5 * x.k * z * z)}:k2=0,crop=${x.W}:${x.H},setsar=1`;
      },
    },
    // ---------------- light & colour
    {
      id: 'lightleak', name: 'Light leak', cat: 'light', desc: 'Warm light drifting across',
      field: {
        vars: {
          b1: 'exp(-(pow(u-(0.18+0.22*sin(t*0.7)),2)*5+pow(v-0.3,2)*3))',
          b2: 'exp(-(pow(u-(0.82-0.2*sin(t*0.5+1)),2)*6+pow(v-0.75,2)*4))*0.85',
        },
        r: 'k*(b1+b2)', g: 'k*(0.55*b1+0.3*b2)', b: 'k*(0.15*b1+0.45*b2)',
      },
    },
    {
      id: 'flare', name: 'Lens flare', cat: 'light', desc: 'A sun flare sliding past',
      field: {
        vars: {
          fx0: '0.2+0.6*(0.5+0.5*sin(t*0.35))',
          fy0: '0.22+0.05*sin(t*0.5)',
          dx: '(u-fx0)*ar',
          dy: 'v-fy0',
          d2: 'dx*dx+dy*dy',
          core: 'exp(-d2*90)',
          halo: 'exp(-d2*7)*0.35',
          streak: 'exp(-dy*dy*500)*exp(-dx*dx*0.8)*0.45',
          ghost: 'exp(-(pow((u-(1-fx0))*ar,2)+pow(v-(1-fy0),2))*40)*0.25',
        },
        r: 'k*(core+halo+streak+ghost*0.6)', g: 'k*(core*0.95+halo*0.8+streak*0.85+ghost*0.9)', b: 'k*(core*0.8+halo*0.5+streak*0.95+ghost)',
      },
    },
    {
      id: 'glow', name: 'Glow', cat: 'light', desc: 'Bright parts bloom with light',
      glsl: `vec3 b = max(o - .55, 0.) * 2.2 * .2; float sg = .012; float wsum = .2;
        for (int r = 1; r <= 3; r++) for (int i = 0; i < 8; i++) { float an = float(i) * .785398 + float(r) * .3; float rr = sg * (float(r) - .5); float w = exp(-(float(r) - .5) * (float(r) - .5) / 2.) * .1;
          b += max(S(uv + vec2(cos(an) * rr / ar, sin(an) * rr)) - .55, 0.) * 2.2 * w; wsum += w; }
        b /= wsum; o = mix(o, screen(o, b), k);`,
      ff: (x) => `format=gbrp,split[${x.u}a][${x.u}b];[${x.u}b]lutrgb=r='min(255,max(0,val-140)*2.2)':g='min(255,max(0,val-140)*2.2)':b='min(255,max(0,val-140)*2.2)',gblur=sigma=${F(x.H * 0.012)}[${x.u}c];[${x.u}a][${x.u}c]blend=all_mode=screen:all_opacity=${F(x.k)}`,
    },
    {
      id: 'neon', name: 'Neon edges', cat: 'light', desc: 'Glowing coloured outlines',
      glsl: `vec3 e = clamp(sobelRGB(uv) * 2.5, 0., 1.); o = screen(o * (1. - k) * .35, e);`,
      ff: (x) => `format=gbrp,split[${x.u}a][${x.u}b];[${x.u}b]sobel=scale=2.5[${x.u}e];[${x.u}a]colorchannelmixer=rr=${F((1 - x.k) * 0.35)}:gg=${F((1 - x.k) * 0.35)}:bb=${F((1 - x.k) * 0.35)}[${x.u}d];[${x.u}d][${x.u}e]blend=all_mode=screen`,
    },
    {
      id: 'rainbow', name: 'Rainbow', cat: 'light', desc: 'Colours cycling through the rainbow',
      glsl: `o = hueRot(o, t * k * 180.);`,
      ff: (x) => `hue=h='t*${F(x.k * 180)}'`,
    },
    {
      id: 'strobe', name: 'Strobe', cat: 'light', desc: 'Fast flashes of light',
      glsl: `o += k * .6 * step(mod(t, .25), .06);`,
      ff: (x) => `eq=brightness='${F(x.k * 0.6)}*lt(mod(t,0.25),0.06)':eval=frame`,
    },
    {
      id: 'redpop', name: 'Red pop', cat: 'light', desc: 'Black and white, except for reds',
      glsl: `vec3 key = vec3(.816, .157, .157); float sim = .2 + .2 * k; float df = length(o - key) / sqrt(3.); float keep = 1. - clamp((df - sim) / .1, 0., 1.); float g = (o.r + o.g + o.b) / 3.; o = g + (o - g) * keep;`,
      ff: (x) => `format=gbrp,colorhold=color=0xD02828:similarity=${F(0.2 + 0.2 * x.k)}:blend=0.1`,
    },
    {
      id: 'noir', name: 'Noir', cat: 'light', desc: 'Moody, high-contrast black and white',
      glsl: `float y = luma(o); y = (y - .5) * (1. + .5 * k) + .5; o = vec3(y) * vig(uv, 3.14159 / 4.);`,
      ff: (x) => `hue=s=0,eq=contrast=${F(1 + 0.5 * x.k)},vignette=angle=PI/4`,
    },
    {
      id: 'duotone', name: 'Duotone', cat: 'light', desc: 'Purple shadows, golden highlights',
      glsl: `float y = luma(o); vec3 dk = vec3(.18, .05, .38); vec3 lt = vec3(1., .78, .38); o = mix(o, dk + (lt - dk) * y, k);`,
      ff: (x) => {
        const ch = (d, l) => `'${F(d * 255)}+${F(l - d)}*val'`;
        return `split[${x.u}a][${x.u}b];[${x.u}b]hue=s=0,format=gbrp,lutrgb=r=${ch(0.18, 1)}:g=${ch(0.05, 0.78)}:b=${ch(0.38, 0.38)}[${x.u}c];[${x.u}a]format=gbrp[${x.u}d];[${x.u}c][${x.u}d]mix=inputs=2:weights='${F(x.k)} ${F(1 - x.k)}'`;
      },
    },
    // ---------------- retro & texture
    {
      id: 'filmburn', name: 'Film burn', cat: 'retro', desc: 'Orange burns flaring at the edge',
      field: {
        vars: {
          ee: '0.5+0.5*sin(t*1.3)',
          fl: '0.85+0.15*sin(t*23)',
          bb: 'exp(-(pow(u-(1.08-0.3*ee+0.04*sin(t*5.1)),2)*3.5+pow(v-0.55,2)*1.2))*fl',
          b2: 'exp(-(pow(u+0.05-0.15*(0.5+0.5*sin(t*0.9+2)),2)*6+pow(v-0.2,2)*2))*0.7',
        },
        r: 'k*min(1,(bb+b2)*1.5)', g: 'k*(0.35*(bb+b2)+0.6*pow(bb,4))', b: 'k*(0.05*(bb+b2)+0.3*pow(bb,6))',
      },
    },
    {
      id: 'dust', name: 'Dust & scratches', cat: 'retro', desc: 'Specks and scratches on old film',
      glsl: `float n = floor(t * 24.); float wpx = max(1., res.y / 600.) / res.x;
        float y0 = luma(o); o = mix(vec3(y0), o, .8);
        if (mod(n * .31, 1.) < .6) { float x1 = mod(n * .7548776662 + .13, 1.); if (abs(uv.x - x1) < wpx) o = mix(o, vec3(1.), .25 * k); }
        if (mod(n * .43, 1.) < .4) { float x2 = mod(n * .5698402910 + .61, 1.); if (abs(uv.x - x2) < wpx) o = mix(o, vec3(1.), .25 * k); }
        for (int i = 0; i < 6; i++) { float fi = float(i); if (mod(n * (.37 + fi * .11), 1.) < .5) {
          vec2 c = vec2(mod(n * (.6180339 + fi * .0731) + fi * .17, 1.), mod(n * (.4142135 + fi * .0517) + fi * .29, 1.));
          vec2 sz = vec2(max(2., res.y / 270.) / res.x, max(2., res.y / 270.) / res.y);
          if (uv.x >= c.x && uv.x < c.x + sz.x && uv.y >= c.y && uv.y < c.y + sz.y) o = mix(o, vec3(0.), .5 * k); } }
        o += (hash(uv * res + t * 61.) - .5) * 16. * k / 255.;`,
      ff: (x) => {
        const N = 'floor(t*24)';
        const w = Math.max(1, Math.round(x.H / 600));
        const sz = Math.max(2, Math.round(x.H / 270));
        const parts = ['eq=saturation=0.8'];
        parts.push(`drawbox=x='iw*mod(${N}*0.7548776662+0.13,1)':y=0:w=${w}:h=ih:color=white@${F(0.25 * x.k)}:t=fill:enable='lt(mod(${N}*0.31,1),0.6)'`);
        parts.push(`drawbox=x='iw*mod(${N}*0.5698402910+0.61,1)':y=0:w=${w}:h=ih:color=white@${F(0.25 * x.k)}:t=fill:enable='lt(mod(${N}*0.43,1),0.4)'`);
        for (let i = 0; i < 6; i++) {
          parts.push(`drawbox=x='iw*mod(${N}*${F(0.6180339 + i * 0.0731)}+${F(i * 0.17)},1)':y='ih*mod(${N}*${F(0.4142135 + i * 0.0517)}+${F(i * 0.29)},1)':w=${sz}:h=${sz}:color=black@${F(0.5 * x.k)}:t=fill:enable='lt(mod(${N}*${F(0.37 + i * 0.11)},1),0.5)'`);
        }
        parts.push(`noise=alls=${Math.max(1, Math.round(8 * x.k))}:allf=t`);
        return parts.join(',');
      },
    },
    {
      id: 'super8', name: '8mm film', cat: 'retro', desc: 'Warm home-movie film with flicker',
      glsl: `vec2 p = (uv - .5) / 1.05 + .5 + vec2(0., .004 * k * sin(t * 13.7) / 1.05); o = S(p);
        o *= vec3(1. + .08 * k, 1. - .03 * k, 1. - .22 * k);
        o += .035 * k * sin(t * 31.) + .02 * k * sin(t * 17.3);
        float y = luma(o); o = mix(vec3(y), o, 1. - .25 * k);
        o *= vig(uv, 3.14159 / 4.2);
        o += (hash(uv * res + t * 53.) - .5) * 36. * k / 255.;`,
      ff: (x) => `colorchannelmixer=rr=${F(1 + 0.08 * x.k)}:gg=${F(1 - 0.03 * x.k)}:bb=${F(1 - 0.22 * x.k)},` +
        `eq=brightness='${F(0.035 * x.k)}*sin(t*31)+${F(0.02 * x.k)}*sin(t*17.3)':saturation=${F(1 - 0.25 * x.k)}:eval=frame,` +
        `${zoomCrop(x, '1.05', '0', `${F(x.H * 1.05 * 0.004 * x.k)}*sin(t*13.7)`)},vignette=angle=PI/4.2,noise=alls=${Math.max(1, Math.round(18 * x.k))}:allf=t+u`,
    },
    {
      id: 'crt', name: 'CRT TV', cat: 'retro', desc: 'A curved old TV with scanlines',
      glsl: `vec2 d = (uv - .5) * vec2(ar, 1.); vec2 hd = vec2(ar, 1.) * .5; float r2 = dot(d, d) / dot(hd, hd);
        vec2 p = .5 + (uv - .5) * (1. + .15 * k * r2); float sh = max(1., floor(res.y / 540. + .5)) / res.x;
        o = vec3(SB(p + vec2(sh, 0.)).r, SB(p).g, SB(p - vec2(sh, 0.)).b);
        float y = luma(o); o = mix(vec3(y), o, 1.2) + .04;
        float per = max(3., floor(4. * res.y / 1080. + .5)); if (mod(uv.y * res.y, per) < max(1., floor(per / 3. + .5))) o *= .7;
        o *= vig(uv, 3.14159 / 4.);`,
      ff: (x) => {
        const per = Math.max(3, Math.round((4 * x.H) / 1080));
        const R = Math.max(1, Math.round(x.H / 540));
        return `format=gbrp,lenscorrection=k1=${F(0.15 * x.k)}:k2=0,rgbashift=rh=-${R}:bh=${R},format=yuv420p,eq=saturation=1.2:brightness=0.04,` +
          `drawgrid=w=iw:h=${per}:t=${Math.max(1, Math.round(per / 3))}:c=black@0.3,vignette=angle=PI/4`;
      },
    },
    {
      id: 'pixel', name: '8-bit', cat: 'retro', desc: 'Chunky pixels and fewer colours',
      glsl: `float rows = floor(70. - 45. * k + .5); vec2 n = vec2(floor(rows * ar + .5), rows); o = S((floor(uv * n) + .5) / n); o = min(vec3(1.), floor(o * 255. / 64.) * 85. / 255.);`,
      ff: (x) => {
        const rows = Math.round(70 - 45 * x.k);
        const cols = Math.round((rows * x.W) / x.H);
        return `scale=${cols}:${rows}:flags=area,scale=${x.W}:${x.H}:flags=neighbor,format=gbrp,lutrgb=r='min(255,floor(val/64)*85)':g='min(255,floor(val/64)*85)':b='min(255,floor(val/64)*85)'`;
      },
    },
    {
      id: 'halftone', name: 'Halftone', cat: 'retro', desc: 'Printed newspaper dots',
      glsl: `float cells = 110. - 60. * k; float s = res.y / cells; vec2 P = uv * res;
        float a = (P.x + P.y) * .70710678 / s; float b = (P.x - P.y) * .70710678 / s;
        float fa = a - floor(a) - .5; float fb = b - floor(b) - .5; float r = sqrt(fa * fa + fb * fb);
        float rad = .72 * sqrt(max(0., 1. - luma(o))); o = vec3(r < rad ? 25. / 255. : 235. / 255.);`,
      // The dot screen never changes, so it's worked out once and compared with each frame.
      ff: (x) => {
        const s = F(x.H / (110 - 60 * x.k));
        const a = `((X+Y)*0.70710678/${s})`;
        const b = `((X-Y)*0.70710678/${s})`;
        const fa = `(${a}-floor(${a})-0.5)`;
        const fb = `(${b}-floor(${b})-0.5)`;
        const u = x.u;
        const frames = Math.ceil((x.dur + 1) * (x.fps || 30)) + 2;
        return `format=gray,split=4[${u}a][${u}b][${u}c][${u}d];[${u}b]trim=end_frame=1,geq=lum='clip(255*(1-(${fa}*${fa}+${fb}*${fb})/0.5184),0,255)',loop=loop=${frames}:size=1[${u}t];` +
          `[${u}c]lutyuv=y=25[${u}lo];[${u}d]lutyuv=y=235[${u}hi];[${u}a][${u}t][${u}lo][${u}hi]threshold,format=gbrp`;
      },
    },
    {
      id: 'comic', name: 'Comic', cat: 'retro', desc: 'Bold colours with inked outlines',
      glsl: `float y = luma(o); o = clamp(mix(vec3(y), o, 1.5), 0., 1.); o = min(vec3(1.), (floor(o * 255. / 51.) * 51. + 25.) / 255.);
        o *= 1. - clamp(sobelL(uv) * (1. + 3. * k), 0., 1.);`,
      ff: (x) => `split[${x.u}a][${x.u}b];[${x.u}a]eq=saturation=1.5,format=gbrp,lutrgb=r='min(255,floor(val/51)*51+25)':g='min(255,floor(val/51)*51+25)':b='min(255,floor(val/51)*51+25)'[${x.u}p];` +
        `[${x.u}b]format=gray,sobel=scale=${F(1 + 3 * x.k)},negate,format=gbrp[${x.u}e];[${x.u}p][${x.u}e]blend=all_mode=multiply`,
    },
    {
      id: 'sketch', name: 'Sketch', cat: 'retro', desc: 'A pencil drawing',
      glsl: `o = vec3(1. - clamp(sobelL(uv) * (2. + 3. * k), 0., 1.));`,
      ff: (x) => `format=gray,sobel=scale=${F(2 + 3 * x.k)},negate,format=gbrp`,
    },
    // ---------------- party & beat (env: the beat pulse; bc: beats so far)
    {
      id: 'beatflash', name: 'Beat flash', cat: 'beat', beat: true, desc: 'A flash of light on every beat',
      glsl: `o += k * .5 * env;`,
      ff: (x) => `eq=brightness='${F(x.k * 0.5)}*(${x.E})':eval=frame`,
    },
    {
      id: 'beatzoom', name: 'Beat zoom', cat: 'beat', beat: true, desc: 'Punches in on every beat',
      glsl: `float z = 1. + k * .12 * env; o = S((uv - .5) / z + .5);`,
      ff: (x) => zoomCrop(x, `1+${F(x.k * 0.12)}*(${x.E})`),
    },
    {
      id: 'beatshake', name: 'Beat shake', cat: 'beat', beat: true, desc: 'Shakes on every beat',
      glsl: `vec2 off = vec2(.03 * k * env * sin(t * 53.) / ar, .025 * k * env * cos(t * 47.)); o = S((uv - .5) / 1.08 + .5 + off / 1.08);`,
      ff: (x) => zoomCrop(x, '1.08', `${F(x.H * 0.03 * x.k)}*(${x.E})*sin(t*53)`, `${F(x.H * 0.025 * x.k)}*(${x.E})*cos(t*47)`),
    },
    {
      id: 'beatsplit', name: 'RGB split', cat: 'beat', beat: true, desc: 'Colours split apart on the beat',
      glsl: `float s = .02 * k * env / ar; o = vec3(S(uv - vec2(s, 0.)).r, o.g, S(uv + vec2(s, 0.)).b);`,
      ff: (x) => {
        const M = Math.ceil(x.H * 0.025) + 2;
        const s = `${F(x.H * 0.02 * x.k)}*(${x.E})`;
        const u = x.u;
        return `format=gbrp,split=3[${u}o][${u}r][${u}b];` +
          `[${u}r]pad=${x.W + 2 * M}:${x.H}:${M}:0,crop=${x.W}:${x.H}:x='${M}-(${s})':y=0[${u}r2];` +
          `[${u}b]pad=${x.W + 2 * M}:${x.H}:${M}:0,crop=${x.W}:${x.H}:x='${M}+(${s})':y=0[${u}b2];` +
          `[${u}o][${u}b2][${u}r2]mergeplanes=0x001122:gbrp`;
      },
    },
    {
      id: 'beathue', name: 'Colour jump', cat: 'beat', beat: true, desc: 'The colours jump on every beat',
      glsl: `o = hueRot(o, k * 72. * bc);`,
      ff: (x) => `hue=h='${F(x.k * 72)}*(${x.BC})'`,
    },
  ];

  const ALL = [...EFFECTS, ...CLASSIC];
  const byId = Object.fromEntries(ALL.map((e) => [e.id, e]));
  const isNew = (id) => Boolean(id && byId[id] && !byId[id].classic);
  const DEFAULT_K = 0.7;

  // ----- the beat pulse, from beat times (seconds from the effect's start)
  const PULSE = 9;
  function beatList(beats, dur) {
    return (beats || []).filter((b) => b > -1 && b < dur + 0.01).slice(0, 400);
  }
  function envAt(beats, t) {
    if (!beats || !beats.length) return Math.exp(-((t % 0.5 + 0.5) % 0.5) * PULSE);
    let e = 0;
    for (const b of beats) if (t >= b) e += Math.exp(-(t - b) * PULSE);
    return Math.min(1, e);
  }
  function countAt(beats, t) {
    if (!beats || !beats.length) return Math.floor(t / 0.5) + 1;
    let n = 0;
    for (const b of beats) if (t >= b) n++;
    return n;
  }
  function envExpr(beats) {
    if (!beats || !beats.length) return `exp(-mod(t,0.5)*${PULSE})`;
    return `min(1,${beats.map((b) => `gte(t,${F(b)})*exp(-(t-${F(b)})*${PULSE})`).join('+')})`;
  }
  function countExpr(beats) {
    if (!beats || !beats.length) return '(floor(t/0.5)+1)';
    return `(${beats.map((b) => `gte(t,${F(b)})`).join('+')})`;
  }

  // ----- export: the FFmpeg filters for one effect on a W×H picture (to go in a filter chain,
  // starting with a comma). opts: { k, dur, beats, tag }.
  function ffChain(id, W, H, opts = {}) {
    const e = byId[id];
    if (!e || e.classic) return '';
    const x = {
      W, H, k: opts.k ?? DEFAULT_K, dur: opts.dur || 1, u: opts.tag || 'fx', fps: opts.fps || 30,
      E: envExpr(opts.beats), BC: countExpr(opts.beats),
    };
    const chain = e.field ? fieldFf(e.field, x) : e.ff(x);
    return `,${chain},format=yuv420p,setsar=1`;
  }

  // ----- preview: one shader with every effect in it
  function shaderSource() {
    const branches = EFFECTS.map((e, i) => `${i ? 'else ' : ''}if (fx == ${i + 1}) {\n${e.field ? fieldGlsl(e.field) : e.glsl}\n}`).join('\n');
    return `#version 300 es
precision highp float;
in vec2 uv; out vec4 outc;
uniform sampler2D img; uniform int fx; uniform float t, k, env, bc, dur, ar, flip; uniform vec2 res;
// uv runs down the picture (like FFmpeg's Y); a picture drawn by an earlier pass is stored upside down.
vec2 tc(vec2 p) { return flip > .5 ? vec2(p.x, 1. - p.y) : p; }
vec3 S(vec2 p) { return texture(img, tc(clamp(p, 0., 1.))).rgb; }
vec3 SB(vec2 p) { return (p.x < 0. || p.y < 0. || p.x > 1. || p.y > 1.) ? vec3(0.) : texture(img, tc(p)).rgb; }
float luma(vec3 c) { return dot(c, vec3(.299, .587, .114)); }
vec3 screen(vec3 a, vec3 b) { return 1. - (1. - a) * (1. - b); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float vig(vec2 p, float ang) { vec2 d = (p - .5) * vec2(ar, 1.); float r = length(d) / length(vec2(ar, 1.) * .5); if (r > 1.) return 0.; float c = cos(ang * r); return c * c * c * c; }
vec3 hueRot(vec3 c, float deg) {
  float y = luma(c); float cb = (c.b - y) * .564; float cr = (c.r - y) * .713;
  float a = radians(deg); float s = sin(a); float co = cos(a);
  float u2 = cb * co - cr * s; float v2 = cb * s + cr * co;
  return vec3(y + 1.403 * v2, y - .344 * u2 - .714 * v2, y + 1.773 * u2);
}
vec3 sobelRGB(vec2 p) {
  vec2 q = 1. / res;
  vec3 a = S(p + q * vec2(-1, -1)), b = S(p + q * vec2(0, -1)), c = S(p + q * vec2(1, -1));
  vec3 d = S(p + q * vec2(-1, 0)), f = S(p + q * vec2(1, 0));
  vec3 g = S(p + q * vec2(-1, 1)), h = S(p + q * vec2(0, 1)), i = S(p + q * vec2(1, 1));
  vec3 gx = (c + 2. * f + i) - (a + 2. * d + g); vec3 gy = (g + 2. * h + i) - (a + 2. * b + c);
  return sqrt(gx * gx + gy * gy);
}
float sobelL(vec2 p) { return luma(sobelRGB(p)); }
void main() {
  vec3 o = S(uv);
${branches}
  outc = vec4(clamp(o, 0., 1.), 1.);
}`;
  }
  const shaderIndex = (id) => EFFECTS.findIndex((e) => e.id === id) + 1;

  const api = { CATS, EFFECTS, ALL, byId, isNew, DEFAULT_K, beatList, envAt, countAt, envExpr, countExpr, ffChain, shaderSource, shaderIndex };
  if (typeof module !== 'undefined') module.exports = api;
  if (typeof window !== 'undefined') window.SnippyFx = api;
}());
