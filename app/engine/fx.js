// Particle effects on a 2D canvas over the sprite. Shapes and colours follow the
// decorations of the original chibi art (orange five-petal flowers, petals, gold
// sparkles) plus manga marks for her moods: anger vein, sweat drop, ? and !, music
// notes, steam puffs, an idea bulb, gloom lines. makeLightLine() paints the line of
// light her desk opens out of; the renderer draws it between the furniture and her.

const COLORS = {
  petal: ['#f6a27c', '#f08a5d', '#f9b996'],
  flower: ['#f08a5d', '#f6a27c'],
  sparkle: ['#e9b85a', '#f3cf7a'],
  heart: ['#ff7f9f', '#ff9db5'],
  note: ['#f08a5d', '#ff8fab', '#e9b85a', '#9a7fb0'],
  star: ['#f3cf7a', '#ffd76e'],
  zzz: '#9a7fb0',
};
const LIFE = {
  zzz: 2.6, heart: 1.4, vein: 1.5, sweat: 1.7, mark: 1.5, note: 1.9, steam: 0.9, bulb: 1.7,
  gloom: 2.2, dust: 0.55, star: 1.0,
};
const SIZE = {
  flower: [9, 13], petal: [6, 9], sparkle: [6, 10], heart: [9, 12], zzz: [13, 13], vein: [11, 11],
  sweat: [8, 9], mark: [17, 17], note: [10, 13], steam: [5, 7], bulb: [13, 13], gloom: [26, 26],
  dust: [5, 7], star: [7, 9],
};
// stickers stay where they appear and pop in with an overshoot
const STICKERS = new Set(['vein', 'mark', 'bulb', 'gloom']);

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Effects {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.parts = [];
    this.dpr = 1;
  }

  resize(cssW, cssH, dpr) {
    this.dpr = dpr;
    const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  get busy() {
    return this.parts.length > 0;
  }

  // ---- emitters (positions in window css px, `s` = pet scale in css px per unit) ----

  burst(x, y, s, n = 10) {
    for (let i = 0; i < n; i++) {
      const kind = Math.random() < 0.45 ? 'petal' : Math.random() < 0.5 ? 'flower' : 'sparkle';
      const ang = rand(-Math.PI * 0.95, -Math.PI * 0.05);
      const sp = rand(60, 150) * s;
      this.add(kind, x, y, Math.cos(ang) * sp, Math.sin(ang) * sp, s);
    }
  }

  hearts(x, y, s, n = 3) {
    for (let i = 0; i < n; i++) {
      this.add('heart', x + rand(-30, 30) * s, y + rand(-10, 10) * s, rand(-15, 15) * s, rand(-60, -40) * s, s);
    }
  }

  sparkles(x, y, s, n = 4, spread = 70) {
    for (let i = 0; i < n; i++) {
      this.add('sparkle', x + rand(-spread, spread) * s, y + rand(-spread, spread * 0.4) * s, 0, rand(-12, -4) * s, s);
    }
  }

  zzz(x, y, s) {
    this.add('zzz', x, y, rand(8, 16) * s, -22 * s, s);
  }

  vein(x, y, s) {
    this.add('vein', x, y, 0, 0, s);
  }

  sweat(x, y, s) {
    this.add('sweat', x, y, 0, 6 * s, s);
  }

  mark(x, y, s, text = '!') {
    this.add('mark', x, y, 0, 0, s, { text });
  }

  notes(x, y, s, n = 1) {
    for (let i = 0; i < n; i++) {
      this.add('note', x + rand(-20, 20) * s, y + rand(-8, 8) * s, rand(-14, 14) * s, rand(-46, -30) * s, s,
        { text: pick(['♪', '♫', '♪']) });
    }
  }

  steam(x, y, s, dir = 1) {
    for (let i = 0; i < 3; i++) {
      this.add('steam', x + i * 4 * dir * s, y - i * 3 * s, dir * rand(18, 34) * s, rand(-34, -20) * s, s);
    }
  }

  bulb(x, y, s) {
    this.add('bulb', x, y, 0, 0, s);
  }

  gloom(x, y, s) {
    this.add('gloom', x, y, 0, 0, s);
  }

  dust(x, y, s, n = 6) {
    for (let i = 0; i < n; i++) {
      const dir = i % 2 ? 1 : -1;
      this.add('dust', x + dir * rand(4, 16) * s, y - rand(0, 4) * s, dir * rand(30, 70) * s, rand(-22, -6) * s, s);
    }
  }

  stars(x, y, s, n = 3) {
    for (let i = 0; i < n; i++) {
      const a = rand(-Math.PI * 0.9, -Math.PI * 0.1);
      this.add('star', x, y, Math.cos(a) * rand(50, 90) * s, Math.sin(a) * rand(50, 90) * s, s);
    }
  }

  add(kind, x, y, vx, vy, s, extra = {}) {
    const [lo, hi] = SIZE[kind];
    this.parts.push({
      kind, x, y, vx, vy, s, life: LIFE[kind] || rand(1.1, 1.8), age: 0,
      rot: STICKERS.has(kind) || kind === 'sweat' ? 0 : rand(0, Math.PI * 2), vr: rand(-3, 3),
      size: rand(lo, hi) * s,
      color: kind === 'zzz' ? COLORS.zzz : COLORS[kind] ? pick(COLORS[kind]) : null,
      phase: rand(0, 6),
      ...extra,
    });
  }

  // ---- simulation + drawing ----

  update(dt) {
    for (const p of this.parts) {
      p.age += dt;
      if (p.kind === 'petal' || p.kind === 'flower') {
        p.vy += 140 * p.s * dt; // gravity
        p.vx *= 1 - 1.2 * dt; // air drag
        p.vy *= 1 - 1.2 * dt;
        p.x += Math.sin(p.age * 4 + p.phase) * 18 * p.s * dt;
      } else if (p.kind === 'zzz' || p.kind === 'note') {
        p.x += Math.sin(p.age * 2.6 + p.phase) * 10 * p.s * dt;
      } else if (p.kind === 'sweat') {
        p.vy += 26 * p.s * dt;
      } else if (p.kind === 'steam' || p.kind === 'dust') {
        p.vx *= 1 - 2.5 * dt;
        p.vy *= 1 - 2.5 * dt;
      } else if (p.kind === 'star') {
        p.vx *= 1 - 1.8 * dt;
        p.vy = p.vy * (1 - 1.8 * dt) + 30 * p.s * dt;
        p.rot += 6 * dt;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (!STICKERS.has(p.kind) && p.kind !== 'star') p.rot += p.vr * dt;
    }
    this.parts = this.parts.filter((p) => p.age < p.life);
  }

  draw() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (const p of this.parts) {
      const t = p.age / p.life;
      const fade = t < 0.12 ? t / 0.12 : t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
      ctx.globalAlpha = clamp(fade, 0, 1);
      ctx.setTransform(this.dpr, 0, 0, this.dpr, p.x * this.dpr, p.y * this.dpr);
      if (STICKERS.has(p.kind)) {
        // pop in with an overshoot, then breathe
        const pop = p.age < 0.25 ? 1.35 * Math.sin((p.age / 0.25) * Math.PI * 0.62) : 1;
        const sc = pop * (1 + 0.06 * Math.sin(p.age * 9 + p.phase));
        ctx.scale(sc, sc);
      } else {
        const sway = p.kind === 'heart' || p.kind === 'zzz' || p.kind === 'note';
        ctx.rotate(sway ? Math.sin(p.age * 3 + p.phase) * 0.25 : p.rot);
      }
      DRAW[p.kind](ctx, p, t);
    }
    ctx.globalAlpha = 1;
  }
}

