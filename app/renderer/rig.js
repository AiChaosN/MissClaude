// Layered, skinned 2D rig for the standing pose (Live2D-style, hand-rolled).
//
// rig.json (tools/build_rig.py -> tools/export_assets.py) describes bones and layers
// in the idle sprite's pixel space. Every layer is a grid mesh whose vertices are
// skinned to a few bones (linear blend skinning). A bone's deformation is its
// parent's deformation times its own rotation/scale about its pivot. Spring bones
// (hair masses, skirt, ribbon, earring) add an angle and a stretch that follow
// pendulum physics driven by how their pivot moves on screen.
//
// Animation is parameter based, like Live2D: behaviour code sets targets (head
// tilt, arm pose, wave ...), the rig eases toward them and layers idle life on top.

import { affine } from './gl.js';

const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
// smooth pseudo-noise from a few incommensurate sines, roughly -1..1
export const wobble = (t, seed) => 0.55 * Math.sin(t * 1.0 + seed) + 0.3 * Math.sin(t * 2.31 + seed * 1.7)
  + 0.15 * Math.sin(t * 4.73 + seed * 2.9);

// ---------------- skin weights: {bone: weight} for a rest-pose vertex ----------------

function chainWeights(x, y, joints, blend) {
  // project onto the polyline through the joints (root outward) and blend between
  // the bones on either side of each joint
  const lens = [];
  for (let i = 0; i < joints.length - 1; i++) {
    lens.push(Math.hypot(joints[i + 1][1][0] - joints[i][1][0], joints[i + 1][1][1] - joints[i][1][1]) || 1);
  }
  let best = { d: Infinity, s: 0 };
  let acc = 0;
  for (let i = 0; i < joints.length - 1; i++) {
    const [ax, ay] = joints[i][1];
    const [bx, by] = joints[i + 1][1];
    const len = lens[i];
    const lo = i === 0 ? -2 : 0;
    const hi = i === joints.length - 2 ? 3 : 1;
    const t = clamp(((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / (len * len), lo, hi);
    const d = Math.hypot(x - (ax + (bx - ax) * t), y - (ay + (by - ay) * t));
    if (d < best.d) best = { d, s: acc + t * len };
    acc += len;
  }
  const w = {};
  let at = 0;
  for (let i = 0; i < joints.length; i++) {
    if (i > 0) at += lens[i - 1];
    const enter = i === 0 ? 1 : smooth(at - blend, at + blend, best.s);
    const leave = i < joints.length - 1 ? smooth(at + lens[i] - blend, at + lens[i] + blend, best.s) : 0;
    const wi = enter - leave;
    if (wi > 1e-3) w[joints[i][0]] = wi;
  }
  return w;
}

const SKINS = {
  rigid: (x, y, spec) => ({ [spec.bone]: 1 }),
  chain: (x, y, spec) => chainWeights(x, y, spec.joints, spec.blend),
  // long hair: top glued to the head, middle to the chest, outer lower part swings
  hair: (x, y, spec, k) => {
    const head = 1 - smooth(spec.headY[0], spec.headY[1], y);
    // precomputed: grows with the distance from the body silhouette (export_assets.py)
    const swing = spec.swingGrid ? spec.swingGrid.data[k]
      : smooth(spec.swingY[0], spec.swingY[1], y) * smooth(spec.sideX[0], spec.sideX[1], Math.abs(x - spec.cx));
    const w = {};
    if (head > 1e-3) w.head = head;
    const rest = 1 - head;
    if (rest * swing > 1e-3) w[x < spec.cx ? 'hairL' : 'hairR'] = rest * swing;
    if (rest * (1 - swing) > 1e-3) w.chest = rest * (1 - swing);
    return w;
  },
  // body: chest above the waist, hips below, hem follows the skirt spring
  body: (x, y, spec) => {
    const upper = 1 - smooth(spec.waistY[0], spec.waistY[1], y);
    const hem = smooth(spec.hemY[0], spec.hemY[1], y);
    const w = {};
    if (upper > 1e-3) w.chest = upper;
    const lower = 1 - upper;
    if (lower * hem > 1e-3) w.skirt = lower * hem;
    if (lower * (1 - hem) > 1e-3) w.body = lower * (1 - hem);
    return w;
  },
  // head: rigid, except the long side lock below the jaw lags toward the chest
  head: (x, y, spec) => {
    const lag = smooth(spec.lockY[0], spec.lockY[1], y) * spec.lockLag;
    return lag > 1e-3 ? { head: 1 - lag, chest: lag } : { head: 1 };
  },
};

const PENDULUM_PX = 150;
// eased parameters; `phase` (walk cycle) and `arm` are taken as they are
const PARAMS = ['headTilt', 'headNod', 'lean', 'breath', 'bookLift', 'armOut', 'wave', 'tap', 'stride',
  'sleep', 'flail', 'armMotion', 'stretch', 'shake', 'write'];
// arm variant groups and the parameter that picks each one's variant
const GROUPS = { armF: 'arm', armB: 'armB' };

// How each extra arm variant moves while `armMotion` is up: [bone suffix, amplitude deg,
// frequency Hz, phase]. Suffix 0 is the shoulder (or elbow) joint, 1 the next, 2 the hand.
const VARIANT_MOTION = {
  up: [[0, 3, 2.2, 0], [1, 6, 2.2, 0.6], [2, 14, 2.2, 1.2]], // "here, here!"
  point: [[0, 2, 1.6, 0], [1, 4, 1.6, 0.4]], // jabbing at something
  fist: [[0, 7, 2.6, 0], [1, 6, 2.6, 0.5]], // pumping
  scratch: [[1, 3, 4.5, 0], [2, 11, 4.5, 0.8]], // scratching the cheek
  mouth: [[0, 1.5, 6, 0], [1, 2.5, 6, 0.6]], // giggling behind the hand
  hip: [],
  bhip: [],
  bhug: [[0, 1.2, 0.7, 0]],
  bup: [[0, 1.5, 1.4, 0], [1, 2, 1.4, 0.7]], // peeking over the book
};
const GAZE = ['gazeX', 'gazeY']; // eased much faster: eyes jump, heads turn

// iris layers slide inside their eye opening (eye bones, translation only)
function poseEyes(B, p, ranges) {
  for (const [bone, [rx, ry]] of Object.entries(ranges)) {
    B[bone].tx = p.gazeX * rx;
    B[bone].ty = p.gazeY * ry;
  }
}

// ---------------- posers: parameters -> bone angles, one per rig kind ----------------

function poseStand(B, t, p) {
  const breath = Math.sin((t * 2 * Math.PI) / 3.6) * p.breath;
  B.chest.scaleY = 1 + 0.012 * breath;
  B.chest.scaleX = 1 - 0.004 * breath;
  B.chest.angle = (p.lean + 0.6 * wobble(t * 0.35, 1)) * DEG;
  B.body.angle = 0.3 * wobble(t * 0.3, 4) * DEG;
  B.head.angle = (p.headTilt + 1.8 * wobble(t * 0.42, 2)) * DEG;
  B.head.ty = p.headNod - 0.8 * breath;
  B.armB.angle = (-p.bookLift + 1.4 * wobble(t * 0.5, 3)) * DEG;
  const set = (name, deg) => { if (B[name]) B[name].angle = deg * DEG; };
  const beat = t * 2 * Math.PI * 2.4;
  // resting arm drifts; the hand turns a little at the wrist
  set('armF_down', -p.armOut + 1.6 * wobble(t * 0.45, 5));
  set('foreF_down', 1.5 * wobble(t * 0.6, 6));
  set('handF_down', 5 * wobble(t * 0.8, 7));
  // waving: forearm swings about the elbow, the hand follows a beat later
  set('armF_wave', 1.2 * wobble(t * 0.5, 8));
  set('foreF_wave', p.wave * 10 * Math.sin(beat));
  set('handF_wave', p.wave * 16 * Math.sin(beat - 0.8));
  // thinking: the finger taps the chin
  set('armF_chin', 0.8 * wobble(t * 0.5, 9));
  set('foreF_chin', p.tap * 2.0 * Math.sin(t * 2 * Math.PI * 1.1));
  set('handF_chin', p.tap * 4.0 * Math.sin(t * 2 * Math.PI * 1.1 + 0.6));
  // extra variants: a small drift always, their own gesture while armMotion is up
  for (const [v, moves] of Object.entries(VARIANT_MOTION)) {
    const side = v[0] === 'b' ? 'B' : 'F';
    for (let k = 0; k < 3; k++) set(`arm${side}_${v}${k}`, 1.0 * wobble(t * 0.5, 11 + k));
    for (const [k, amp, hz, ph] of moves) {
      const b = B[`arm${side}_${v}${k}`];
      if (b) b.angle += p.armMotion * amp * Math.sin(t * 2 * Math.PI * hz - ph) * DEG;
    }
  }
  // stretching: the torso lengthens and leans back; shaking: quick giggle/shiver
  B.chest.scaleY += 0.035 * p.stretch;
  B.chest.angle += (-3 * p.stretch + 1.6 * p.shake * Math.sin(t * 2 * Math.PI * 7)) * DEG;
  B.head.angle += (-4 * p.stretch) * DEG;
}

// Sitting with the book. Awake: the eyes run along the lines and the head follows a
// little, with a small nod at each new line. Asleep: deeper, slower breathing, the head
// sinks to one side and jerks back up now and then.
function poseSit(B, t, p) {
  const breath = Math.sin((t * 2 * Math.PI) / (3.8 + 1.4 * p.sleep));
  B.chest.scaleY = 1 + (0.011 + 0.01 * p.sleep) * breath;
  B.chest.scaleX = 1 - 0.004 * breath;
  const awake = 1 - p.sleep;
  const line = (t % 4.6) / 4.6;
  const scan = line < 0.9 ? 2.4 * (line / 0.9 - 0.5) : 1.2 - 2.4 * (line - 0.9) / 0.1;
  const newLine = Math.exp(-((line - 0.95) ** 2) / 0.002);
  const sink = ((t % 7.3) / 7.3) ** 1.6;
  B.head.angle = (awake * (scan + 0.8 * wobble(t * 0.4, 2)) + p.sleep * (5 + 6 * sink)) * DEG;
  B.head.ty = awake * (1.5 * newLine) + p.sleep * (5 + 9 * sink) - 0.8 * breath;
  B.chest.angle = (0.5 * wobble(t * 0.3, 1) + p.sleep * 1.5 * sink) * DEG;
}

// Dangling from the collar: the legs pedal, the body wriggles, the head shakes a bit.
function poseDrag(B, t, p) {
  const f = p.flail;
  const w = t * 2 * Math.PI * 2.1;
  for (const [leg, foot, off] of [['legL', 'footL', 0], ['legR', 'footR', Math.PI]]) {
    if (!B[leg]) continue;
    B[leg].angle = 15 * f * Math.sin(w + off) * DEG;
    B[leg].ty = -6 * f * Math.max(0, Math.sin(w + off + 1.2));
    B[foot].angle = 14 * f * Math.sin(w + off - 0.9) * DEG;
  }
  B.body.angle = 1.4 * f * Math.sin(w * 0.5) * DEG;
  B.chest.scaleY = 1 + 0.012 * Math.sin((t * 2 * Math.PI) / 2.2);
  B.head.angle = (3 * f * Math.sin(t * 2 * Math.PI * 1.3) + 1.2 * wobble(t * 0.6, 2)) * DEG;
}

// Walk cycle in the 3/4 view facing +x. phase advances one full turn per two steps.
// Both legs swing through the same arc about their hips (hidden under the skirt),
// half a cycle apart, so they pass each other: during stance the foot moves back at
// walking speed (it stays planted), during swing it lifts and travels forward. The
// heel strikes toe-up, the push-off is toe-down. The body is highest while the legs
// pass, the free arm swings against the near leg, the head lags a little.
function poseWalk(B, t, p) {
  const st = p.stride;
  const legs = [['legF', 'footF', 0], ['legB', 'footB', Math.PI]];
  for (const [leg, foot, offset] of legs) {
    const ph = p.phase + offset;
    const fwd = Math.cos(ph); // +1: foot furthest forward (heel strike), -1: furthest back (toe off)
    // 26 deg each way: with a 200 px leg that is a stride of ~0.14 x her height, matched
    // by WALK_STRIDE in pet.js so the planted foot does not slide
    B[leg].angle = -26 * st * fwd * DEG;
    B[leg].ty = -22 * st * Math.max(0, -Math.sin(ph)); // swing phase: lift
    B[foot].angle = (fwd > 0 ? -14 * fwd : -22 * fwd) * st * DEG;
  }
  const pass = Math.abs(Math.sin(p.phase)); // 1 while the legs pass under the body
  B.body.ty = -14 * st * pass;
  B.body.angle = 1.0 * st * Math.cos(p.phase) * DEG;
  B.chest.angle = (2.2 + 0.8 * Math.cos(2 * p.phase)) * st * DEG;
  B.chest.scaleY = 1 + 0.008 * Math.sin((t * 2 * Math.PI) / 3.0);
  B.head.angle = (-1.4 * st * Math.cos(p.phase - 0.6) + 1.2 * wobble(t * 0.5, 2)) * DEG;
  B.head.ty = 1.5 * st * Math.abs(Math.sin(p.phase - 0.5));
  B.armF.angle = 12 * st * Math.cos(p.phase) * DEG;
  if (B.handF) B.handF.angle = 7 * st * Math.cos(p.phase - 0.7) * DEG;
  if (B.skirt) B.skirt.angle = 0.8 * st * Math.sin(2 * p.phase) * DEG;
}

// At the desk. The writing arm scribbles (quick small strokes from the elbow, the hand
// wiggling faster), the head bobs along with the words and the eyes stay on the paper;
// the dangling feet swing. `write` (0..1) scales the scribbling.
function poseWork(B, t, p) {
  const breath = Math.sin((t * 2 * Math.PI) / 3.6);
  B.chest.scaleY = 1 + 0.01 * breath;
  B.chest.angle = (0.8 * wobble(t * 0.35, 1) + p.lean) * DEG;
  const w = p.write;
  const word = Math.sin(t * 2 * Math.PI * 0.9); // one "word" a bit over a second
  if (B.armW) B.armW.angle = w * (1.2 * Math.sin(t * 2 * Math.PI * 0.45) + 0.8 * word) * DEG;
  if (B.handW) B.handW.angle = w * 4 * Math.sin(t * 2 * Math.PI * 6.5) * DEG;
  if (B.foreT) B.foreT.angle = p.tap * 2.2 * Math.sin(t * 2 * Math.PI * 1.1) * DEG;
  B.head.angle = (p.headTilt + w * 1.2 * word + 1.2 * wobble(t * 0.4, 2)) * DEG;
  B.head.ty = p.headNod - 0.6 * breath + w * 0.8 * Math.abs(word);
  for (const [leg, off] of [['legL', 0], ['legR', 2.1]]) {
    if (B[leg]) B[leg].angle = 9 * Math.sin(t * 2 * Math.PI * 0.8 + off) * DEG;
  }
}

const POSERS = { stand: poseStand, walk: poseWalk, sit: poseSit, drag: poseDrag, work: poseWork };

export class Rig {
  constructor(def, textures) {
    this.def = def;
    this.bones = {};
    for (const [name, b] of Object.entries(def.bones)) {
      this.bones[name] = {
        name, ...b, angle: 0, scaleX: 1, scaleY: 1, tx: 0, ty: 0, m: affine.identity(),
        phys: b.physics ? { a: 0, v: 0, s: 0, sv: 0, last: null, vel: null } : null,
      };
    }
    this.order = this.topoOrder();
    this.layers = def.layers.map((l) => this.buildLayer(l, textures[l.name]));
    this.time = 0;
    this.kind = def.kind || 'stand';
    this.poser = POSERS[this.kind];
    this.target = {
      headTilt: 0, headNod: 0, lean: 0, breath: 1, bookLift: 0, armOut: 0, wave: 0, tap: 0, stride: 0,
      sleep: 0, flail: 1, armMotion: 0, stretch: 0, shake: 0, write: 0, gazeX: 0, gazeY: 0,
      arm: 'down', armB: 'book', phase: 0,
    };
    this.p = Object.fromEntries([...PARAMS, ...GAZE].map((k) => [k, this.target[k]]));
    // eye openings that clip the irises, and how far each eye bone may travel
    this.masks = {};
    for (const [name, m] of Object.entries(def.masks || {})) this.masks[name] = { ...m, tex: textures[name] };
    this.eyeRanges = {};
    for (const l of def.layers) {
      if (l.type === 'iris') this.eyeRanges[def.skins[l.skin].bone] = l.range;
    }
    // 'all', or 'props': only the furniture (layers marked propView), while it moves
    // around without her
    this.showMode = 'all';
    // per group: the variant shown, the one fading out, and how far the fade has got
    this.variants = {};
    for (const l of def.layers) {
      if (!l.variant) continue;
      const g = l.group || 'armF';
      this.variants[g] ??= { cur: null, prev: null, fade: 1 };
      if (!this.variants[g].cur && (l.variant === 'down' || l.variant === 'book' || l.variant === 'write')) {
        this.variants[g].cur = l.variant;
      }
    }
  }

  topoOrder() {
    const out = [];
    const seen = new Set();
    const visit = (n) => {
      if (seen.has(n)) return;
      const parent = this.def.bones[n].parent;
      if (parent) visit(parent);
      seen.add(n);
      out.push(n);
    };
    Object.keys(this.def.bones).forEach(visit);
    return out;
  }

  buildLayer(l, tex) {
    const cell = this.def.cell;
    const cols = Math.max(2, Math.ceil(l.w / cell) + 1);
    const rows = Math.max(2, Math.ceil(l.h / cell) + 1);
    const n = cols * rows;
    const rest = new Float32Array(n * 2);
    const uv = new Float32Array(n * 2);
    const skin = [];
    const spec = this.def.skins[l.skin];
    const fn = SKINS[spec.type];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        const u = i / (cols - 1);
        const v = j / (rows - 1);
        rest[2 * k] = l.x + u * l.w;
        rest[2 * k + 1] = l.y + v * l.h;
        uv[2 * k] = u;
        uv[2 * k + 1] = v;
        const w = fn(rest[2 * k], rest[2 * k + 1], spec, k);
        let sum = 0;
        for (const b in w) sum += w[b];
        skin.push(Object.entries(w).map(([b, wt]) => [b, wt / sum]));
      }
    }
    const idx = [];
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const a = j * cols + i;
        idx.push(a, a + 1, a + cols, a + 1, a + cols + 1, a + cols);
      }
    }
    // dominant bone at the layer centre: used by the rigid 2D fallback
    const centre = skin[Math.floor(rows / 2) * cols + Math.floor(cols / 2)];
    const main = [...centre].sort((a, b) => b[1] - a[1])[0][0];
    // (`skin` becomes the per-vertex weights; a rigid layer's bone is kept as `bone`)
    return {
      ...l, tex, rest, uv, skin, bone: spec.bone || null, idx: new Uint16Array(idx),
      out: new Float32Array(n * 2), main, gpu: null,
    };
  }

  rebind(textures) {
    for (const l of this.layers) {
      l.tex = textures[l.name];
      l.gpu = null;
    }
    for (const [name, m] of Object.entries(this.masks)) m.tex = textures[name];
  }

  get hasIrises() {
    return Object.keys(this.eyeRanges).length > 0;
  }

  // ---------- animation ----------

  set(params) {
    Object.assign(this.target, params);
  }

  ease(dt) {
    const k = 1 - Math.exp(-7 * dt);
    for (const key of PARAMS) this.p[key] += (this.target[key] - this.p[key]) * k;
    const kg = 1 - Math.exp(-22 * dt);
    for (const key of GAZE) this.p[key] += (this.target[key] - this.p[key]) * kg;
    for (const [g, v] of Object.entries(this.variants)) {
      const want = this.target[GROUPS[g] || g];
      if (want && want !== v.cur && this.def.layers.some((l) => (l.group || 'armF') === g && l.variant === want)) {
        v.prev = v.cur;
        v.cur = want;
        v.fade = 0;
      }
      v.fade = Math.min(1, v.fade + dt / 0.14);
    }
  }

  pose(t) {
    this.poser(this.bones, t, { ...this.p, phase: this.target.phase });
    poseEyes(this.bones, this.p, this.eyeRanges);
  }

  solve() {
    for (const name of this.order) {
      const b = this.bones[name];
      const [px, py] = b.pivot;
      const ph = b.phys;
      let local = affine.translate(px + b.tx, py + b.ty);
      local = affine.mul(local, affine.rotate(b.angle + (b.rest || 0) * DEG + (ph ? ph.a : 0)));
      local = affine.mul(local, affine.scale(b.scaleX, b.scaleY * (ph ? 1 + ph.s : 1)));
      local = affine.mul(local, affine.translate(-px, -py));
      b.m = b.parent ? affine.mul(this.bones[b.parent].m, local) : local;
    }
  }

  // Springs. Moving a pivot right swings a hanging part left (+angle); accelerating
  // a pivot upward stretches it (+stretch). screen maps sprite px to screen px.
  physics(dt, screen) {
    for (const name of this.order) {
      const b = this.bones[name];
      const ph = b.phys;
      if (!ph) continue;
      const cfg = b.physics;
      const [x, y] = affine.apply(affine.mul(screen, this.bones[b.parent].m), b.pivot[0], b.pivot[1]);
      if (ph.last && dt > 0) {
        const vel = [(x - ph.last[0]) / dt, (y - ph.last[1]) / dt];
        const accel = ph.vel ? [(vel[0] - ph.vel[0]) / dt, (vel[1] - ph.vel[1]) / dt] : [0, 0];
        ph.vel = vel;
        // pivot acceleration over a typical pendulum length (css px) = angular kick;
        // a mirrored view flips which way "right" swings
        const flip = screen[0] * screen[3] - screen[1] * screen[2] < 0 ? -1 : 1;
        const ax = (flip * clamp(accel[0], -8000, 8000)) / PENDULUM_PX;
        const ay = clamp(accel[1], -8000, 8000) / PENDULUM_PX;
        // steady motion: hanging things trail behind
        const trail = (cfg.drag || 0) * clamp((flip * vel[0]) / 300, -1, 1);
        const wind = cfg.wind * wobble(this.time * cfg.windRate, cfg.seed) + trail;
        ph.v += (-cfg.k * (ph.a - wind) - cfg.c * ph.v + cfg.gain * ax) * dt;
        ph.a = clamp(ph.a + ph.v * dt, -cfg.max, cfg.max);
        if (cfg.ks) {
          ph.sv += (-cfg.ks * ph.s - cfg.cs * ph.sv - cfg.gs * ay) * dt;
          ph.s = clamp(ph.s + ph.sv * dt, -0.08, 0.12);
        }
      }
      ph.last = [x, y];
    }
  }

  // kick the springs (e.g. a hop or a tap on her): angle velocity in rad/s
  kick(strength = 1) {
    for (const b of Object.values(this.bones)) {
      if (b.phys) b.phys.v += (Math.random() - 0.5) * 2 * strength * (b.physics.kick ?? b.physics.gain);
    }
  }

  update(dt, screen) {
    this.time += dt;
    this.ease(dt);
    this.pose(this.time);
    this.solve();
    this.physics(dt, screen);
    this.solve();
  }

  // ---------- drawing ----------

  opacity(layer) {
    if (this.showMode === 'props') return layer.propView ? 1 : 0;
    if (this.showMode === 'char' && (layer.prop || layer.propView)) return 0;
    if (layer.propOnly) return 0;
    if (!layer.variant) return 1;
    const v = this.variants[layer.group || 'armF'];
    if (layer.variant === v.cur) return v.fade;
    if (layer.variant === v.prev) return 1 - v.fade;
    return 0;
  }

  draw(renderer, view, faceList, opacity = 1) {
    const B = this.bones;
    for (const layer of this.layers) {
      const alpha = this.opacity(layer) * opacity;
      if (alpha > 0.001) {
        if (renderer.kind === 'webgl') {
          const { rest, out, skin } = layer;
          for (let k = 0; k < skin.length; k++) {
            const x = rest[2 * k];
            const y = rest[2 * k + 1];
            let ox = 0;
            let oy = 0;
            for (const [bn, w] of skin[k]) {
              const m = B[bn].m;
              ox += w * (m[0] * x + m[2] * y + m[4]);
              oy += w * (m[1] * x + m[3] * y + m[5]);
            }
            out[2 * k] = view[0] * ox + view[2] * oy + view[4];
            out[2 * k + 1] = view[1] * ox + view[3] * oy + view[5];
          }
          if (!layer.gpu || layer.gpu.renderer !== renderer) {
            layer.gpu = { renderer, mesh: renderer.createMesh(layer.uv, layer.idx) };
          }
          renderer.drawMesh(layer.gpu.mesh, layer.tex, out, alpha, layer.clip ? this.clipFor(layer) : null);
        } else {
          // rigid fallback: irises stay centred, where they need no clipping
          const bone = layer.type === 'iris' ? 'head' : layer.main;
          renderer.draw(layer.tex, affine.mul(view, B[bone].m),
            { rect: [layer.x, layer.y, layer.w, layer.h], opacity: alpha });
        }
      }
      if (layer.name === this.def.faceAfter && this.showMode !== 'props') {
        // face patches follow the head; book pages (sit) follow the chest
        for (const f of faceList) {
          const m = affine.mul(view, (B[f.bone] || B.head).m);
          renderer.draw(f.tex, m, { rect: [f.x, f.y, f.w, f.h], spriteW: this.def.w, spriteH: this.def.h });
        }
      }
    }
  }

  // Mask coordinates for a clipped layer: its vertices in the parent's space (an eye
  // bone only translates relative to the head) mapped into the mask's rectangle.
  clipFor(layer) {
    const mask = this.masks[layer.clip];
    const bone = this.bones[layer.bone];
    if (!layer.maskUV) layer.maskUV = new Float32Array(layer.rest.length);
    const { rest, maskUV } = layer;
    for (let k = 0; k < rest.length; k += 2) {
      maskUV[k] = (rest[k] + bone.tx - mask.x) / mask.w;
      maskUV[k + 1] = (rest[k + 1] + bone.ty - mask.y) / mask.h;
    }
    return { tex: mask.tex, uv: maskUV };
  }

  // where a sprite-space point of the head ends up (for bubbles, particles)
  headPoint(x, y) {
    return affine.apply(this.bones.head.m, x, y);
  }
}
