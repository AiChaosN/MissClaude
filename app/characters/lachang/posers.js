// How the dachshund's rig moves. One rig (stand) does both standing and trotting.
//
// Bones: root > body (rear torso, pivot at the hips) > chest (front torso, pivot
// mid-body: the sausage bends here) > head (pivot at the neck) > earL/earR (+ tips),
// eyeL/eyeR; tail (+ tip) hangs off the body; legFL/legFR off the chest, legBL/legBR
// off the body. Ears and tail are spring chains, so the poser only sets their base
// angle and the physics adds the flop.
//
// Parameters (eased): headTilt (deg), headNod (px), earLift (0..1: ears perk up),
// tailWag (0..1), tailUp (deg), bend (deg: front curls up/down), breath (0..1),
// stride (0..1), shake (0..1: wet-dog shake), crouch (0..1: play bow), lean (deg),
// scratch (0..1: a hind leg scratching), sniff (0..1: nose to the ground);
// `phase` (walk cycle angle) is taken as it is.

import { wobble } from '../../engine/rig.js';

const DEG = Math.PI / 180;

export const PARAM_DEFAULTS = {
  headTilt: 0, headNod: 0, earLift: 0, tailWag: 0, tailUp: 0, bend: 0, breath: 1, stride: 0,
  shake: 0, crouch: 0, lean: 0, scratch: 0, sniff: 0,
};
export const VARIANT_PARAMS = {};

export const SKINS = {
  // the long body: the front half follows the chest bone, the rear half the body bone,
  // the neck fur near the head lags toward the head
  spine: (x, y, spec) => {
    const t = Math.max(0, Math.min(1, (x - spec.x0) / (spec.x1 - spec.x0)));
    const s = t * t * (3 - 2 * t);
    const w = {};
    let headW = 0;
    if (x < spec.neckX) {
      const u = Math.max(0, Math.min(1, (spec.neckY[1] - y) / (spec.neckY[1] - spec.neckY[0])));
      headW = 0.6 * u * u;
    }
    if (headW > 1e-3) w.head = headW;
    if ((1 - headW) * (1 - s) > 1e-3) w.chest = (1 - headW) * (1 - s);
    if ((1 - headW) * s > 1e-3) w.body = (1 - headW) * s;
    return w;
  },
};

// Standing and trotting. The dog faces -x: a positive leg angle swings the paw forward.
// Trot: diagonal pairs (front-left with back-right) swing together, half a cycle apart
// from the other pair; the body is highest while the legs pass under it.
function poseStand(B, t, p) {
  const breath = Math.sin((t * 2 * Math.PI) / 2.6) * p.breath;
  B.chest.scaleY = 1 + 0.014 * breath;
  B.body.scaleY = 1 + 0.008 * breath;
  const st = p.stride;
  const ph = p.phase;
  const pass = Math.abs(Math.sin(ph));
  B.body.angle = (p.lean + 0.4 * wobble(t * 0.3, 4) - 12 * p.crouch + 1.0 * st * Math.cos(2 * ph)) * DEG;
  B.body.ty = -10 * st * pass;
  B.chest.angle = (p.bend + 0.5 * wobble(t * 0.35, 1) + 8 * p.crouch + 10 * p.sniff) * DEG;
  B.chest.ty = 40 * p.crouch;
  B.head.angle = (p.headTilt + 1.6 * wobble(t * 0.42, 2) + 18 * p.sniff + 2.5 * st * Math.cos(ph - 0.6)) * DEG;
  B.head.ty = p.headNod - 1.2 * breath + 10 * p.sniff + 1.5 * st * Math.abs(Math.sin(ph - 0.5));
  // ears: hang; perk up and out when alert, flick now and then on their own
  const flick = Math.max(0, Math.sin(t * 0.7 + 1.0)) ** 30;
  B.earL.angle = (-16 * p.earLift - 6 * flick + 0.8 * wobble(t * 0.5, 7)) * DEG;
  B.earR.angle = (14 * p.earLift + 0.8 * wobble(t * 0.5, 8)) * DEG;
  if (B.earL1) B.earL1.angle = (-6 * p.earLift) * DEG;
  if (B.earR1) B.earR1.angle = (5 * p.earLift) * DEG;
  // tail: raised when happy, wagging fast; a slow sway otherwise
  const wag = Math.sin(t * 2 * Math.PI * 5.5);
  B.tail.angle = (-p.tailUp - 2 * wobble(t * 0.4, 3) + p.tailWag * 22 * wag) * DEG;
  if (B.tail1) B.tail1.angle = (p.tailWag * 14 * Math.sin(t * 2 * Math.PI * 5.5 - 0.9) - 0.5 * p.tailUp) * DEG;
  // legs
  const legs = [['legFL', 0], ['legBR', 0], ['legFR', Math.PI], ['legBL', Math.PI]];
  for (const [leg, off] of legs) {
    const b = B[leg];
    if (!b) continue;
    const a = ph + off;
    b.angle = 22 * st * Math.cos(a) * DEG;
    b.ty = -14 * st * Math.max(0, -Math.sin(a));
    b.scaleY = 1;
  }
  // play bow: the front legs fold flat, the rear stays up
  B.legFL.scaleY = 1 - 0.45 * p.crouch;
  B.legFR.scaleY = 1 - 0.45 * p.crouch;
  B.legFL.angle += 14 * p.crouch * DEG;
  B.legFR.angle += 14 * p.crouch * DEG;
  // scratching: the near hind leg paddles at the ear, the head leans into it
  if (p.scratch > 0.01) {
    B.legBL.angle += p.scratch * (-35 + 18 * Math.sin(t * 2 * Math.PI * 9)) * DEG;
    B.legBL.ty += -24 * p.scratch;
    B.head.angle += p.scratch * (10 + 3 * Math.sin(t * 2 * Math.PI * 9)) * DEG;
  }
  // wet-dog shake: a fast twist through the whole body, head and tail lagging
  if (p.shake > 0.01) {
    const s = Math.sin(t * 2 * Math.PI * 9);
    B.chest.angle += p.shake * 3.5 * s * DEG;
    B.head.angle += p.shake * 7 * Math.sin(t * 2 * Math.PI * 9 - 0.7) * DEG;
    B.body.angle += p.shake * 1.5 * Math.sin(t * 2 * Math.PI * 9 + 0.5) * DEG;
    B.tail.angle += p.shake * 10 * Math.sin(t * 2 * Math.PI * 9 - 1.2) * DEG;
  }
}

export const POSERS = { stand: poseStand };