// A soft contact shadow (warm, not black, to sit under her palette): a radial
// gradient ellipse. Scaled to size when drawn.
export function makeShadow(doc = document) {
  const w = 256;
  const h = 96;
  const c = doc.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
  g.addColorStop(0, 'rgba(70, 40, 25, 0.36)');
  g.addColorStop(0.5, 'rgba(70, 40, 25, 0.2)');
  g.addColorStop(1, 'rgba(70, 40, 25, 0)');
  ctx.scale(1, h / w);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, w);
  return { canvas: c, w, h, tex: null };
}

// A vertical line of light on a small canvas: a tapered white-gold core in an orange
// glow, pointed at both ends. Stretched to any height when drawn.
export function makeLightLine(doc = document) {
  const w = 64;
  const h = 512;
  const c = doc.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const lens = (hw) => { // a quadratic through (hw*2) bulges hw at the middle
    ctx.beginPath();
    ctx.moveTo(w / 2, 10);
    ctx.quadraticCurveTo(w / 2 + 2 * hw, h / 2, w / 2, h - 10);
    ctx.quadraticCurveTo(w / 2 - 2 * hw, h / 2, w / 2, 10);
    ctx.closePath();
  };
  ctx.shadowColor = 'rgba(255, 170, 90, 0.95)';
  ctx.shadowBlur = 18;
  ctx.fillStyle = 'rgba(255, 214, 150, 0.9)';
  lens(5);
  ctx.fill();
  ctx.shadowBlur = 6;
  ctx.fillStyle = '#fffaf0';
  lens(2.2);
  ctx.fill();
  return { canvas: c, w, h, tex: null };
}

