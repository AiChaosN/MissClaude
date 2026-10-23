// The dachshund's own behaviour on top of the engine: what it does when idle (sits,
// flops down, dozes off, begs), how it greets and reacts, and how its states and
// expressions map onto the rig's parameters.

import { rand } from '../../engine/anim.js';
import { Pet } from '../../engine/pet.js';
import { PARAM_DEFAULTS } from './posers.js';

// whole-sprite poses: no rig, the sprite just breathes
const RESTING = ['sit', 'lie', 'sleep', 'beg'];

export class LachangPet extends Pet {
  greet() {
    this.playAction('wag');
    super.greet();
  }

  // ---------------- rig ----------------

  rigParams() {
    const p = { ...PARAM_DEFAULTS };
    const P = this.state === 'act' && this.choreo ? this.choreo.pose : null;
    const expr = this.expr && this.t < this.exprUntil ? this.expr : null;
    const look = this.glance ? this.glance.dir : this.look;
    p.headTilt = 3 * look;
    if (this.state === 'walk') {
      p.stride = 1;
      p.earLift = 0.3;
      p.tailUp = 12;
    }
    if (expr === 'happy') {
      p.tailWag = 1;
      p.tailUp = 20;
      p.earLift = 0.5;
    } else if (expr === 'surprised') {
      p.earLift = 1;
      p.tailUp = -5;
      p.headNod = -3;
    } else if (expr === 'sad') {
      p.earLift = -0.3;
      p.tailUp = -15;
      p.headNod = 4;
    } else if (expr === 'angry') {
      p.earLift = 0.2;
      p.tailUp = 10;
      p.lean = -2;
    } else if (expr === 'tongue') {
      p.tailWag = 0.5;
      p.breath = 2;
    }
    if (P) {
      for (const key of Object.keys(PARAM_DEFAULTS)) if (P[key] !== undefined) p[key] = P[key];
    }
    if (this.talk.open) p.headNod += 1.5; // the woof bob
    p.phase = this.walkPhase;
    [p.gazeX, p.gazeY] = P && P.gazeX !== undefined ? [P.gazeX, P.gazeY || 0] : this.gazeTarget();
    return p;
  }

  // effects around the head: the dog's marks and notes sit a bit lower than hers
  actFx() {
    const fx = super.actFx();
    const h = this.winHead;
    const k = this.k;
    const F = this.fx;
    fx.mark = (text) => F.mark(h.x + 44 * k, h.y - 60 * k, k, text);
    fx.notes = (n) => F.notes(h.x + rand(-30, 30) * k, h.y - 52 * k, k, n);
    fx.bulb = () => F.bulb(h.x + 6 * k, h.y - 70 * k, k);
    return fx;
  }

  // ---------------- idle life ----------------

  // Claude Code is busy: sit and watch
  interruptIdle() {
    if (this.working && this.t >= this.nextDecision) {
      this.setState('sit', { dur: 600 });
      return true;
    }
    return false;
  }

  decide() {
    this.nextDecision = this.t + rand(4, 10);
    const r = Math.random();
    if (this.settings.wander && r < 0.36) {
      this.walkTo(this.randomTarget());
      return;
    }
    if (r < 0.46) return this.setState('sit', {});
    if (r < 0.52) return this.setState('lie', {});
    if (r < 0.82 && this.rig) {
      this.playAction(this.ch.pickIdleAction());
      return;
    }
    if (r < 0.88) {
      this.glance = { dir: Math.random() < 0.5 ? -1 : 1, until: this.t + rand(1.2, 2.2) };
      return;
    }
    this.chatter();
  }

  // a resting pose: sprite `name`, breathing, for `dur` seconds (then `after`)
  rest(name, dur, after) {
    this.restUntil = this.t + dur;
    this.restAfter = after;
    this.nextRestLine = this.t + rand(6, 14);
  }

  updateRest(name, breath = 1, period = 3.4) {
    this.foot.y = this.groundY();
    this.view = this.baseView(name, breath, period);
    const a = this.age;
    if (a < 0.3) this.view.sy *= 1 - 0.05 * Math.cos((a / 0.3) * Math.PI * 0.5); // settle
    if (this.t > this.nextRestLine) {
      this.nextRestLine = this.t + rand(12, 25);
      if (this.working && name === 'sit') this.say(this.pick('ccWork'));
      else if (!this.working && Math.random() < 0.3) this.say(this.pick(name));
    }
  }

  enter_sit({ dur }) {
    this.rest('sit', dur || rand(15, 40));
  }

  update_sit() {
    this.updateRest('sit', 0.8);
    if (this.working || this.t < this.restUntil) return;
    if (Math.random() < 0.3) this.setState('lie', {});
    else this.standUp();
  }

  enter_lie({ dur }) {
    this.rest('lie', dur || rand(15, 40));
    this.setExpression(null);
  }

