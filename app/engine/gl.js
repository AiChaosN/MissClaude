// Sprite renderers. Sprites are drawn as quads in their own pixel space and mapped
// to window CSS pixels by a 2D affine matrix. The WebGL2 renderer's fragment shader
// can warp the lookup with a per-sprite "sway" weight map so the hair drifts;
// Renderer2D (bottom) is the fallback when WebGL is not available.

const VERT = `#version 300 es
in vec2 aPos;
uniform vec4 uRect;        // drawn rect inside sprite space: x, y, w, h (px)
uniform vec2 uSpriteSize;  // full sprite size (px), for the sway map lookup
uniform mat3 uModel;       // sprite px -> window css px
uniform vec2 uView;        // window css size
out vec2 vUV;
out vec2 vSpriteUV;
void main() {
  vec2 p = uRect.xy + aPos * uRect.zw;
  vUV = aPos;
  vSpriteUV = p / uSpriteSize;
  vec2 c = (uModel * vec3(p, 1.0)).xy / uView * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform sampler2D uSway;
uniform float uUseSway;
uniform float uTime;
uniform vec2 uSwayAmp;     // peak displacement in texture uv
uniform float uSwayBias;   // constant drift (wind / motion), uv
uniform float uOpacity;
in vec2 vUV;
in vec2 vSpriteUV;
out vec4 outColor;
void main() {
  vec2 uv = vUV;
  if (uUseSway > 0.5) {
    float w = texture(uSway, vSpriteUV).r;
    float y = vSpriteUV.y;
    float ph = uTime * 1.9 - y * 6.0;
    float wave = 0.65 * sin(ph) + 0.35 * sin(uTime * 3.1 - y * 10.0 + 1.3);
    uv -= vec2(uSwayAmp.x * wave + uSwayBias, uSwayAmp.y * cos(ph)) * w;
  }
  outColor = texture(uTex, uv) * uOpacity;
}`;

// Rig layers: vertex positions are skinned on the CPU and arrive in css px. A layer
// can be clipped by a mask texture (eye openings for the irises), looked up with its
// own per-vertex coordinates.
const MESH_VERT = `#version 300 es
in vec2 aPos;
in vec2 aUV;
in vec2 aMaskUV;
uniform vec2 uView;
out vec2 vUV;
out vec2 vMaskUV;
void main() {
  vUV = aUV;
  vMaskUV = aMaskUV;
  vec2 c = aPos / uView * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`;

