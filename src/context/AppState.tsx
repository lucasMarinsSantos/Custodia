// Estado global do app (bloqueado/desbloqueado, cofre, onboarding)
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { bus, Events } from '../services/events';
import { Vault } from '../services/VaultService';
import { Profile } from '../types/models';

type Status = 'loading' | 'setup' | 'locked' | 'unlocked';

interface Ctx {
  status: Status;
  profile: Profile | null;
  lockReason: string | null;
  recoveryCode: string | null;
  setRecoveryCode: (c: string | null) => void;
  refresh: () => Promise<void>;
}

const AppCtx = createContext<Ctx>({} as Ctx);

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [lockReason, setLockReason] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (Vault.isUnlocked) {
      setProfile(Vault.currentProfile);
      setStatus('unlocked');
      return;
    }
    const has = await Vault.hasVault();
    setStatus(has ? 'locked' : 'setup');
  }, []);

  useEffect(() => {
    refresh();
    const a = bus.on(Events.UNLOCKED, (payload?: { recoveryCode?: string }) => {
      // O código só é exibido no desbloqueio que o gerou; qualquer outro desbloqueio o descarta da memória
      setRecoveryCode(payload?.recoveryCode ?? null);
      setProfile(Vault.currentProfile);
      setLockReason(null);
      setStatus('unlocked');
    });
    const b = bus.on(Events.LOCKED, (reason?: string) => {
      setLockReason(reason && reason !== 'manual' ? reason : null);
      setRecoveryCode(null);
      setStatus('locked');
    });
    return () => {
      a();
      b();
    };
  }, [refresh]);

  // Valor memoizado: evita re-render de todos os consumidores a cada render do provedor.
  const value = useMemo(
    () => ({ status, profile, lockReason, recoveryCode, setRecoveryCode, refresh }),
    [status, profile, lockReason, recoveryCode, refresh],
  );
  return (
    <AppCtx.Provider value={value}>
      {children}
    </AppCtx.Provider>
  );
}

export const useApp = () => useContext(AppCtx);

/**
 * Hook utilitário: executa `load` ao montar e sempre que os dados do cofre mudarem.
 * - descarta respostas antigas (se duas recargas se sobrepõem, só a última vale);
 * - não atualiza estado após desmontar;
 * - agrupa rajadas de eventos (ex.: exclusão de uma pasta com muitos itens) em uma única recarga.
 */
export function useVaultData<T>(load: () => Promise<T>, initial: T, deps: any[] = []): [T, () => Promise<void>, boolean] {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const reload = useCallback(async () => {
    if (!Vault.isUnlocked) return;
    const mine = ++seq.current;
    try {
      const result = await load();
      if (alive.current && mine === seq.current) setData(result);
    } catch (e) {
      console.warn('[useVaultData] falha ao carregar dados', e);
    } finally {
      if (alive.current && mine === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    reload();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(reload, 50);
    };
    const off1 = bus.on(Events.DATA_CHANGED, schedule);
    const off2 = bus.on(Events.INTEGRITY_CHECKED, schedule);
    return () => {
      if (timer) clearTimeout(timer);
      off1();
      off2();
    };
  }, [reload]);
  return [data, reload, loading];
}
