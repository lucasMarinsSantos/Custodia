// Folha para pedir uma senha antes de uma ação sensível (reautenticação para exportar, criar/restaurar backup,
// abrir um arquivo cifrado). O erro aparece na própria folha e também como toast; a senha é apagada ao fechar.
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { Banner, Button, Sheet } from './ui';
import { MasterPasswordInput } from './MasterPasswordInput';
import { Type } from '../theme';
import { toast } from '../services/events';
import { Vault } from '../services/VaultService';

interface Props {
  visible: boolean;
  title: string;
  message?: string;
  label?: string;
  confirmTitle?: string;
  onClose: () => void;
  /** Recebe a senha; se lançar, a mensagem aparece na folha e a folha continua aberta. */
  onSubmit: (password: string) => Promise<void>;
  /** Alternativa por biometria (reautenticação para exportar). */
  onBiometric?: () => Promise<void>;
}

export function PasswordSheet({ visible, title, message, label = 'Senha mestra', confirmTitle = 'Confirmar', onClose, onSubmit, onBiometric }: Props) {
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) {
      setPw('');
      setError(null);
    }
  }, [visible]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e: any) {
      const msg = e?.message || 'Não foi possível concluir a ação.';
      setError(msg);
      toast(msg, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      {message ? <Text style={[Type.small, styles.msg]}>{message}</Text> : null}
      <MasterPasswordInput label={label} value={pw} onChange={setPw} secureKeyboard={Vault.settings.secureKeyboard} onSubmit={() => pw && run(() => onSubmit(pw))} />
      {error ? <Banner tone="danger" text={error} /> : null}
      <Button title={confirmTitle} icon="check" loading={busy} disabled={!pw || busy} onPress={() => run(() => onSubmit(pw))} />
      {onBiometric ? <Button title="Usar biometria" icon="aperture" variant="ghost" disabled={busy} onPress={() => run(onBiometric)} /> : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  msg: { marginBottom: 10 },
});
