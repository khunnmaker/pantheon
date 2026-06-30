import jwt from 'jsonwebtoken';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { env } from '../env.js';
import { prisma } from '../db/prisma.js';

// Diana (B2B website) customer auth. Deliberately SEPARATE from staff auth
// (auth/jwt.ts + auth/middleware.ts): a clinic is a ClinicAccount, not an Agent.
// Tokens carry `typ: 'clinic'` so a clinic token can never be accepted where a
// staff token is expected (and vice-versa), even though both are signed with the
// same JWT_SECRET. Approval status is re-read live on every request — exactly like
// staff role — so an approval or a block takes effect immediately, not at expiry.

export type ClinicStatus = 'pending' | 'approved' | 'rejected';

// What we hydrate onto request.clinic (status is the LIVE DB value, not the claim).
export interface AuthedClinic {
  id: string;
  email: string;
  clinicName: string;
  status: ClinicStatus;
}

const EXPIRES_IN = '12h';
const TOKEN_TYPE = 'clinic';

declare module 'fastify' {
  interface FastifyRequest {
    clinic?: AuthedClinic;
  }
}

export function signClinicToken(c: { id: string; email: string; clinicName: string }): string {
  return jwt.sign(
    { email: c.email, clinicName: c.clinicName, typ: TOKEN_TYPE },
    env.JWT_SECRET,
    { subject: c.id, expiresIn: EXPIRES_IN, algorithm: 'HS256' },
  );
}

// Returns the clinic's id, or null if the token is missing/invalid/expired/not a
// clinic token. Identity is only a signed claim of `sub`; the account is re-read below.
export function verifyClinicToken(token: string): { id: string } | null {
  try {
    const p = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (!p.sub || p.typ !== TOKEN_TYPE) return null;
    return { id: String(p.sub) };
  } catch {
    return null;
  }
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice('Bearer '.length).trim() || null;
}

// Resolve a bearer token to the LIVE ClinicAccount. Returns null if the token is
// invalid or the account no longer exists.
export async function authedClinicFromToken(token: string | null): Promise<AuthedClinic | null> {
  const claims = token ? verifyClinicToken(token) : null;
  if (!claims) return null;
  const live = await prisma.clinicAccount.findUnique({
    where: { id: claims.id },
    select: { id: true, email: true, clinicName: true, status: true },
  });
  if (!live) return null;
  return { id: live.id, email: live.email, clinicName: live.clinicName, status: live.status as ClinicStatus };
}

// preHandler: require a logged-in clinic of ANY status (pending/approved/rejected).
// Used for /me and profile — so a pending clinic can still log in and see its status.
export const requireClinic: preHandlerHookHandler = async (req: FastifyRequest, reply: FastifyReply) => {
  const clinic = await authedClinicFromToken(bearer(req));
  if (!clinic) return reply.code(401).send({ error: 'unauthorized' });
  req.clinic = clinic;
};

// preHandler: require an APPROVED clinic. This is the core B2B gate — prices, live
// stock, and ordering all sit behind it. A pending/rejected clinic gets 403.
export const requireApprovedClinic: preHandlerHookHandler = async (req: FastifyRequest, reply: FastifyReply) => {
  const clinic = await authedClinicFromToken(bearer(req));
  if (!clinic) return reply.code(401).send({ error: 'unauthorized' });
  if (clinic.status !== 'approved') {
    return reply.code(403).send({ error: 'not_approved', status: clinic.status });
  }
  req.clinic = clinic;
};
