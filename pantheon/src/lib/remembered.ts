const KEY = 'pantheon_remembered_logins';
const MAX = 3;

export interface RememberedLogin {
  email: string;
  lastUsedAt: number;
}

function writeRemembered(logins: RememberedLogin[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(logins));
  } catch {
    // Remembered users are a display shortcut; unavailable storage must never block login.
  }
}

export function getRemembered(): RememberedLogin[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (
      !Array.isArray(parsed) ||
      !parsed.every(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as Record<string, unknown>).email === 'string' &&
          typeof (entry as Record<string, unknown>).lastUsedAt === 'number' &&
          Number.isFinite((entry as Record<string, unknown>).lastUsedAt),
      )
    ) {
      return [];
    }

    return parsed
      .map((entry) => ({ email: entry.email, lastUsedAt: entry.lastUsedAt }))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  } catch {
    return [];
  }
}

export function rememberLogin(email: string): void {
  const next = [
    { email, lastUsedAt: Date.now() },
    ...getRemembered().filter((entry) => entry.email !== email),
  ].slice(0, MAX);
  writeRemembered(next);
}

export function forgetLogin(email: string): void {
  writeRemembered(getRemembered().filter((entry) => entry.email !== email));
}

export function pruneRemembered(valid: (email: string) => boolean): RememberedLogin[] {
  const remembered = getRemembered();
  const kept = remembered.filter((entry) => valid(entry.email));
  if (kept.length !== remembered.length) writeRemembered(kept);
  return kept;
}