  update_lie() {
    this.updateRest('lie', 1.1, 3.8);
    if (this.t < this.restUntil) return;
    if (Math.random() < 0.5) {
      if (Math.random() < 0.5) this.say(this.pick('sleepy'));
      this.setState('sleep', {});
    } else {
      this.standUp();
    }
  }

  enter_sleep({ dur }) {
    this.rest('sleep', dur || rand(60, 180));
    this.nextZ = this.t + 1.2;
  }

  update_sleep() {
    this.updateRest('sleep', 1.4, 4.6);
    if (this.t > this.nextZ) {
      this.nextZ = this.t + 1.5;
      const h = this.headNow();
      this.fx.zzz(h.x + 20 * this.k, h.y - 30 * this.k, this.k);
    }
    if (this.t > this.restUntil) this.wake();
  }

  enter_beg({ dur }) {
    this.rest('beg', dur || rand(3, 5));
    this.say(this.pick('beg'));
  }

  update_beg() {
    this.updateRest('beg', 1.2, 2.4);
    if (this.age > 0.3 && !this.begHeart) { // once seated up: a hopeful heart
      this.begHeart = true;
      const h = this.headNow();
      this.fx.hearts(h.x, h.y - 30 * this.k, this.k, 1);
    }
    if (this.t > this.restUntil) {
      this.begHeart = false;
      this.standUp();
    }
  }

  // ---------------- reactions ----------------

  onDoubleClick() {
    if (this.isBusy()) return;
    if (Math.random() < 0.5 && this.playAction('bark')) return;
    this.setState('beg', {});
  }

  reactClick() {
    if (this.isBusy() || this.state === 'act') return;
    const h = this.headNow();
    if (RESTING.includes(this.state)) { // stays put, pleased
      this.fx.hearts(h.x, h.y - 30 * this.k, this.k, 2);
      this.say(this.working ? this.pick('ccWork') : this.pick(this.state === 'beg' ? 'beg' : 'click'));
      return;
    }
    const pool = this.ch.reactions.click;
    if (Math.random() < 0.4 && this.rig && this.playAction(pool[Math.floor(Math.random() * pool.length)])) return;
    if (this.state !== 'idle') this.setState('idle');
    this.setExpression('happy', 1.6);
    this.hopAt = this.t;
    if (this.rig) this.rig.kick(1.6);
    this.fx.burst(h.x, h.y - 20 * this.k, this.k, 8);
    this.say(this.pick('click'));
  }

  onPetted() {
    const h = this.headNow();
    if (this.rig) this.rig.kick(0.6);
    this.emit('pet', { state: this.state });
    if (this.state === 'idle' && Math.random() < 0.45 && this.playAction('wag')) return;
    this.fx.hearts(h.x, h.y - 40 * this.k, this.k, 3);
    if (!RESTING.includes(this.state)) {
      if (this.state !== 'idle') this.setState('idle');
      this.setExpression('happy', 2);
    }
    this.say(this.pick('pet'));
  }

  // ---------------- inputs ----------------

  act(action, opts = {}) {
    if (['drag', 'fall'].includes(this.state)) return;
    switch (action) {
      case 'sit': this.setState('sit', { dur: opts.duration || rand(20, 50) }); break;
      case 'lie': this.setState('lie', { dur: opts.duration || rand(20, 50) }); break;
      case 'sleep': this.setState('sleep', { dur: opts.duration }); break;
      case 'beg': this.setState('beg', { dur: opts.duration }); break;
      default: super.act(action, opts); break;
    }
  }

  onClaudeCode(event, text) {
    if (['drag', 'fall'].includes(this.state)) return;
    const say = (line, priority = 'normal') => this.say(line, { source: 'claude_code', priority });
    switch (event) {
      case 'SessionStart':
        say(this.pick('ccStart'));
        this.playAction('wag');
        break;
      case 'UserPromptSubmit':
        this.working = true;
        say(this.pick('ccPrompt'));
        if (!RESTING.includes(this.state)) this.setState('sit', { dur: 600 });
        break;
      case 'PreToolUse':
      case 'PostToolUse':
        this.working = true;
        if (!RESTING.includes(this.state) && this.state !== 'act') this.setState('sit', { dur: 600 });
        break;
      case 'Notification':
        say(text && Array.from(text).length <= 24 ? text : this.pick('ccAttention'), 'high');
        if (RESTING.includes(this.state)) this.setState('idle');
        this.playAction('bark');
        break;
      case 'Stop':
        this.working = false;
        say(this.pick('ccDone'), 'high');
        if (RESTING.includes(this.state)) this.setState('idle');
        this.playAction(Math.random() < 0.5 ? 'wag' : 'dance');
        break;
      case 'SubagentStop': {
        const h = this.headNow();
        this.fx.sparkles(h.x, h.y, this.k, 3);
        break;
      }
      default:
        break;
    }
  }
}