// ---- particle shapes, drawn around the origin ----

function drawPetal(ctx, p) {
  const r = p.size;
  const g = ctx.createRadialGradient(-r * 0.3, -r * 0.1, 0, 0, 0, r);
  g.addColorStop(0, '#ffe3d2');
  g.addColorStop(0.45, p.color);
  g.addColorStop(1, p.color);
  ctx.fillStyle = g;
  ctx.beginPath(); // a petal: round at one end, pointed at the other
  ctx.moveTo(-r, 0);
  ctx.bezierCurveTo(-r * 0.6, -r * 0.75, r * 0.5, -r * 0.7, r, 0);
  ctx.bezierCurveTo(r * 0.5, r * 0.7, -r * 0.6, r * 0.75, -r, 0);
  ctx.fill();
}

function drawFlower(ctx, p) {
  const r = p.size;
  ctx.fillStyle = p.color;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    ctx.beginPath();
    ctx.ellipse(Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55, r * 0.5, r * 0.36, a, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#e9b85a';
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff6e8';
  ctx.beginPath();
  ctx.arc(-r * 0.06, -r * 0.06, r * 0.17, 0, Math.PI * 2);
  ctx.fill();
}

function drawSparkle(ctx, p) {
  const r = p.size * (0.75 + 0.35 * Math.sin(p.age * 12 + p.phase));
  ctx.shadowColor = 'rgba(255, 215, 120, 0.9)';
  ctx.shadowBlur = r * 0.8;
  ctx.fillStyle = p.color;
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const b = a + Math.PI / 4;
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    ctx.lineTo(Math.cos(b) * r * 0.22, Math.sin(b) * r * 0.22);
  }
  ctx.closePath();
  ctx.fill();
}

function drawHeart(ctx, p) {
  const r = p.size;
  ctx.fillStyle = p.color;
  ctx.beginPath();
  ctx.moveTo(0, r * 0.35);
  ctx.bezierCurveTo(-r * 1.1, -r * 0.35, -r * 0.45, -r * 1.05, 0, -r * 0.45);
  ctx.bezierCurveTo(r * 0.45, -r * 1.05, r * 1.1, -r * 0.35, 0, r * 0.35);
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.beginPath();
  ctx.ellipse(-r * 0.42, -r * 0.5, r * 0.16, r * 0.1, -0.6, 0, Math.PI * 2);
  ctx.fill();
}

