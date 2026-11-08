// Sincronização entre aparelhos
// Servidor, criar conta / parear com código, aparelhos conectados, último sync, "Sincronizar agora" e desconectar.
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { Banner, Button, Card, Input, KeyValue, ListCard, Row, Screen, Section, ToggleRow } from '../../components/ui';
import { Colors, Type } from '../../theme';
import { Vault } from '../../services/VaultService';
import { ClipboardService } from '../../services/ClipboardService';
import { bus, toast } from '../../services/events';
import { AUTO_SYNC_MINUTES, defaultDeviceName, SYNC_STATUS_EVENT, SyncService, SyncStatus, validateServerUrl } from '../../services/SyncService';
import { plainHttpWarning, type RemoteDevice } from '../../services/sync/http';
import { timeAgo } from '../../utils';

const msg = (e: unknown) => String((e as Error)?.message || e);

const LAN_HINT =
  'Use HTTPS. Para a aula, o servidor pode rodar no PC: no emulador use http://10.0.2.2:3000; no celular, http://IP-do-PC:3000 (ex.: 192.168.0.10), na mesma rede Wi-Fi. HTTP só é aceito nesses endereços locais.';

function useSyncStatus(): [SyncStatus | null, () => Promise<void>] {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const refresh = useCallback(async () => {
    setStatus(await SyncService.status());
  }, []);
  useEffect(() => {
    refresh().catch(() => undefined);
    return bus.on(SYNC_STATUS_EVENT, () => {
      refresh().catch(() => undefined);
    });
  }, [refresh]);
  return [status, refresh];
}

function resultText(s: SyncStatus): string {
  const r = s.lastResult;
  if (!r) return 'Nenhuma sincronização nesta sessão';
  const conflicts = r.conflicts ? ' • ' + r.conflicts + ' conflitos resolvidos' : '';
  return `${r.pushed} enviados • ${r.pulled} recebidos${conflicts}`;
}

