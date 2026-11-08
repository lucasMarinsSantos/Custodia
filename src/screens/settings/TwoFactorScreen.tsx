// Verificação em duas etapas: ativação com QR Code, códigos de reserva e desativação
// Ativar: segredo novo de 160 bits → QR Code otpauth:// (ou a chave em texto) → código do app autenticador +
// senha mestra → códigos de reserva (mostrados uma única vez). Desativar ou gerar novos códigos pede senha + código.
import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Banner, Button, Card, Input, ListCard, Row, Screen, Section, Sheet, ToggleRow } from '../../components/ui';
import { MasterPasswordInput } from '../../components/MasterPasswordInput';
import { QrCode } from '../../components/QrCode';
import { Colors, Type } from '../../theme';
import { BACKUP_CODE_COUNT, Vault } from '../../services/VaultService';
import { ClipboardService } from '../../services/ClipboardService';
import { toast } from '../../services/events';
import { formatDate } from '../../utils';

type Status = Awaited<ReturnType<typeof Vault.getTwoFactorStatus>>;

/** "ABCD EFGH ..." para digitar a chave à mão no app autenticador. */
export const groupSecret = (s: string) => s.replace(/(.{4})/g, '$1 ').trim();

function BackupCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <Card>
      <Text style={Type.h3}>Códigos de reserva</Text>
      <Text style={[Type.small, styles.mt6]}>
        Guarde estes {codes.length} códigos fora do celular. Cada um entra no cofre uma única vez se você perder o app autenticador. Eles não serão mostrados de novo.
      </Text>
      <View style={styles.codes} accessible accessibilityLabel={`Códigos de reserva: ${codes.join(', ')}`}>
        {codes.map(c => (
          <Text key={c} selectable style={[Type.mono, styles.code]}>
            {c}
          </Text>
        ))}
      </View>
      <View style={styles.actions}>
        <Button small variant="outline" icon="copy" title="Copiar códigos" onPress={() => ClipboardService.copy(codes.join('\n'), 'Códigos de reserva')} />
        <Button small icon="check" title="Já guardei" onPress={onDone} />
      </View>
    </Card>
  );
}