function drawZzz(ctx, p, t) {
  ctx.fillStyle = p.color;
  ctx.font = `bold ${Math.round(p.size * (0.7 + t * 0.6))}px "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('z', 0, 0);
}

// 💢: one curved stroke per quadrant, each mirror-symmetric about its diagonal and
// bowing in toward the centre (no rotational pinwheel)
function drawVein(ctx, p) {
  const r = p.size;
  ctx.strokeStyle = '#e5453b';
  ctx.lineWidth = r * 0.26;
  ctx.lineCap = 'round';
  for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    ctx.beginPath();
    ctx.moveTo(sx * r * 0.28, sy * r);
    ctx.quadraticCurveTo(sx * r * 0.3, sy * r * 0.3, sx * r, sy * r * 0.28);
    ctx.stroke();
  }
}

function drawSweat(ctx, p) {
  const r = p.size;
  ctx.beginPath();
  ctx.moveTo(0, -r * 1.3);
  ctx.bezierCurveTo(r * 0.25, -r * 0.6, r, -r * 0.1, r, r * 0.35);
  ctx.arc(0, r * 0.35, r, 0, Math.PI);
  ctx.bezierCurveTo(-r, -r * 0.1, -r * 0.25, -r * 0.6, 0, -r * 1.3);
  ctx.fillStyle = '#a9dcf7';
  ctx.fill();
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = '#4a9fd6';
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.ellipse(-r * 0.35, r * 0.25, r * 0.18, r * 0.3, 0.4, 0, Math.PI * 2);
  ctx.fill();
}

function drawMark(ctx, p) {
  if (p.text === '…') { // drawn, so the dots are round in every font
    const r = p.size * 0.2;
    for (const x of [-1, 0, 1]) {
      ctx.beginPath();
      ctx.arc(x * r * 3, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = '#8a7a70';
      ctx.strokeStyle = '#fffaf3';
      ctx.lineWidth = r * 0.9;
      ctx.stroke();
      ctx.fill();
    }
    return;
  }
  ctx.font = `900 ${Math.round(p.size * 1.6)}px "Segoe UI", "Arial Black", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = p.size * 0.32;
  ctx.strokeStyle = '#fffaf3';
  ctx.strokeText(p.text, 0, 0);
  ctx.fillStyle = p.text === '?' ? '#7d86d8' : p.text === '…' ? '#8a7a70' : '#f0783f';
  ctx.fillText(p.text, 0, 0);
}

function drawNote(ctx, p) {
  ctx.font = `bold ${Math.round(p.size * 1.7)}px "Segoe UI Symbol", "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = p.color;
  ctx.fillText(p.text, 0, 0);
}

function drawSteam(ctx, p, t) {
  const r = p.size * (0.6 + t * 1.2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.strokeStyle = 'rgba(150, 140, 140, 0.7)';
  ctx.lineWidth = 1.2;
  for (const [x, y, rr] of [[0, 0, r], [r * 0.8, -r * 0.3, r * 0.7], [-r * 0.7, -r * 0.2, r * 0.6]]) {
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

function drawBulb(ctx, p) {
  const r = p.size;
  const glow = ctx.createRadialGradient(0, 0, r * 0.3, 0, 0, r * 2.2);
  glow.addColorStop(0, 'rgba(255, 230, 120, 0.75)');
  glow.addColorStop(1, 'rgba(255, 230, 120, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 0, r * 2.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#f3b13f';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  for (let i = 0; i < 7; i++) {
    const a = -Math.PI / 2 + (i - 3) * 0.45;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r * 1.35, Math.sin(a) * r * 1.35);
    ctx.lineTo(Math.cos(a) * r * 1.8, Math.sin(a) * r * 1.8);
    ctx.stroke();
  }
  ctx.fillStyle = '#ffe56b';
  ctx.strokeStyle = '#c98a22';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(0, -r * 0.1, r * 0.85, Math.PI * 0.8, Math.PI * 2.2);
  ctx.lineTo(r * 0.38, r * 0.75);
  ctx.lineTo(-r * 0.38, r * 0.75);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#b9b2ad';
  ctx.fillRect(-r * 0.36, r * 0.78, r * 0.72, r * 0.42);
}

function drawGloom(ctx, p, t) {
  const r = p.size;
  ctx.strokeStyle = 'rgba(122, 104, 160, 0.75)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 4; i++) {
    const x = (i - 1.5) * r * 0.32;
    ctx.beginPath();
    for (let k = 0; k <= 8; k++) {
      const y = -r * 0.5 + (k / 8) * r * (0.6 + 0.4 * Math.min(1, t * 3));
      ctx.lineTo(x + Math.sin(k * 1.4 + p.age * 3 + i) * 2, y);
    }
    ctx.stroke();
  }
}

function drawDust(ctx, p, t) {
  const r = p.size * (0.6 + t);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  g.addColorStop(0, 'rgba(222, 206, 188, 0.75)');
  g.addColorStop(1, 'rgba(222, 206, 188, 0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
}

function drawStar(ctx, p) {
  const r = p.size;
  ctx.fillStyle = p.color;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
}

const DRAW = {
  petal: drawPetal, flower: drawFlower, sparkle: drawSparkle, heart: drawHeart, zzz: drawZzz, vein: drawVein,
  sweat: drawSweat, mark: drawMark, note: drawNote, steam: drawSteam, bulb: drawBulb, gloom: drawGloom,
  dust: drawDust, star: drawStar,
};
