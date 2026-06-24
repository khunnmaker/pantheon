import jwt from 'jsonwebtoken';
import { env } from '../env.js';

export type Role = 'agent' | 'supervisor';

// What we put inside the signed token (and hydrate onto each request).
export interface AuthedAgent {
  id: string;
  email: string;
  name: string;
  role: Role;
}

const EXPIRES_IN = '12h';

export function signToken(agent: AuthedAgent): string {
  return jwt.sign(
    { email: agent.email, name: agent.name, role: agent.role },
    env.JWT_SECRET,
    { subject: agent.id, expiresIn: EXPIRES_IN, algorithm: 'HS256' },
  );
}

// Returns the agent identity, or null if the token is missing/invalid/expired.
export function verifyToken(token: string): AuthedAgent | null {
  try {
    // Pin the accepted algorithm so verification can't drift to another scheme.
    const p = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (!p.sub || (p.role !== 'agent' && p.role !== 'supervisor')) return null;
    return {
      id: String(p.sub),
      email: String(p.email ?? ''),
      name: String(p.name ?? ''),
      role: p.role,
    };
  } catch {
    return null;
  }
}