const MESH_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform sampler2D uMask;
uniform float uUseMask;
uniform float uOpacity;
in vec2 vUV;
in vec2 vMaskUV;
out vec4 outColor;
void main() {
  float m = uUseMask > 0.5 ? texture(uMask, vMaskUV).a : 1.0;
  outColor = texture(uTex, vUV) * uOpacity * m;
}`;

function program(gl, vert, frag) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vert));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  return prog;
}

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(sh));
  }
  return sh;
}

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}

// 2D affine as [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f
export const affine = {
  identity: () => [1, 0, 0, 1, 0, 0],
  mul(m, n) { // m * n (apply n first)
    return [
      m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
    ];
  },
  translate: (x, y) => [1, 0, 0, 1, x, y],
  scale: (sx, sy) => [sx, 0, 0, sy, 0, 0],
  rotate(r) { const c = Math.cos(r), s = Math.sin(r); return [c, s, -s, c, 0, 0]; },
  invert(m) {
    const det = m[0] * m[3] - m[1] * m[2];
    const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
    return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
  },
  apply: (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]],
};

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    this.canvas = canvas;
    const prog = program(gl, VERT, FRAG);
    this.prog = prog;
    this.u = {};
    for (const name of ['uRect', 'uSpriteSize', 'uModel', 'uView', 'uTex', 'uSway', 'uUseSway',
      'uTime', 'uSwayAmp', 'uSwayBias', 'uOpacity']) {
      this.u[name] = gl.getUniformLocation(prog, name);
    }
    const vao = gl.createVertexArray();
    this.quadVao = vao;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.useProgram(prog);
    gl.uniform1i(this.u.uTex, 0);
    gl.uniform1i(this.u.uSway, 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // textures are premultiplied
    this.meshProg = program(gl, MESH_VERT, MESH_FRAG);
    this.mu = {};
    for (const name of ['uView', 'uTex', 'uMask', 'uUseMask', 'uOpacity']) {
      this.mu[name] = gl.getUniformLocation(this.meshProg, name);
    }
    this.current = 'quad';
    this.blank = this.texture(null);
    this.view = [1, 1];
    this.kind = 'webgl';
  }

  use(which) {
    if (this.current === which) return;
    const gl = this.gl;
    if (which === 'quad') {
      gl.useProgram(this.prog);
      gl.bindVertexArray(this.quadVao);
    } else {
      gl.useProgram(this.meshProg);
    }
    this.current = which;
  }

  // GPU buffers for one grid mesh: static uv + indices, positions rewritten per frame
  createMesh(uv, idx) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const pos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pos);
    gl.bufferData(gl.ARRAY_BUFFER, uv.byteLength, gl.DYNAMIC_DRAW);
    const posLoc = gl.getAttribLocation(this.meshProg, 'aPos');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    const uvBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    const uvLoc = gl.getAttribLocation(this.meshProg, 'aUV');
    gl.enableVertexAttribArray(uvLoc);
    gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 0, 0);
    const maskBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, maskBuf);
    gl.bufferData(gl.ARRAY_BUFFER, uv.byteLength, gl.DYNAMIC_DRAW);
    const maskLoc = gl.getAttribLocation(this.meshProg, 'aMaskUV');
    gl.enableVertexAttribArray(maskLoc);
    gl.vertexAttribPointer(maskLoc, 2, gl.FLOAT, false, 0, 0);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(this.current === 'quad' ? this.quadVao : null);
    return { vao, pos, maskBuf, count: idx.length };
  }

  // mask: optional {tex, uv} clipping the layer (uv: per-vertex mask coordinates)
  drawMesh(mesh, tex, positions, opacity = 1, mask = null) {
    const gl = this.gl;
    this.use('mesh');
    gl.bindVertexArray(mesh.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.pos);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions);
    gl.uniform2f(this.mu.uView, this.view[0], this.view[1]);
    gl.uniform1i(this.mu.uTex, 0);
    gl.uniform1i(this.mu.uMask, 1);
    gl.uniform1f(this.mu.uOpacity, opacity);
    gl.uniform1f(this.mu.uUseMask, mask ? 1 : 0);
    if (mask) {
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.maskBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, mask.uv);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, mask.tex);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
  }

  texture(img, { mipmap = true } = {}) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    if (img) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (img && mipmap) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    return tex;
  }

  resize(cssW, cssH, dpr) {
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.view = [cssW, cssH];
    this.dpr = dpr;
  }

  // only draw between x0 and x1 (css px; either may be null for no bound); clipX() turns it off
  clipX(x0 = null, x1 = null) {
    const gl = this.gl;
    if (x0 == null && x1 == null) {
      gl.disable(gl.SCISSOR_TEST);
      return;
    }
    const d = this.dpr || 1;
    const a = Math.max(0, Math.min(this.canvas.width, Math.round((x0 ?? 0) * d)));
    const b = Math.max(a, Math.min(this.canvas.width, Math.round((x1 ?? Infinity) * d)));
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(a, 0, b - a, this.canvas.height);
  }

  clear() {
    const gl = this.gl;
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  // Draw `tex` covering `rect` (x, y, w, h) of a sprite of size spriteW x spriteH.
  draw(tex, model, { rect, spriteW, spriteH, sway = null, swayAmp = [0, 0], swayBias = 0,
    time = 0, opacity = 1 }) {
    const gl = this.gl;
    this.use('quad');
    const m = model;
    gl.uniformMatrix3fv(this.u.uModel, false, [m[0], m[1], 0, m[2], m[3], 0, m[4], m[5], 1]);
    gl.uniform2f(this.u.uView, this.view[0], this.view[1]);
    gl.uniform4f(this.u.uRect, rect[0], rect[1], rect[2], rect[3]);
    gl.uniform2f(this.u.uSpriteSize, spriteW, spriteH);
    gl.uniform1f(this.u.uUseSway, sway ? 1 : 0);
    gl.uniform1f(this.u.uTime, time);
    gl.uniform2f(this.u.uSwayAmp, swayAmp[0], swayAmp[1]);
    gl.uniform1f(this.u.uSwayBias, swayBias);
    gl.uniform1f(this.u.uOpacity, opacity);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, sway || this.blank);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

// Low-res copy of a sprite's alpha channel for hit testing.
export function alphaMask(img, step = 3) {
  const w = Math.ceil(img.width / step), h = Math.ceil(img.height / step);
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const a = new Uint8Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = data[i * 4 + 3];
  return {
    step, w, h, a,
    at(x, y) {
      const i = Math.floor(x / step), j = Math.floor(y / step);
      if (i < 0 || j < 0 || i >= w || j >= h) return 0;
      return a[j * w + i];
    },
  };
}

// Fallback with the same interface on a 2D canvas, for machines or sessions where
// WebGL is unavailable or its GPU process keeps dying. No hair sway; the rest
// (transforms, breathing, face patches) looks the same.
export class Renderer2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.kind = '2d';
  }

  texture(img) {
    return img;
  }

  resize(cssW, cssH, dpr) {
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dpr = dpr;
  }

  clipX(x0 = null, x1 = null) {
    const ctx = this.ctx;
    if (this.clipped) {
      ctx.restore();
      this.clipped = false;
    }
    if (x0 == null && x1 == null) return;
    const a = (x0 ?? 0) * this.dpr;
    const b = x1 == null ? this.canvas.width : x1 * this.dpr;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(a, 0, Math.max(0, b - a), this.canvas.height);
    ctx.clip();
    this.clipped = true;
  }

  clear() {
    this.clipX();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  draw(img, m, { rect, opacity = 1 }) {
    if (!img) return;
    const d = this.dpr;
    const ctx = this.ctx;
    ctx.setTransform(m[0] * d, m[1] * d, m[2] * d, m[3] * d, m[4] * d, m[5] * d);
    ctx.globalAlpha = opacity;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, rect[0], rect[1], rect[2], rect[3]);
    ctx.globalAlpha = 1;
  }
}
