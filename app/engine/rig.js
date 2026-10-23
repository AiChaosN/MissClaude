// Layered, skinned 2D rig (Live2D-style, hand-rolled). Character-agnostic: what the
// bones are called and how they move comes from the character pack.
//
// rig_<kind>.json (tools/build_rig.py -> tools/export_assets.py) describes bones and
// layers in a sprite's pixel space. Every layer is a grid mesh whose vertices are
// skinned to a few bones (linear blend skinning). A bone's deformation is its
// parent's deformation times its own rotation/scale about its pivot. Spring bones
// (hair, tails, ribbons ...) add an angle and a stretch that follow pendulum physics
// driven by how their pivot moves on screen.
//
// Animation is parameter based, like Live2D: behaviour code sets targets, the rig
// eases toward them, and the character's poser for this rig kind turns the eased
// parameters into bone angles.

import { affine } from './gl.js';
import { clamp, wobble } from './anim.js';

const DEG = Math.PI / 180;
const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export { wobble, smooth };

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

// the two skins every character has; packs add their own (long hair, a skirt ...)
export const BASE_SKINS = {
  rigid: (x, y, spec) => ({ [spec.bone]: 1 }),
  chain: (x, y, spec) => chainWeights(x, y, spec.joints, spec.blend),
};

const PENDULUM_PX = 150;
const GAZE = ['gazeX', 'gazeY']; // eased much faster: eyes jump, heads turn

// iris layers slide inside their eye opening (eye bones, translation only)
function poseEyes(B, p, ranges) {
  for (const [bone, [rx, ry]] of Object.entries(ranges)) {
    B[bone].tx = p.gazeX * rx;
    B[bone].ty = p.gazeY * ry;
  }
}

export class Rig {
  // character: { posers: {kind: fn(B, t, p)}, paramDefaults, skins, variantParams, headBone }
  constructor(def, textures, character) {
    this.def = def;
    this.ch = character;
    this.bones = {};
    for (const [name, b] of Object.entries(def.bones)) {
      this.bones[name] = {
        name, ...b, angle: 0, scaleX: 1, scaleY: 1, tx: 0, ty: 0, m: affine.identity(),
        phys: b.physics ? { a: 0, v: 0, s: 0, sv: 0, last: null, vel: null } : null,
      };
    }
    this.order = this.topoOrder();
    this.skins = { ...BASE_SKINS, ...(character.skins || {}) };
    this.layers = def.layers.map((l) => this.buildLayer(l, textures[l.name]));
    this.time = 0;
    this.kind = def.kind || 'stand';
    this.poser = character.posers[this.kind];
    if (!this.poser) throw new Error(`character has no poser for rig kind "${this.kind}"`);
    this.headBone = character.headBone || 'head';
    // eye openings that clip the irises, and how far each eye bone may travel
    this.masks = {};
    for (const [name, m] of Object.entries(def.masks || {})) this.masks[name] = { ...m, tex: textures[name] };
    this.eyeRanges = {};
    for (const l of def.layers) {
      if (l.type === 'iris') this.eyeRanges[def.skins[l.skin].bone] = l.range;
    }
    // 'all'; 'props': only the furniture (layers marked propView) while it moves
    // around on its own; 'char': everything but the furniture (a fading copy)
    this.showMode = 'all';
    // variant groups: the first variant layer listed in a group is its default; the
    // target parameter that picks a group's variant is named after the group unless
    // the character maps it (variantParams)
    this.variantParams = character.variantParams || {};
    this.variants = {};
    for (const l of def.layers) {
      if (!l.variant) continue;
      const g = l.group || 'armF';
      this.variants[g] ??= { cur: l.variant, prev: null, fade: 1 };
    }
    this.target = { ...(character.paramDefaults || {}), gazeX: 0, gazeY: 0, phase: 0 };
    for (const [g, v] of Object.entries(this.variants)) this.target[this.variantParams[g] || g] = v.cur;
    this.p = {};
    for (const [k, v] of Object.entries(this.target)) {
      if (typeof v === 'number' && k !== 'phase') this.p[k] = v;
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
    const fn = this.skins[spec.type];
    if (!fn) throw new Error(`unknown skin type "${spec.type}" for layer ${l.name}`);
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
    // every numeric target eases toward its value; the gaze faster; `phase` is taken as is
    const k = 1 - Math.exp(-7 * dt);
    const kg = 1 - Math.exp(-22 * dt);
    for (const key of Object.keys(this.p)) {
      const rate = GAZE.includes(key) ? kg : k;
      this.p[key] += ((this.target[key] ?? this.p[key]) - this.p[key]) * rate;
    }
    for (const [g, v] of Object.entries(this.variants)) {
      const want = this.target[this.variantParams[g] || g];
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
          // rigid fallback: irises stay centred (on their eye bone's parent), where they need no clipping
          const bone = layer.type === 'iris' ? B[layer.bone].parent : layer.main;
          renderer.draw(layer.tex, affine.mul(view, B[bone].m),
            { rect: [layer.x, layer.y, layer.w, layer.h], opacity: alpha });
        }
      }
      if (layer.name === this.def.faceAfter && this.showMode !== 'props') {
        // face patches follow the bone the character assigned them (the head by default)
        for (const f of faceList) {
          const m = affine.mul(view, (B[f.bone] || B[this.headBone]).m);
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
}
