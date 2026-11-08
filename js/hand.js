// Opening-hand simulator: shuffle the 99, draw 7, mulligan (London), draw for turn,
// a keep/mulligan verdict, and the odds of a good land count.

import { info } from './builder.js';

/** The 99 as a flat list of names (the commander starts in the command zone). */
export function library(deck) {
  const out = [];
  for (const [name, count] of Object.entries(deck.cards)) for (let i = 0; i < count; i++) out.push(name);
  return out;
}

/** Fisher–Yates shuffle; `rand` can be injected for repeatable tests. */
export function shuffle(arr, rand = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function handStats(hand, lookup) {
  let lands = 0; let cheap = 0; let ramp = 0;
  for (const n of hand) {
    const c = lookup(n);
    if (!c) continue;
    const i = info(c);
    if (i.land) { lands++; continue; }
    if (c.cmc <= 2) cheap++;
    if (i.roles.has('ramp') && c.cmc <= 3) ramp++;
  }
  return { lands, spells: hand.length - lands, cheap, ramp };
}

/** A simple keep/mulligan read of a 7-card hand. */
export function verdict(s) {
  if (s.lands <= 1) return { keep: false, text: `Mulligan: ${s.lands ? 'one land' : 'no lands'} is too risky.` };
  if (s.lands >= 6) return { keep: false, text: 'Mulligan: too many lands and not enough to do.' };
  if (s.lands === 2 && !s.cheap && !s.ramp) return { keep: false, text: 'Risky: two lands and nothing cheap to cast. Most players would mulligan.' };
  if (s.lands === 5) return { keep: true, text: 'Keepable but slow: five lands. Hope to draw action.' };
  return { keep: true, text: `Keep: ${s.lands} lands${s.cheap ? ` and ${s.cheap} early play${s.cheap === 1 ? '' : 's'}` : ''}${s.ramp ? `, with ramp` : ''}.` };
}

function choose(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/** Probability of between lo and hi lands in a 7-card hand from a 99-card library. */
export function landOdds(lands, size = 99, lo = 2, hi = 4, draw = 7) {
  let p = 0;
  for (let k = lo; k <= hi; k++) p += (choose(lands, k) * choose(size - lands, draw - k)) / choose(size, draw);
  return p;
}
