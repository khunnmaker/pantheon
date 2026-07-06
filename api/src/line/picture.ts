import { prisma } from '../db/prisma.js';
import { env } from '../env.js';
import { fetchPictureUrl } from './client.js';

// Best-effort periodic refresh of a customer's cached LINE picture. Called when the customer is
// active (inbound message) or their chat is opened. Throttled to at most once per
// PICTURE_REFRESH_DAYS so we don't hammer the LINE API, and never throws — a LINE/DB error just
// leaves the current cached url in place. Returns the effective pictureUrl for the caller to use.
//
// Behavior:
//  - R… (rooms) / any non-U/C id have no picture API → return the current url, do nothing.
//  - Still-fresh (fetched within the window) → return the current url WITHOUT calling LINE.
//  - Else fetch from LINE, always stamp pictureFetchedAt (so a transient failure still throttles),
//    and overwrite pictureUrl ONLY when the fetched value is non-null (never wipe a good cached url
//    on a momentary null / LINE hiccup).
export async function maybeRefreshCustomerPicture(customer: {
  id: string;
  lineUserId: string;
  pictureUrl: string | null;
  pictureFetchedAt: Date | null;
}): Promise<string | null> {
  const { id, lineUserId, pictureUrl, pictureFetchedAt } = customer;

  // Only 1-on-1 (U…) and group (C…) ids expose a picture; rooms and others do not.
  if (!lineUserId.startsWith('U') && !lineUserId.startsWith('C')) return pictureUrl;

  // Fresh enough — skip the LINE call.
  const windowMs = env.PICTURE_REFRESH_DAYS * 86_400_000;
  if (pictureFetchedAt && Date.now() - pictureFetchedAt.getTime() < windowMs) return pictureUrl;

  const fetched = await fetchPictureUrl(lineUserId);
  try {
    await prisma.customer.update({
      where: { id },
      data: {
        pictureFetchedAt: new Date(),
        // Only overwrite on a real value; a null (transient failure) keeps the cached url.
        ...(fetched ? { pictureUrl: fetched } : {}),
      },
    });
  } catch {
    // DB hiccup — leave the caller with whatever we have; never break ingest/request.
  }
  return fetched ?? pictureUrl;
}
