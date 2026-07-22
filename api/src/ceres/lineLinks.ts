export function withExternalBrowser(url: string): string {
  const fragmentIndex = url.indexOf('#');
  const beforeFragment = fragmentIndex === -1 ? url : url.slice(0, fragmentIndex);
  const fragment = fragmentIndex === -1 ? '' : url.slice(fragmentIndex);
  const separator = beforeFragment.includes('?')
    ? (beforeFragment.endsWith('?') || beforeFragment.endsWith('&') ? '' : '&')
    : '?';

  return `${beforeFragment}${separator}openExternalBrowser=1${fragment}`;
}
