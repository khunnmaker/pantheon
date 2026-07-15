import type { Role } from '../auth/jwt.js';

export function isApolloManager(role: Role | undefined): boolean {
  return role === 'supervisor' || role === 'gm';
}
