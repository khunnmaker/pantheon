import { useCallback, useEffect, useState } from 'react';

// Syncs a staff app's top-level tab/view state with location.hash, so F5 keeps the user on
// their current tab and the URL is shareable (e.g. https://juno.prominentdental.com/#bills).
// Uses history.replaceState (never pushState) — this is view-restore, not a navigation stack,
// so the back button keeps behaving exactly as it did with a plain useState.
//
// validKeys can be role-gated (a scoped user's tab list is a subset of the full one) and may
// even change shape across renders as role/summary data resolves — every read re-validates
// against the CURRENT list, so an unknown, stale, or now-forbidden hash never throws or shows
// an error; it just falls back to defaultKey (e.g. a shared link to a CEO-only tab opened by a
// non-CEO agent lands on that agent's own default instead).
export function useHashTab<T extends string>(validKeys: readonly T[], defaultKey: T): [T, (key: T) => void] {
  const readFromHash = useCallback((keys: readonly T[]): T => {
    const raw = location.hash.slice(1);
    return (keys as readonly string[]).includes(raw) ? (raw as T) : defaultKey;
  }, [defaultKey]);

  const [tab, setTab] = useState<T>(() => readFromHash(validKeys));

  // validKeys is usually a fresh array literal every render (callers rebuild it from role
  // flags), so compare by content rather than identity — this is the effects' dependency.
  const keysSignature = validKeys.join('|');

  // Re-validate whenever the allowed set changes (e.g. role-gated tabs land after agent data
  // resolves) so a key that's no longer valid falls back instead of pointing at a tab that
  // doesn't render.
  useEffect(() => {
    setTab((current) => ((validKeys as readonly string[]).includes(current) ? current : defaultKey));
    // validKeys intentionally tracked via keysSignature, not the array reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysSignature, defaultKey]);

  // User edits the address bar or pastes a shared link into the same tab.
  useEffect(() => {
    const onHashChange = () => setTab(readFromHash(validKeys));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysSignature, readFromHash]);

  const set = useCallback((key: T) => {
    setTab(key);
    history.replaceState(null, '', '#' + key);
  }, []);

  return [tab, set];
}