function SetupFlow({ onEnabled }: { onEnabled: (codes: string[]) => void }) {
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => () => Vault.cancelTwoFactorSetup(), []);

  const start = async () => {
    try {
      setSetup(await Vault.beginTwoFactorSetup());
    } catch (e: any) {
      toast(e?.message || 'Não foi possível iniciar a ativação.', 'error');
    }
  };

  const confirm = async () => {
    setBusy(true);
    try {
      const codes = await Vault.confirmTwoFactorSetup(pw, code);
      setPw('');
      toast('Verificação em duas etapas ativada', 'success');
      onEnabled(codes);
    } catch (e: any) {
      toast(e?.message || 'Não foi possível ativar.', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!setup) {
    return (
      <>
        <Banner tone="info" icon="smartphone" text="Depois da senha mestra, o Custódia vai pedir um código de 6 dígitos gerado por um app autenticador (Google Authenticator, Aegis, Microsoft Authenticator…)." />
        <Button title="Ativar verificação em duas etapas" icon="shield" onPress={start} />
      </>
    );
  }

  return (
    <>
      <Section title="1. Escaneie o QR Code no app autenticador">
        <Card>
          <QrCode value={setup.uri} accessibilityLabel="QR Code da verificação em duas etapas" />
          <Text style={[Type.small, styles.center]}>Ou digite a chave no app:</Text>
          <Text selectable style={[Type.mono, styles.secret]} accessibilityLabel={`Chave ${setup.secret.split('').join(' ')}`}>
            {groupSecret(setup.secret)}
          </Text>
          <Button small variant="outline" icon="copy" title="Copiar chave" onPress={() => ClipboardService.copy(setup.secret, 'Chave')} />
        </Card>
      </Section>
      <Section title="2. Confirme com um código">
        <Input label="Código de 6 dígitos" icon="hash" value={code} onChangeText={t => setCode(t.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" mono placeholder="000000" />
        <MasterPasswordInput label="Senha mestra" value={pw} onChange={setPw} secureKeyboard={!!Vault.settings.secureKeyboard} />
        <View style={styles.gap} />
        <Button title="Confirmar e ativar" icon="check" onPress={confirm} loading={busy} disabled={code.length !== 6 || !pw} />
      </Section>
    </>
  );
}

/** Folha que pede senha + código antes de uma ação sensível (desativar, novos códigos). */
function ConfirmSheet({ title, action, onClose, onDone }: { title: string; action: (pw: string, code: string) => Promise<void>; onClose: () => void; onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await action(pw, code);
      onDone();
    } catch (e: any) {
      toast(e?.message || 'Não foi possível concluir.', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet visible onClose={onClose} title={title}>
      <MasterPasswordInput label="Senha mestra" value={pw} onChange={setPw} secureKeyboard={!!Vault.settings.secureKeyboard} />
      <View style={styles.gap} />
      <Input label="Código do app ou código de reserva" icon="hash" value={code} onChangeText={t => setCode(t.slice(0, 16))} autoCapitalize="characters" mono />
      <Button title="Confirmar" icon="check" onPress={run} loading={busy} disabled={!pw || !code.trim()} />
    </Sheet>
  );
}

export default function TwoFactorScreen({ navigation }: any) {
  const [status, setStatus] = useState<Status | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [sheet, setSheet] = useState<'disable' | 'regen' | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await Vault.getTwoFactorStatus());
    } catch (e: any) {
      toast(e?.message || 'Não foi possível ler a configuração.', 'error');
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const toggleBio = async (v: boolean) => {
    try {
      await Vault.setTwoFactorBiometric(v);
      await load();
    } catch (e: any) {
      toast(e?.message || 'Não foi possível alterar.', 'error');
    }
  };

  let body: React.ReactNode = null;
  if (codes) {
    body = <BackupCodes codes={codes} onDone={() => { setCodes(null); load(); }} />;
  } else if (status && !status.enabled) {
    body = <SetupFlow onEnabled={c => setCodes(c)} />;
  } else if (status) {
    body = (
      <>
        <Banner tone="success" icon="check-circle" title="Verificação em duas etapas ativa" text={`Ativada em ${status.enabledAt ? formatDate(status.enabledAt) : '—'}. A senha mestra sozinha não abre mais o cofre.`} />
        <ListCard>
          <ToggleRow
            icon="aperture"
            title="Biometria dispensa o código"
            subtitle="A digital ou o rosto já provam a posse do aparelho. Desligue para pedir o código também na biometria."
            value={status.allowBiometric}
            onChange={toggleBio}
          />
          <Row icon="list" title="Gerar novos códigos de reserva" subtitle={`${status.backupCodesLeft} de ${BACKUP_CODE_COUNT} ainda disponíveis`} onPress={() => setSheet('regen')} />
          <Row icon="x-circle" title="Desativar verificação em duas etapas" danger onPress={() => setSheet('disable')} last />
        </ListCard>
      </>
    );
  }

  return (
    <Screen title="Verificação em duas etapas" subtitle="Código TOTP para abrir o cofre" onBack={() => navigation.goBack()}>
      {body}
      {sheet === 'disable' ? (
        <ConfirmSheet
          title="Desativar verificação em duas etapas"
          action={(pw, code) => Vault.disableTwoFactor(pw, code)}
          onClose={() => setSheet(null)}
          onDone={() => {
            setSheet(null);
            toast('Verificação em duas etapas desativada', 'success');
            load();
          }}
        />
      ) : null}
      {sheet === 'regen' ? (
        <ConfirmSheet
          title="Gerar novos códigos de reserva"
          action={async (pw, code) => setCodes(await Vault.regenerateBackupCodes(pw, code))}
          onClose={() => setSheet(null)}
          onDone={() => setSheet(null)}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  mt6: { marginTop: 6 },
  center: { textAlign: 'center', marginTop: 12 },
  secret: { textAlign: 'center', fontSize: 16, color: Colors.primaryDark, marginVertical: 10 },
  codes: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginVertical: 12 },
  code: { width: '46%', fontSize: 16 },
  actions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  gap: { height: 12 },
});
