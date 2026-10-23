// How Claude's rigs move: skin weights for her long hair, dress and head lock, and a
// poser per rig kind that turns the eased parameters into bone angles.
//
// Parameters (all eased by the rig unless noted): headTilt/headNod (deg / px), lean,
// breath (0..1 amplitude), bookLift, armOut, wave, tap, stride, sleep, flail,
// armMotion, stretch, shake, write; `arm` / `armB` / `armW` pick an arm variant;
// `phase` is the walk cycle angle and is taken as it is.

import { smooth, wobble } from '../../engine/rig.js';

const DEG = Math.PI / 180;

export const PARAM_DEFAULTS = {
  headTilt: 0, headNod: 0, lean: 0, breath: 1, bookLift: 0, armOut: 0, wave: 0, tap: 0, stride: 0,
  sleep: 0, flail: 1, armMotion: 0, stretch: 0, shake: 0, write: 0,
};
// the front arm group's variant is picked by `arm` (armB and armW by their own names)
export const VARIANT_PARAMS = { armF: 'arm' };

// ---------------- skins beyond rigid / chain ----------------

export const SKINS = {
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
    // by walk.stride in index.js so the planted foot does not slide
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

export const POSERS = { stand: poseStand, walk: poseWalk, sit: poseSit, drag: poseDrag, work: poseWork };
