// Cute cartoon avatars for the login screen, generated entirely client-side (SVG → data URI, no
// network/CDN calls at runtime). Deterministic by seed, so the same person/team always gets the
// same face. Cached per (gender, seed) so re-renders don't regenerate the SVG.
import { createAvatar } from '@dicebear/core';
import { adventurer, funEmoji } from '@dicebear/collection';
import type { Gender } from './roster';

const memberCache = new Map<string, string>();
const teamCache = new Map<string, string>();

// Adventurer hair variants: long01..long26 read feminine, short01..short19 read masculine.
// We constrain the randomized hair pool by gender so messengers look male, sales female, etc.
const range = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(2, '0')}`);
const LONG_HAIR = range('long', 26);
const SHORT_HAIR = range('short', 19);

// Per-person avatar (used for the big L2 name tiles + L3 person banner). Seed on email normally;
// the caller passes the label instead for the one comingSoon card that has no email yet.
export function memberAvatar(seed: string, gender: Gender = 'male'): string {
  const key = `${gender}|${seed}`;
  const cached = memberCache.get(key);
  if (cached) return cached;
  const uri = createAvatar(adventurer, {
    seed,
    hair: (gender === 'female' ? LONG_HAIR : SHORT_HAIR) as unknown as undefined,
    hairProbability: 100,
    // Women slightly more likely to have earrings, men none — reinforces the read a bit.
    earringsProbability: gender === 'female' ? 40 : 0,
  }).toDataUri();
  memberCache.set(key, uri);
  return uri;
}

// Per-department mascot (used for the L1 department tiles). Seed on the stable group id.
export function teamAvatar(seed: string): string {
  const cached = teamCache.get(seed);
  if (cached) return cached;
  const uri = createAvatar(funEmoji, { seed }).toDataUri();
  teamCache.set(seed, uri);
  return uri;
}
