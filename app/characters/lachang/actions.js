// The dachshund's action library: timed performances on the standing rig.
//
// An action is { dur, pose(t, ctx), cues: [[time, fn(ctx)], ...], next?, pool? }.
//   pose(t) returns rig parameters (see posers.js) plus the view extras the engine
//     knows: dx/dy (px at medium size), rot, sx/sy, and face patches: face (whole
//     face), eyes, mouth, blush.
//   cues run once when their time is reached; ctx.say(kind) picks a line from
//     lines.js, ctx.fx.* emits effects placed around the head and feet.
//   pool: weight in the idle pick (0 = only on request).

import { ease } from '../../engine/anim.js';

const between = (t, a, b) => t >= a && t <= b;
const bump = (t, a, b) => (between(t, a, b) ? Math.sin(((t - a) / (b - a)) * Math.PI) : 0);
const ramp = (t, a, b) => ease.smooth(Math.max(0, Math.min(1, (t - a) / (b - a))));
const hop = (t, a, b, h) => -h * bump(t, a, b);

export const ACTIONS = {
  // happy: tail going, ears up, two little bounces
  wag: {
    dur: 2.6, pool: 3,
    pose: (t) => ({
      tailWag: 1, tailUp: 20, earLift: 0.8 * ramp(t, 0, 0.3) * (1 - ramp(t, 2.2, 2.6)),
      headTilt: 4 * Math.sin(t * 5), dy: hop(t, 0.3, 0.6, 12) + hop(t, 0.9, 1.2, 10),
      face: t > 0.4 ? 'happy' : undefined,
    }),
    cues: [[0.1, (c) => c.say('wag')], [0.3, (c) => c.fx.hearts(2)], [1.0, (c) => c.fx.sparkles(3)]],
  },
  // a bark: ears up, head thrust forward with each woof, the mouth opens
  bark: {
    dur: 1.6, pool: 2,
    pose: (t) => {
      const woof = bump(t, 0.2, 0.45) + bump(t, 0.6, 0.85);
      return {
        earLift: 1, headNod: -6 * woof, bend: -4 * woof, lean: -2 * woof, tailUp: 15,
        mouth: woof > 0.5 ? 'a' : undefined, sy: 1 + 0.03 * woof,
      };
    },
    cues: [[0.2, (c) => c.say('bark')], [0.22, (c) => c.fx.mark('!')], [0.62, (c) => c.fx.burst(4)]],
  },
  // curious: head tilts to one side, ears perk, then the other side
  tilt: {
    dur: 2.8, pool: 3,
    pose: (t) => ({
      headTilt: 18 * ramp(t, 0.2, 0.6) * (1 - ramp(t, 1.4, 1.7)) - 14 * ramp(t, 1.7, 2.1) * (1 - ramp(t, 2.4, 2.8)),
      earLift: 0.9 * ramp(t, 0.1, 0.4) * (1 - ramp(t, 2.4, 2.8)), gazeX: 0.5, gazeY: -0.3,
    }),
    cues: [[0.5, (c) => c.say('tilt')], [0.6, (c) => c.fx.mark('?')]],
  },
  // the wet-dog shake, then a satisfied look
  shake: {
    dur: 2.2, pool: 1,
    pose: (t) => ({
      shake: bump(t, 0.2, 1.4) ** 0.5, earLift: 0.3 * bump(t, 0.2, 1.4), tailWag: t > 1.5 ? 0.6 : 0,
      face: between(t, 0.2, 1.4) ? 'blink' : undefined, dy: -3 * bump(t, 0.2, 1.4),
    }),
    cues: [[0.2, (c) => c.say('shake')], [0.35, (c) => c.fx.dust()], [0.8, (c) => c.fx.sparkles(4)]],
  },
  // play bow: front down, rump up, tail wagging, a hop out of it
  bow: {
    dur: 3.0, pool: 2,
    pose: (t) => ({
      crouch: ramp(t, 0.1, 0.5) * (1 - ramp(t, 2.3, 2.6)), tailWag: 1, tailUp: 25,
      earLift: 0.5, face: t > 0.6 ? 'happy' : undefined, dy: hop(t, 2.5, 2.8, 14),
    }),
    cues: [[0.5, (c) => c.say('bow')], [0.6, (c) => c.fx.hearts(1)], [2.55, (c) => c.fx.dust()]],
  },
  // sniffing along the ground
  sniff: {
    dur: 3.2, pool: 2,
    pose: (t) => ({
      sniff: ramp(t, 0.1, 0.6) * (1 - ramp(t, 2.6, 3.0)),
      headNod: 2 * Math.sin(t * 2 * Math.PI * 4), dx: -14 * ramp(t, 0.8, 2.4) * (1 - ramp(t, 2.6, 3.0)),
      tailWag: between(t, 2.0, 2.6) ? 0.8 : 0, gazeY: 0.8,
    }),
    cues: [[0.8, (c) => c.say('sniff')], [2.2, (c) => c.fx.mark('!')]],
  },
  // a hind leg scratching behind the ear
  scratch: {
    dur: 2.4, pool: 2,
    pose: (t) => ({
      scratch: ramp(t, 0.1, 0.4) * (1 - ramp(t, 1.9, 2.2)), headTilt: -4, eyes: between(t, 0.4, 1.9) ? 'half' : undefined,
    }),
    cues: [[1.0, (c) => c.fx.stars(2)]],
  },
  // angry: lowered head, growling face, tail stiff
  growl: {
    dur: 2.6, pool: 0,
    pose: (t) => ({
      face: 'angry', earLift: 0.2, lean: -3, bend: -3, headNod: 4, tailUp: 10,
      dx: 2 * Math.sin(t * 40) * bump(t, 0.3, 0.8),
    }),
    cues: [[0.2, (c) => c.say('growl')], [0.3, (c) => c.fx.vein()], [1.4, (c) => c.fx.steam()]],
  },
  // a long howl, nose up
  howl: {
    dur: 3.0, pool: 1,
    pose: (t) => ({
      bend: -8 * ramp(t, 0.1, 0.6) * (1 - ramp(t, 2.4, 2.8)), headNod: -8 * ramp(t, 0.1, 0.6) * (1 - ramp(t, 2.4, 2.8)),
      headTilt: -15 * ramp(t, 0.1, 0.6) * (1 - ramp(t, 2.4, 2.8)), mouth: between(t, 0.6, 2.3) ? 'o' : undefined,
      eyes: between(t, 0.6, 2.3) ? 'blink' : undefined, tailUp: 10,
    }),
    cues: [[0.6, (c) => c.say('howl')], [0.8, (c) => c.fx.notes(2)], [1.6, (c) => c.fx.notes(2)]],
  },
  // sad: ears and tail down, puppy eyes, a gloom over the head
  sad: {
    dur: 3.4, pool: 1,
    pose: (t) => ({
      face: 'sad', earLift: -0.3, tailUp: -15, headNod: 6, bend: 4, lean: 1,
    }),
    cues: [[0.3, (c) => c.say('sad')], [0.5, (c) => c.fx.gloom()], [1.8, (c) => c.fx.sweat()]],
  },
  // yawn: eyes squeeze, mouth wide, a stretch after
  yawn: {
    dur: 3.0, pool: 1,
    pose: (t) => ({
      mouth: between(t, 0.5, 1.8) ? 'a' : undefined, eyes: between(t, 0.5, 1.8) ? 'blink' : t > 1.8 ? 'half' : undefined,
      headNod: -6 * bump(t, 0.4, 1.9), bend: -4 * bump(t, 0.4, 1.9), crouch: 0.5 * bump(t, 2.0, 3.0), earLift: -0.2,
    }),
    cues: [[0.5, (c) => c.say('yawn')]],
  },
  // startled: a jump with wide eyes, then a sheepish ear flick
  startled: {
    dur: 1.8, pool: 1,
    pose: (t) => ({
      face: t < 1.1 ? 'surprised' : undefined, earLift: 1, dy: hop(t, 0.05, 0.4, 26), sy: t < 0.08 ? 0.92 : 1,
      lean: 3 * bump(t, 0.05, 0.5), tailUp: -10,
    }),
    cues: [[0.05, (c) => c.fx.mark('!')], [0.08, (c) => c.say('land')], [0.4, (c) => c.fx.dust()]],
  },
  // sly: a sideways look and a lopsided grin, tail tip twitching
  smirk: {
    dur: 2.6, pool: 1,
    pose: (t) => ({ face: 'smirk', headTilt: 6, tailWag: 0.25, gazeX: 0.7 }),
    cues: [[0.4, (c) => c.say('smirk')], [0.6, (c) => c.fx.stars(1)]],
  },
  // a bouncy little dance: hops side to side with the tail going
  dance: {
    dur: 3.2, pool: 1,
    pose: (t) => {
      const beat = t * 2 * Math.PI * 2.2;
      return {
        tailWag: 1, tailUp: 20, earLift: 0.6, face: 'happy',
        dy: -10 * Math.abs(Math.sin(beat)), dx: 10 * Math.sin(beat / 2), headTilt: 8 * Math.sin(beat / 2),
        lean: 2 * Math.sin(beat / 2),
      };
    },
    cues: [[0.2, (c) => c.fx.notes(2)], [1.2, (c) => c.fx.notes(2)], [2.2, (c) => c.fx.notes(2)]],
  },
  // panting with the tongue out after running about
  pant: {
    dur: 3.0, pool: 1,
    pose: (t) => ({ mouth: 'tongue', breath: 2.5, earLift: 0.2, tailWag: 0.5, headNod: 1.5 * Math.sin(t * 2 * Math.PI * 2.5) }),
    cues: [[0.5, (c) => c.say('wag')]],
  },
  // a wink
  wink: {
    dur: 1.4, pool: 1,
    pose: (t) => ({ eyes: between(t, 0.3, 1.0) ? 'wink' : undefined, headTilt: 6 * bump(t, 0.2, 1.1), tailWag: 0.6 }),
    cues: [[0.35, (c) => c.fx.stars(1)]],
  },
};

export const ACTION_NAMES = Object.keys(ACTIONS);

// an action for idle moments, weighted by `pool`
export function pickIdleAction(rand = Math.random) {
  const pool = ACTION_NAMES.filter((n) => ACTIONS[n].pool > 0);
  const total = pool.reduce((s, n) => s + ACTIONS[n].pool, 0);
  let r = rand() * total;
  for (const n of pool) {
    r -= ACTIONS[n].pool;
    if (r <= 0) return n;
  }
  return pool[pool.length - 1];
}

// sanity checks for the tests: every action's timeline is well formed
export function validateActions() {
  const problems = [];
  for (const [name, a] of Object.entries(ACTIONS)) {
    if (!(a.dur > 0)) problems.push(`${name}: dur`);
    if (typeof a.pose !== 'function') problems.push(`${name}: pose`);
    if (!Array.isArray(a.cues)) problems.push(`${name}: cues`);
    for (const [at] of a.cues || []) if (at > a.dur) problems.push(`${name}: cue after the end`);
    if (a.next && !ACTIONS[a.next]) problems.push(`${name}: next ${a.next}`);
  }
  return problems;
}
