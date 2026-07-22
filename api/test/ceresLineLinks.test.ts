import { describe, expect, it } from 'vitest';
import { withExternalBrowser } from '../src/ceres/lineLinks.js';

describe('withExternalBrowser', () => {
  it.each([
    ['https://ceres.prominentdental.com/requests/1', 'https://ceres.prominentdental.com/requests/1?openExternalBrowser=1'],
    ['https://ceres.prominentdental.com/?request=1', 'https://ceres.prominentdental.com/?request=1&openExternalBrowser=1'],
    ['https://ceres.prominentdental.com/requests/1#receipt', 'https://ceres.prominentdental.com/requests/1?openExternalBrowser=1#receipt'],
    ['https://ceres.example.test/requests/1?tab=mine#receipt', 'https://ceres.example.test/requests/1?tab=mine&openExternalBrowser=1#receipt'],
  ])('adds the LINE external-browser parameter to %s', (url, expected) => {
    expect(withExternalBrowser(url)).toBe(expected);
  });
});
