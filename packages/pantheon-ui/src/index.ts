// @pantheon/ui — shared, byte-identical frontend primitives for the Pantheon suite login
// screens + app switcher. Raw TS, no build step: consumers compile the source directly
// (Vite via a resolve.alias to this src, tsc via the workspace symlink + exports map).
export * from './avatar';
export * from './loginGroups';
export * from './appName';
