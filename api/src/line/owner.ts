import { env } from '../env.js';

// Prominent-provider ID used to identify the owner at existing Ceres/Apollo
// call sites. The appdent destination itself is resolved by sendOwnerLineText.
export function getProminentOwnerLineUserId(): string {
  return env.CEO_LINE_USER_ID || env.CERES_CEO_LINE_USER_ID;
}
