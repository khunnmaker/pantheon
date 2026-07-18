import { prisma } from '../db/prisma.js';

export const AUTOSEND_CONFIG_KEY = 'minerva.autosend.config';
export const AUTOSEND_CANCELED_KEY = 'minerva.autosend.canceled';
export const DEFAULT_AUTOSEND_CONFIG = { enabled: false, delaySeconds: 60 } as const;

export type AutosendConfig = { enabled: boolean; delaySeconds: number };

export function clampDelaySeconds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_AUTOSEND_CONFIG.delaySeconds;
  return Math.min(300, Math.max(15, Math.round(value)));
}

export async function getAutosendConfig(): Promise<AutosendConfig> {
  const row = await prisma.setting.findUnique({ where: { key: AUTOSEND_CONFIG_KEY } }).catch(() => null);
  if (!row) return { ...DEFAULT_AUTOSEND_CONFIG };
  try {
    const parsed = JSON.parse(row.value) as Partial<AutosendConfig>;
    return {
      enabled: parsed.enabled === true,
      delaySeconds: clampDelaySeconds(Number(parsed.delaySeconds)),
    };
  } catch {
    return { ...DEFAULT_AUTOSEND_CONFIG };
  }
}

export async function setAutosendConfig(config: AutosendConfig): Promise<AutosendConfig> {
  const safe = { enabled: config.enabled === true, delaySeconds: clampDelaySeconds(config.delaySeconds) };
  await prisma.setting.upsert({
    where: { key: AUTOSEND_CONFIG_KEY },
    update: { value: JSON.stringify(safe) },
    create: { key: AUTOSEND_CONFIG_KEY, value: JSON.stringify(safe) },
  });
  return safe;
}

export async function incrementAutosendCanceled(): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "Setting" (key, value, "updatedAt")
    VALUES (${AUTOSEND_CANCELED_KEY}, '1', now())
    ON CONFLICT (key) DO UPDATE SET
      value = ((CASE WHEN "Setting".value ~ '^[0-9]+$' THEN "Setting".value::bigint ELSE 0 END) + 1)::text,
      "updatedAt" = now()`;
}

export async function getAutosendCanceled(): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key: AUTOSEND_CANCELED_KEY } }).catch(() => null);
  const value = Number.parseInt(row?.value ?? '0', 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
