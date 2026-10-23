// The Claude character pack: everything the engine needs to know about her.
// (Window size, menu and the action/expression lists the API validates against live
// in character.json, which the main process reads too; the renderer merges both.)

import { ACTIONS, pickIdleAction } from './actions.js';
import { ClaudePet } from './behaviour.js';
import { pick, timeGreeting } from './lines.js';
import { PARAM_DEFAULTS, POSERS, SKINS, VARIANT_PARAMS } from './posers.js';

export default {
  Pet: ClaudePet,
  // rigs: how they are skinned and posed
  posers: POSERS,
  skins: SKINS,
  paramDefaults: PARAM_DEFAULTS,
  variantParams: VARIANT_PARAMS,
  headBone: 'head',
  // face patches of these groups follow another bone than the head
  faceGroups: { book: 'chest' },
  // which rig draws which sprite (a sprite without a rig is drawn whole)
  rigFor: { idle: 'stand', wave_a: 'stand', wave_b: 'stand', think: 'stand', walk: 'walk', sit_read: 'sit', drag: 'drag', work: 'work' },
  // which face patch set each sprite uses
  faceSets: { idle: 'idle', wave_a: 'idle', wave_b: 'idle', think: 'idle', sit_read: 'sit', walk: 'walk', work: 'desk' },
  // DIP/s at medium size, and step length / her height (see poseWalk)
  walk: { speed: 56, stride: 0.14 },
  // contact shadow width / her height per sprite (0.5 otherwise)
  shadowWidth: { sit_read: 0.78, work: 1.1, walk: 0.55 },
  // states that ignore idle decisions and most reactions
  busyStates: ['work_in', 'work', 'work_out'],
  // states in which stroking her head counts as petting
  pettable: ['idle', 'sit', 'think', 'work'],
  // library actions the engine's generic reactions reach for
  reactions: {
    poke: 'angry',
    thrown: ['awkward', 'angry'],
    doubleClick: 'raise_hand',
    petted: 'shy',
    click: ['giggle', 'wink', 'confused', 'startled', 'smirk', 'point', 'proud'],
    attention: 'raise_hand',
    done: 'cheer_on',
  },
  actions: ACTIONS,
  pickIdleAction,
  lines: { pick, timeGreeting },
};
