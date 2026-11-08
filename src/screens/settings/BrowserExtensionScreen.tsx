// Ajustes › Extensão de navegador: liga/desliga a ponte local (só no aparelho ou também na rede Wi-Fi),
// abre a janela de pareamento (o código de 6 dígitos aparece na extensão e é conferido aqui), lista as sessões
// ativas (com validade) e permite revogar.
import React, { useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { Banner, Button, Card, ListCard, Row, Screen, Section, ToggleRow } from '../../components/ui';
import { Type } from '../../theme';
import { useVaultData } from '../../context/AppState';
import { BRIDGE_EVENT, BRIDGE_PORT, BrowserBridgeService, PublicSession } from '../../services/BrowserBridgeService';
import { Vault } from '../../services/VaultService';
import { bus, Events, toast } from '../../services/events';
import { formatDate, timeAgo } from '../../utils';

function useCountdown(until: number | null): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
}

export default function BrowserExtensionScreen({ navigation }: any) {
  const [enabled, setEnabled] = useState(!!Vault.settings.browserBridge);
  const [running, setRunning] = useState(false);
  const [lan, setLan] = useState(false);
  const [addresses, setAddresses] = useState<string[]>([]);
  const [pairing, setPairing] = useState(BrowserBridgeService.pairingWindow);
  const [sessions, reload] = useVaultData(() => BrowserBridgeService.publicSessions(), [] as PublicSession[]);
  const left = useCountdown(pairing?.expiresAt ?? null);

  useEffect(() => {
    const refresh = () => {
      setPairing(BrowserBridgeService.pairingWindow);
      BrowserBridgeService.isRunning().then(setRunning);
      BrowserBridgeService.lanEnabled().then(setLan);
      BrowserBridgeService.addresses().then(setAddresses);
      reload();
    };
    refresh();
    const off1 = bus.on(BRIDGE_EVENT, refresh);
    const off2 = bus.on(Events.SETTINGS_CHANGED, s => setEnabled(!!s.browserBridge));
    return () => {
      off1();
      off2();
    };
  }, [reload]);

  useEffect(() => {
    if (pairing && left === 0) setPairing(null);
  }, [left, pairing]);

  const toggle = async (v: boolean) => {
    try {
      await BrowserBridgeService.setEnabled(v);
      toast(v ? 'Conexão com a extensão ativada' : 'Conexão com a extensão desativada', 'success');
    } catch (e: any) {
      toast(e?.message || 'Não foi possível alterar a conexão.', 'error');
    }
  };

  const pair = async () => {
    try {
      await BrowserBridgeService.startPairing();
      setPairing(BrowserBridgeService.pairingWindow);
    } catch (e: any) {
      toast(e?.message || 'Não foi possível iniciar o pareamento.', 'error');
    }
  };

  const toggleLan = async (v: boolean) => {
    try {
      await BrowserBridgeService.setLan(v);
      toast(v ? 'A ponte também aceita conexões da rede Wi-Fi' : 'A ponte aceita só conexões deste aparelho (USB)', 'success');
    } catch (e: any) {
      toast(e?.message || 'Não foi possível alterar a rede da ponte.', 'error');
    }
  };

  const revoke = (s: PublicSession) =>
    Alert.alert('Revogar sessão', `A extensão "${s.name}" perde o acesso ao cofre e precisará ser pareada de novo.`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Revogar',
        style: 'destructive',
        onPress: () =>
          BrowserBridgeService.revoke(s.id)
            .then(() => toast('Sessão revogada', 'success'))
            .catch((e: any) => toast(e?.message || 'Não foi possível revogar.', 'error')),
      },
    ]);

  const revokeAll = () =>
    BrowserBridgeService.revokeAll()
      .then(() => toast('Todas as sessões foram revogadas', 'success'))
      .catch((e: any) => toast(e?.message || 'Não foi possível revogar.', 'error'));

  return (
    <Screen title="Extensão de navegador" onBack={() => navigation.goBack()}>
      <ListCard>
        <ToggleRow
          icon="link"
          title="Permitir conexão da extensão"
          subtitle={enabled && running ? `Ponte local ativa na porta ${BRIDGE_PORT}` : 'Desligada: nenhuma extensão consegue se conectar'}
          value={enabled}
          onChange={toggle}
          last={!enabled}
        />
        {enabled ? (
          <ToggleRow
            icon="wifi"
            title="Aceitar conexões da rede Wi-Fi"
            subtitle={lan ? `Na extensão, use ${addresses[0] || 'o IP do celular'}:${BRIDGE_PORT}` : `Só pelo cabo USB (adb forward), em 127.0.0.1:${BRIDGE_PORT}`}
            value={lan}
            onChange={toggleLan}
            last
          />
        ) : null}
      </ListCard>
      {enabled && lan ? <Banner tone="warning" text="Na rede Wi-Fi, outros aparelhos conseguem tentar se conectar. Tudo continua cifrado e cada pareamento e cada senha precisam da sua confirmação aqui, mas prefira redes de confiança." /> : null}

      {enabled ? (
        <Section title="Pareamento" style={styles.mt16}>
          {pairing && left > 0 ? (
            <Card>
              <Text style={Type.bodyStrong} accessibilityLiveRegion="polite">
                Aguardando a extensão… ({left} s)
              </Text>
              <Text style={[Type.small, styles.mt10]}>
                Nas opções da extensão Custódia Connect, digite o endereço do celular e clique em Parear. A extensão vai mostrar um código de 6 dígitos e este celular vai pedir que você confirme que é o mesmo.
              </Text>
              <Button title="Cancelar pareamento" variant="ghost" small onPress={() => BrowserBridgeService.cancelPairing()} />
            </Card>
          ) : (
            <Button title="Parear nova extensão" icon="smartphone" onPress={pair} />
          )}
        </Section>
      ) : null}

      <Section title="Sessões ativas" style={styles.mt16}>
        {sessions.length ? (
          <ListCard>
            {sessions.map((s, i) => (
              <Row
                key={s.id}
                icon="monitor"
                title={s.name}
                subtitle={`Pareada ${formatDate(s.createdAt)} • vale até ${formatDate(s.expiresAt)} • último uso: ${timeAgo(s.lastUsedAt)}`}
                right={<Button title="Revogar" variant="ghost" small onPress={() => revoke(s)} />}
                last={i === sessions.length - 1}
              />
            ))}
          </ListCard>
        ) : (
          <Text style={Type.small}>Nenhuma extensão pareada.</Text>
        )}
        {sessions.length > 1 ? <Button title="Revogar todas" icon="x-circle" variant="danger" small style={styles.mt10} onPress={revokeAll} /> : null}
      </Section>

      <Banner tone="info" icon="lock" text="Cada pedido de senha da extensão precisa da sua confirmação aqui no celular (toque em Permitir). O canal é cifrado com AES-256-GCM, com chave combinada por ECDH P-256, e só funciona com o cofre aberto." />

      <Section title="Como instalar a extensão">
        <Card>
          <Text style={[Type.small, styles.mb6]}>Chrome, Edge ou Kiwi: chrome://extensions › Modo do desenvolvedor › Carregar sem compactação › pasta browser-extension.</Text>
          <Text style={[Type.small, styles.mb6]}>Firefox: about:debugging › Este Firefox › Carregar extensão temporária › manifest.json.</Text>
          <Text style={[Type.small, styles.mb6]}>Pelo cabo USB: no computador, rode adb forward tcp:{BRIDGE_PORT} tcp:{BRIDGE_PORT} e use 127.0.0.1:{BRIDGE_PORT} na extensão.</Text>
          <Text style={Type.small}>Pela rede Wi-Fi: ligue “Aceitar conexões da rede Wi-Fi” e use o IP do celular mostrado acima.</Text>
        </Card>
      </Section>
      <View style={styles.gap} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  mt16: { marginTop: 16 },
  mt10: { marginTop: 10 },
  mb6: { marginBottom: 6 },
  gap: { height: 12 },
});
