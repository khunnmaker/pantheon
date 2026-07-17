// Canonical suite app names — the ONE frontend copy of the server SSOT
// (api/src/auth/jwt.ts APP_NAMES). Every app's switcher/access logic imports this
// instead of redefining its own list in src/lib/api.ts. Keep in sync with the server.
export type AppName = 'minerva' | 'vesta' | 'juno' | 'jupiter' | 'ceres' | 'mercury' | 'venus' | 'diana' | 'apollo' | 'olympus';
