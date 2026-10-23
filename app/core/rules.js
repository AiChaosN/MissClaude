'use strict';
// Declarative reactions to signals pushed into the pet.
//
// A signal is a named JSON value (e.g. "claude.usage" -> {percent: 83, ...}).
// A rule watches one signal and fires when all of its conditions hold:
//
//   {
//     "id": "usage-80",
//     "signal": "claude.usage",
//     "when": [{ "path": "percent", "op": ">=", "value": 80 }],
//     "say": "额度已经用了 {percent}% 啦",      // {path} reads from the signal value;
//                                                //   a list picks one line at random
//     "expression": "surprised",                 // optional
//     "action": "think",                         // optional
//     "steps": [{ "at": 0, "action": "wave" },   // optional: a timed performance instead
//               { "at": 1.5, "say": "..." }],    //   (see PetController.perform)
//     "priority": "high",                        // optional, speech priority
//     "cooldown": 3600                           // seconds before it may fire again
//   }
//
// Level ops (> >= < <= == != exists) hold while the condition is true, so pair them
// with a cooldown. Edge ops (crosses_above, crosses_below, changed) need a previous
// value and fire once per crossing.

const LEVEL = {
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  exists: (a) => a !== undefined && a !== null,
};
const EDGE = ['crosses_above', 'crosses_below', 'changed'];
const OPS = [...Object.keys(LEVEL), ...EDGE];

function getPath(obj, path) {
  if (!path) return obj;
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function holds(cond, cur, prev) {
  const a = getPath(cur, cond.path);
  if (cond.op in LEVEL) return a !== undefined && LEVEL[cond.op](a, cond.value);
  if (prev === undefined) return false;
  const p = getPath(prev, cond.path);
  switch (cond.op) {
    case 'crosses_above': return typeof a === 'number' && typeof p === 'number' && p < cond.value && a >= cond.value;
    case 'crosses_below': return typeof a === 'number' && typeof p === 'number' && p > cond.value && a <= cond.value;
    case 'changed': return JSON.stringify(a) !== JSON.stringify(p);
    default: return false;
  }
}

function format(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, '');
  if (v === undefined || v === null) return '?';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

// "{percent}% used" with value {percent: 83} -> "83% used"; "{}" is the whole value
function renderTemplate(template, value) {
  return String(template).replace(/\{([\w.]*)\}/g, (_, path) => format(getPath(value, path)));
}

function validateRule(r, i) {
  const where = `rule ${r && r.id ? `"${r.id}"` : `#${i}`}`;
  if (!r || typeof r !== 'object') throw new Error(`${where}: must be an object`);
  if (!r.id || typeof r.id !== 'string') throw new Error(`${where}: "id" (string) is required`);
  if (!r.signal || typeof r.signal !== 'string') throw new Error(`${where}: "signal" (string) is required`);
  const conds = r.when === undefined ? [] : Array.isArray(r.when) ? r.when : [r.when];
  for (const c of conds) {
    if (!OPS.includes(c.op)) throw new Error(`${where}: unknown op "${c.op}" (use ${OPS.join(', ')})`);
  }
  if (r.say !== undefined && typeof r.say !== 'string' && !(Array.isArray(r.say) && r.say.every((x) => typeof x === 'string'))) {
    throw new Error(`${where}: "say" must be a string or a list of strings`);
  }
  if (r.steps !== undefined && !Array.isArray(r.steps)) throw new Error(`${where}: "steps" must be a list`);
  if (!r.say && !r.action && !r.expression && !r.steps) {
    throw new Error(`${where}: needs "say", "action", "expression" or "steps"`);
  }
  return { ...r, when: conds };
}

class RuleEngine {
  constructor(rules = []) {
    this.last = new Map();     // signal -> latest value
    this.firedAt = new Map();  // rule id -> ms timestamp
    this.setRules(rules);
  }

  setRules(rules) {
    if (!Array.isArray(rules)) throw new Error('rules must be an array');
    const checked = rules.map(validateRule);
    const ids = new Set();
    for (const r of checked) {
      if (ids.has(r.id)) throw new Error(`duplicate rule id "${r.id}"`);
      ids.add(r.id);
    }
    this.rules = checked;
  }

  // Record a new value; return the reactions of every rule that fires.
  push(signal, value, now = Date.now()) {
    const prev = this.last.get(signal);
    this.last.set(signal, value);
    const fired = [];
    for (const r of this.rules) {
      if (r.enabled === false || r.signal !== signal) continue;
      if (!r.when.every((c) => holds(c, value, prev))) continue;
      const last = this.firedAt.get(r.id);
      if (last !== undefined && now - last < (r.cooldown || 0) * 1000) continue;
      this.firedAt.set(r.id, now);
      const line = Array.isArray(r.say) ? r.say[Math.floor(Math.random() * r.say.length)] : r.say;
      fired.push({
        rule: r.id,
        say: line ? renderTemplate(line, value) : null,
        steps: r.steps || null,
        action: r.action || null,
        expression: r.expression || null,
        priority: r.priority || 'normal',
        duration: r.duration || null,
      });
    }
    return fired;
  }

  // forget previous values and cooldowns (e.g. before replaying a test curve)
  reset() {
    this.last.clear();
    this.firedAt.clear();
  }

  signals() {
    return Object.fromEntries(this.last);
  }
}

module.exports = { RuleEngine, renderTemplate, getPath, OPS };
