import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth, requireApp, requireAuthScoped } from '../auth/middleware.js';
import { signOaSyncToken, OA_SYNC_SCOPE } from '../auth/jwt.js';
import { pushToConsole } from '../ws/io.js';

// Body posted by the passive Chrome MV3 extension's service worker. The extension only ever
// sends ids + names + the raw "Read" marker text — NEVER message bodies (see oa-sync-extension/).
const syncSchema = z.object({
  oaChatId: z.string().regex(/^U[0-9a-f]{32}$/),
  oaTitle: z.string().max(200).optional(),
  oaSubName: z.string().max(200).optional(),
  readLabel: z.string().max(60).optional(),
});

// OA read-sync endpoint. The LINE Messaging API has no outbound read receipts, and the OA
// Manager uses a DIFFERENT per-customer id namespace than the U… ids Minerva stores, so this
// receives {oaChatId, names, read marker} observed in the staff member's own OA Manager tab and
// (a) records it and (b) conservatively maps it to one of our Customers by UNIQUE exact name.
//
// Auth is the sole gate: requests come from the extension's service worker (no browser Origin),
// so Bearer auth + Minerva app access is what protects it — no CORS change needed. We never log
// tokens or message content (none is ever received). Per-route preHandlers (not a plugin-wide
// hook) so the two routes can differ: the sync POST accepts the long-lived OA-sync-scoped token
// (requireAuthScoped), while the token-mint route requires a FULL console token so a scoped
// token can't renew itself. Both still re-check live Minerva access via requireApp.
export async function oaSyncRoutes(app: FastifyInstance) {
  // Exchange a fresh full console login for a long-lived, sync-scoped token. The extension's
  // popup calls this once right after /api/auth/login, then stores ONLY this token — so the
  // background sync survives ~180d instead of dying with the 12h console token.
  app.post('/api/oa-sync/token', { preHandler: [requireAuth, requireApp('minerva')] }, async (req) => {
    return { token: signOaSyncToken(req.agent!) };
  });

  app.post('/api/oa-sync', { preHandler: [requireAuthScoped(OA_SYNC_SCOPE), requireApp('minerva')] }, async (req, reply) => {
    const p = syncSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalid_body' });
    const { oaChatId, oaTitle, oaSubName, readLabel } = p.data;

    // 1) Upsert by oaChatId. Only touch read* / reportedBy when a marker was actually observed,
    //    so a plain chat-open (names only) never blanks a previously synced read status. Hoisted
    //    so the live socket push below shares the EXACT same timestamp as the DB write.
    const now = new Date();
    const readFields = readLabel
      ? { readLabel, readSeenAt: now, reportedById: req.agent!.id }
      : {};
    const row = await prisma.oaReadSync.upsert({
      where: { oaChatId },
      create: {
        oaChatId,
        oaTitle: oaTitle ?? null,
        oaSubName: oaSubName ?? null,
        ...readFields,
      },
      update: {
        // undefined leaves a column untouched; only overwrite names when the extension sent them.
        oaTitle: oaTitle ?? undefined,
        oaSubName: oaSubName ?? undefined,
        ...readFields,
      },
    });

    // 2) Conservative matching — NEVER guess. Only fill customerId when it is still null and a
    //    single Customer matches exactly. Try in order: oaSubName↔displayName, oaTitle↔nickname,
    //    oaTitle↔displayName. Each uses findMany(take: 2) and accepts ONLY a unique single hit;
    //    any ambiguous or empty result leaves customerId null (harmless).
    let customerId = row.customerId;
    if (!customerId) {
      const uniqueMatch = async (where: Record<string, unknown>): Promise<string | null> => {
        const hits = await prisma.customer.findMany({ where, take: 2, select: { id: true } });
        return hits.length === 1 ? hits[0].id : null;
      };
      if (oaSubName) customerId = await uniqueMatch({ displayName: oaSubName });
      if (!customerId && oaTitle) customerId = await uniqueMatch({ nickname: oaTitle });
      if (!customerId && oaTitle) customerId = await uniqueMatch({ displayName: oaTitle });

      // Emoji-insensitive fallback: the OA Manager renders emoji in names as <img>, so the
      // extension's textContent arrives emoji-less (e.g. "Fuse" for a LINE name "Fuse 🌅").
      // Compare with pictographs/variation-selectors stripped + whitespace collapsed, still
      // requiring a UNIQUE hit across displayName+nickname. Only runs when exact paths failed.
      if (!customerId && (oaSubName || oaTitle)) {
        const norm = (s: string) =>
          s
            .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
        const targets = [oaSubName, oaTitle].filter((v): v is string => !!v).map(norm).filter(Boolean);
        if (targets.length) {
          const all = await prisma.customer.findMany({
            where: { active: true },
            select: { id: true, displayName: true, nickname: true },
          });
          for (const target of targets) {
            const hits = all.filter(
              (c) =>
                (c.displayName && norm(c.displayName) === target) ||
                (c.nickname && norm(c.nickname) === target),
            );
            if (hits.length === 1) {
              customerId = hits[0].id;
              break;
            }
          }
        }
      }

      if (customerId) {
        await prisma.oaReadSync.update({ where: { oaChatId }, data: { customerId } });
      }
    }

    // 3) Broadcast to open consoles so the 👁 read chip updates live, without a manual refresh —
    //    only once a customer is actually linked (pre-existing or freshly matched above). Emits
    //    the FINAL persisted values: this request's own marker when it sent one (sharing `now`
    //    with the DB write above), otherwise whatever was already stored. Never emits names.
    if (customerId) {
      pushToConsole('oa:read', {
        customerId,
        oaRead: {
          oaChatId,
          readLabel: readLabel ? readLabel : row.readLabel,
          readSeenAt: readLabel ? now : row.readSeenAt,
        },
      });
    }

    return { ok: true, matched: !!customerId };
  });
}
