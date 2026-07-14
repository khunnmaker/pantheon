import { sendApolloMorningDigests } from './notify.js';
import { sweepApolloRecurrences } from './recurrence.js';

type Log = { info: Function; error: Function };

function msUntilThai(hour: number, minute: number): number {
  const now = new Date();
  const targetHour = (hour - 7 + 24) % 24;
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), targetHour, minute));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function daily(hour: number, minute: number, run: () => Promise<void>): void {
  const schedule = () => {
    const timer = setTimeout(() => void run().finally(schedule), msUntilThai(hour, minute));
    timer.unref();
  };
  schedule();
}

export function startApolloSchedulers(log: Log): void {
  daily(8, 30, async () => {
    try { log.info(`[apollo digest] sent ${await sendApolloMorningDigests()} staff digests`); }
    catch (err) { log.error({ err }, '[apollo digest] failed'); }
  });
  daily(2, 30, async () => {
    try { log.info(`[apollo recurrence] spawned ${await sweepApolloRecurrences()} missed occurrences`); }
    catch (err) { log.error({ err }, '[apollo recurrence] sweep failed'); }
  });
}
