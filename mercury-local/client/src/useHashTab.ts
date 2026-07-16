import { useCallback, useEffect, useState } from 'react';

// Local copy of the shared @pantheon/ui useHashTab hook — mercury-local isn't a workspace
// member (it's the owner's standalone on-prem node, own package.json/lockfile, no
// @pantheon/ui dependency), so this is duplicated here rather than adding a workspace
// dependency across the local/cloud boundary. Keep in sync with
// packages/pantheon-ui/src/hashTab.ts if the shared version changes.
//
// Syncs the app's top-level tab state with location.hash, so F5 keeps the user on their
// current tab and the URL is shareable. Uses history.replaceState (never pushState) — this is
// view-restore, not a navigation stack, so the back button's behavior is unchanged from a plain
// useState. An unknown/invalid hash falls back to defaultKey silently (no error UI).
export function useHashTab<T extends string>(validKeys: readonly T[], defaultKey: T): [T, (key: T) => void] {
  const readFromHash = useCallback((keys: readonly T[]): T => {
    const raw = location.hash.slice(1);
    return (keys as readonly string[]).includes(raw) ? (raw as T) : defaultKey;
  }, [defaultKey]);

  const [tab, setTab] = useState<T>(() => readFromHash(validKeys));

  const keysSignature = validKeys.join('|');

  // Re-validate whenever the allowed set changes shape so a key that's no longer valid falls
  // back instead of pointing at a tab that doesn't render.
  useEffect(() => {
    setTab((current) => ((validKeys as readonly string[]).includes(current) ? current : defaultKey));
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
