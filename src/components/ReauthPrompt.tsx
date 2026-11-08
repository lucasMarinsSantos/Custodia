// Reautenticação antes de mostrar/copiar (regra de pasta "reautenticar para ver/copiar")
// Uso: const reauth = useReauth(); ... if (await reauth.ensure()) mostrar(); ... e renderizar {reauth.element}.
// Uma confirmação vale por REAUTH_GRACE_MS na mesma tela (evita pedir a senha para mostrar e logo depois copiar).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Banner, Button, Sheet } from './ui';
import { MasterPasswordInput } from './MasterPasswordInput';
import { Type } from '../theme';
import { Vault } from '../services/VaultService';
import { Security } from '../native';
import { bus, Events } from '../services/events';
import { FolderRulesService } from '../services/FolderRulesService';
import { PolicyService } from '../services/PolicyService';
import { FolderPolicy } from '../types/models';

export const REAUTH_GRACE_MS = 60 * 1000;

export function useReauth() {
  const [visible, setVisible] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bio, setBio] = useState(false);
  const okUntil = useRef(0);
  const pending = useRef<((ok: boolean) => void) | null>(null);

  const finish = useCallback((ok: boolean) => {
    if (ok) okUntil.current = Date.now() + REAUTH_GRACE_MS;
    setVisible(false);
    setPassword('');
    setError(null);
    pending.current?.(ok);
    pending.current = null;
  }, []);

  // Bloqueou o cofre com o pedido aberto: recusa
  useEffect(() => bus.on(Events.LOCKED, () => {
    okUntil.current = 0;
    if (pending.current) finish(false);
  }), [finish]);

  const ensure = useCallback(async (): Promise<boolean> => {
    if (Date.now() < okUntil.current) return true;
    const profileId = Vault.currentProfile?.id;
    const hasBio = !!profileId && Vault.settings.biometricEnabled && (await Security.hasBiometricKey(`bio_${profileId}`).catch(() => false));
    setBio(hasBio);
    pending.current?.(false);
    return new Promise<boolean>(resolve => {
      pending.current = resolve;
      setVisible(true);
    });
  }, []);

  const run = async (method: 'password' | 'biometric') => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const ok = await Vault.reauthenticate(method, password);
      if (ok) finish(true);
      else setError(method === 'password' ? 'Senha mestra incorreta.' : 'A biometria não confere com este cofre.');
    } catch (e: any) {
      setError(e?.message || 'Não foi possível confirmar sua identidade.');
    } finally {
      setBusy(false);
    }
  };

  const element = (
    <Sheet visible={visible} onClose={() => finish(false)} title="Confirme sua identidade">
      <Text style={[Type.small, styles.text]}>Esta pasta exige a senha mestra ou a biometria para ver ou copiar a senha.</Text>
      <MasterPasswordInput value={password} onChange={setPassword} secureKeyboard={!!Vault.settings.secureKeyboard} onSubmit={() => run('password')} autoFocus />
      {error ? <Banner tone="danger" icon="alert-circle" text={error} /> : null}
      <View style={styles.gap} />
      <Button title="Confirmar" icon="check" onPress={() => run('password')} loading={busy} disabled={!password} />
      {bio ? (
        <>
          <View style={styles.gap} />
          <Button title="Usar biometria" variant="outline" icon="aperture" onPress={() => run('biometric')} disabled={busy} />
        </>
      ) : null}
    </Sheet>
  );

  return { ensure, element, visible };
}

const styles = StyleSheet.create({
  text: { marginBottom: 12 },
  gap: { height: 10 },
});

/**
 * Aplicação das regras da pasta numa tela: reautenticação antes de mostrar/copiar e o tempo de limpeza
 * da área de transferência. Renderize `element` na tela.
 */
export function useFolderGuard(policy: FolderPolicy | null) {
  const reauth = useReauth();
  /** true se pode seguir (sem regra, ou identidade confirmada). */
  const allow = async () => !policy?.requireReauth || reauth.ensure();
  const guarded = async (action: () => void) => {
    if (await allow()) action();
  };
  /** Alterna "mostrar": esconder é livre; mostrar passa pela regra. */
  const toggle = (shown: boolean, set: (v: boolean) => void) => (shown ? set(false) : guarded(() => set(true)));
  const clipboardSeconds = () => (policy ? FolderRulesService.clipboardSeconds(policy, Vault.settings.clipboardSeconds) : undefined);
  return { allow, guarded, toggle, clipboardSeconds, element: reauth.element };
}

/** Faixa com as regras ativas da pasta (nada se a pasta não tem regras). */
export function FolderRulesBanner({ policy }: { policy: FolderPolicy | null }) {
  if (!policy || PolicyService.isEmpty(policy)) return null;
  return <Banner tone="info" icon="shield" title="Regras da pasta" text={FolderRulesService.describe(policy).join(' · ')} />;
}