// ---------------------------------------------------------------------------
// Não conectado: criar conta ou parear
// ---------------------------------------------------------------------------
function ConnectForm({ onPairingCode }: { onPairingCode: (code: string) => void }) {
  const [serverUrl, setServerUrl] = useState(Vault.settings.serverUrl);
  const [deviceName, setDeviceName] = useState(defaultDeviceName());
  const [code, setCode] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);

  const checkUrl = (): boolean => {
    try {
      validateServerUrl(serverUrl);
      setUrlError(null);
      return true;
    } catch (e) {
      setUrlError(msg(e));
      return false;
    }
  };

  const create = async () => {
    if (!checkUrl()) return;
    try {
      const r = await SyncService.createAccount(serverUrl, deviceName);
      onPairingCode(r.pairingCode);
      toast('Conta de sincronização criada', 'success');
    } catch (e) {
      toast(msg(e), 'error');
    }
  };

  const pair = async () => {
    if (!checkUrl()) return;
    try {
      await SyncService.pairDevice(serverUrl, code, deviceName);
      setCode('');
      toast('Aparelho pareado e sincronizado', 'success');
    } catch (e) {
      toast(msg(e), 'error');
    }
  };

  return (
    <>
      <Banner
        tone="info"
        title="Cifrada de ponta a ponta"
        text="Senhas, pastas, notas e formulários saem do aparelho cifrados (AES-256-GCM) com uma chave de sincronização que o servidor nunca vê. A senha mestra não é enviada."
      />
      <Section title="Servidor">
        <Input
          label="Endereço do servidor"
          icon="server"
          value={serverUrl}
          onChangeText={t => {
            setServerUrl(t);
            setUrlError(null);
          }}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          error={urlError}
          hint={LAN_HINT}
        />
        {plainHttpWarning(serverUrl) ? <Banner tone="warning" text={plainHttpWarning(serverUrl)!} /> : null}
        <Input label="Nome deste aparelho" icon="smartphone" value={deviceName} onChangeText={setDeviceName} maxLength={60} />
      </Section>
      <Section title="Primeiro aparelho">
        <Button title="Criar conta de sincronização" icon="user-plus" onPress={create} accessibilityHint="Cria a conta no servidor e mostra o código para parear os outros aparelhos" />
      </Section>
      <Section title="Já sincroniza em outro aparelho?">
        <Text style={[Type.small, styles.mb8]}>No outro aparelho, abra Ajustes › Sincronização › Mostrar código de pareamento e digite ou cole o código aqui.</Text>
        <Input
          label="Código de pareamento"
          icon="key"
          value={code}
          onChangeText={setCode}
          autoCapitalize="characters"
          autoCorrect={false}
          mono
          multiline
          placeholder="XXXX-XXXX-XXXX-…"
          maxLength={120}
        />
        <Button title="Parear este aparelho" icon="link" variant="secondary" onPress={pair} disabled={!code.trim()} />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Código de pareamento
// ---------------------------------------------------------------------------
function PairingCodeCard({ code, onShow, onHide }: { code: string | null; onShow: () => Promise<void>; onHide: () => void }) {
  if (!code) {
    return <Button title="Mostrar código de pareamento" icon="eye" variant="outline" onPress={onShow} />;
  }
  return (
    <Card>
      <Text style={[Type.mono, styles.code]} selectable accessibilityLabel={`Código de pareamento: ${code.split('').join(' ')}`}>
        {code}
      </Text>
      <Banner tone="warning" text="Quem tiver este código consegue ler o cofre sincronizado. Digite-o só no seu outro aparelho e não o envie por mensagem." />
      <View style={styles.row}>
        <Button title="Copiar" icon="copy" variant="secondary" small style={styles.flex} onPress={() => ClipboardService.copy(code.replace(/-/g, ''), 'Código de pareamento', true)} />
        <Button title="Ocultar" icon="eye-off" variant="outline" small style={[styles.flex, styles.ml8]} onPress={onHide} />
      </View>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Aparelhos conectados
// ---------------------------------------------------------------------------
function DevicesCard({ devices, onRevoke }: { devices: RemoteDevice[] | null; onRevoke: (d: RemoteDevice) => void }) {
  if (!devices) return <Text style={Type.small}>Carregando aparelhos…</Text>;
  if (!devices.length) return <Text style={Type.small}>Nenhum aparelho encontrado.</Text>;
  return (
    <ListCard>
      {devices.map((d, i) => (
        <Row
          key={d.id}
          icon="smartphone"
          title={d.name}
          subtitle={d.current ? 'Este aparelho' : `Visto ${timeAgo(d.lastSeenAt)}`}
          last={i === devices.length - 1}
          right={d.current ? null : <Button title="Remover" variant="danger" small onPress={() => onRevoke(d)} accessibilityHint={`Desconecta ${d.name} da sincronização`} />}
        />
      ))}
    </ListCard>
  );
}

// ---------------------------------------------------------------------------
// Conectado
// ---------------------------------------------------------------------------
function ConnectedPanel({ status, initialCode }: { status: SyncStatus; initialCode: string | null }) {
  const [code, setCode] = useState<string | null>(initialCode);
  const [devices, setDevices] = useState<RemoteDevice[] | null>(null);
  const account = status.account!;

  const loadDevices = useCallback(async () => {
    try {
      setDevices(await SyncService.listDevices());
    } catch (e) {
      setDevices([]);
      toast(msg(e), 'error');
    }
  }, []);

  useEffect(() => {
    loadDevices();
  }, [loadDevices]);

  const syncNow = async () => {
    try {
      const r = await SyncService.syncNow();
      toast(r.warning || `Sincronizado: ${r.pushed} enviados, ${r.pulled} recebidos`, r.warning ? 'info' : 'success');
      await loadDevices();
    } catch (e) {
      toast(msg(e), 'error');
    }
  };

  const toggle = async (v: boolean) => {
    try {
      await SyncService.setEnabled(v);
    } catch (e) {
      toast(msg(e), 'error');
    }
  };

  const revoke = (d: RemoteDevice) => {
    Alert.alert('Remover aparelho', `"${d.name}" deixará de sincronizar com esta conta.`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Remover',
        style: 'destructive',
        onPress: () => {
          SyncService.revokeDevice(d.id)
            .then(() => {
              toast('Aparelho removido da sincronização', 'success');
              return loadDevices();
            })
            .catch(e => toast(msg(e), 'error'));
        },
      },
    ]);
  };

  const disconnect = () => {
    const run = (deleteServerData: boolean) => {
      SyncService.disconnect({ deleteServerData })
        .then(() => toast('Este aparelho foi desconectado da sincronização', 'success'))
        .catch(e => toast(msg(e), 'error'));
    };
    Alert.alert('Desconectar este aparelho', 'Os dados continuam neste aparelho. A chave de sincronização é apagada daqui.', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Apagar também do servidor', style: 'destructive', onPress: () => run(true) },
      { text: 'Desconectar', onPress: () => run(false) },
    ]);
  };

  return (
    <>
      {status.offline ? (
        <Banner tone="warning" icon="wifi-off" title="Sem conexão com o servidor" text={`${status.lastError} As alterações ficam pendentes neste aparelho e vão na próxima sincronização.`} />
      ) : null}
      {status.lastError && !status.offline ? <Banner tone="danger" title="Falha na última sincronização" text={status.lastError} /> : null}
      <Card>
        <KeyValue label="Servidor" value={account.serverUrl} />
        {plainHttpWarning(account.serverUrl) ? <Text style={[Type.caption, styles.mt8]}>{plainHttpWarning(account.serverUrl)}</Text> : null}
        <KeyValue label="Este aparelho" value={account.deviceName} />
        <KeyValue label="Último sync" value={status.syncing ? 'Sincronizando…' : timeAgo(status.lastSyncAt)} />
        <KeyValue label="Pendências" value={String(status.pending)} />
        <Text style={[Type.caption, styles.mt8]}>{resultText(status)}</Text>
      </Card>
      <Section>
        <ListCard>
          <ToggleRow
            icon="refresh-cw"
            title="Sincronização automática"
            subtitle={`Ao desbloquear, a cada ${AUTO_SYNC_MINUTES} min e logo após cada alteração`}
            value={status.enabled}
            onChange={toggle}
            last
          />
        </ListCard>
      </Section>
      <Button title="Sincronizar agora" icon="refresh-cw" onPress={syncNow} loading={status.syncing} />

      <Section title="Parear outro aparelho" style={styles.mt16}>
        <PairingCodeCard
          code={code}
          onShow={async () => {
            try {
              setCode(await SyncService.pairingCode());
            } catch (e) {
              toast(msg(e), 'error');
            }
          }}
          onHide={() => setCode(null)}
        />
      </Section>

      <Section title="Aparelhos conectados">
        <DevicesCard devices={devices} onRevoke={revoke} />
      </Section>

      <Button title="Desconectar este aparelho" icon="log-out" variant="danger" onPress={disconnect} />
    </>
  );
}

export default function SyncScreen({ navigation }: any) {
  const [status] = useSyncStatus();
  const [newCode, setNewCode] = useState<string | null>(null);
  return (
    <Screen title="Sincronização" subtitle="Entre aparelhos, cifrada de ponta a ponta" onBack={() => navigation.goBack()}>
      {!status ? <Text style={Type.small}>Carregando…</Text> : null}
      {status && !status.connected ? <ConnectForm onPairingCode={setNewCode} /> : null}
      {status?.connected ? <ConnectedPanel status={status} initialCode={newCode} /> : null}
      <Text style={[Type.caption, styles.footnote]}>
        O histórico de versões, os alertas e o histórico de acessos ficam só neste aparelho. Em edições ao mesmo tempo, vale a mais recente de cada campo e a
        anterior vai para o histórico de versões.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', marginTop: 12 },
  ml8: { marginLeft: 8 },
  mb8: { marginBottom: 8 },
  mt8: { marginTop: 8 },
  mt16: { marginTop: 16 },
  code: { fontSize: 17, lineHeight: 26, letterSpacing: 1, color: Colors.text, marginBottom: 12 },
  footnote: { marginTop: 20, textAlign: 'center' },
});
