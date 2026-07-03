import { createContext, useContext } from 'react';
import type { Agent, Bootstrap } from './api';

export interface CeresContextValue {
  agent: Agent;
  bootstrap: Bootstrap;
  onLogout: () => void;
  refreshBootstrap: () => void;
}

export const CeresContext = createContext<CeresContextValue | null>(null);

export function useCeres(): CeresContextValue {
  const ctx = useContext(CeresContext);
  if (!ctx) throw new Error('useCeres must be used within CeresContext.Provider');
  return ctx;
}
