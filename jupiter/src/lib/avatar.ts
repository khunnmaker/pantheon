// Cute cartoon avatars for the login screen, generated entirely client-side (SVG → data URI, no
// network/CDN calls at runtime). Deterministic by seed, so the same person/team always gets the
// same face. Cached per-seed so re-renders don't regenerate the SVG.
import { createAvatar } from '@dicebear/core';
import { adventurer, funEmoji } from '@dicebear/collection';

const memberCache = new Map<string, string>();
const teamCache = new Map<string, string>();

// Per-person avatar (used for the L2 name tiles + L3 person banner). Seed on email normally;
// the caller passes the label instead for the one comingSoon card that has no email yet.
export function memberAvatar(seed: string): string {
  const cached = memberCache.get(seed);
  if (cached) return cached;
  const uri = createAvatar(adventurer, { seed }).toDataUri();
  memberCache.set(seed, uri);
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
