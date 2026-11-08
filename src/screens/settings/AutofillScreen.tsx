// Ajustes › Preenchimento automático: status do serviço de acessibilidade, liga/desliga,
// verificação de URL, restrições do Android e trocas de senha percebidas (requisito 36).
import React, { useCallback, useEffect, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { Banner, Button, Card, ListCard, Row, Screen, Section, ToggleRow } from '../../components/ui';
import { Colors, Type } from '../../theme';
import { useVaultData } from '../../context/AppState';
import { AutofillService, PASSWORD_CHANGE_EVENT, PasswordChangeSuggestion } from '../../services/AutofillService';
import { Vault } from '../../services/VaultService';
import { bus, Events, toast } from '../../services/events';
import { timeAgo } from '../../utils';

export default function AutofillScreen({ navigation }: any) {
  const [settings, setSettings] = useState(Vault.settings);
  const [serviceOn, setServiceOn] = useState<boolean | null>(null);
  const [changes, reloadChanges] = useVaultData(() => AutofillService.passwordChangeSuggestions(), [] as PasswordChangeSuggestion[]);

  const refreshStatus = useCallback(() => {
    AutofillService.isServiceEnabled().then(setServiceOn);
  }, []);

  useEffect(() => {
    refreshStatus();
    // Volta das configurações do Android: atualiza o status
    const sub = AppState.addEventListener('change', s => s === 'active' && refreshStatus());
    const offSettings = bus.on(Events.SETTINGS_CHANGED, s => setSettings({ ...s }));
    const offChanges = bus.on(PASSWORD_CHANGE_EVENT, () => reloadChanges());
    return () => {
      sub.remove();
      offSettings();
      offChanges();
    };
  }, [refreshStatus, reloadChanges]);

  const update = async (patch: Partial<typeof settings>, message: string) => {
    try {
      await Vault.updateSettings(patch);
      toast(message, 'success');
    } catch (e: any) {
      toast(e?.message || 'Não foi possível salvar o ajuste.', 'error');
    }
  };

  const openSettings = async () => {
    try {
      await AutofillService.openSettings();
    } catch (e: any) {
      toast(e?.message || 'Não foi possível abrir as configurações de acessibilidade.', 'error');
    }
  };

  const openAppInfo = async () => {
    try {
      await AutofillService.openAppInfo();
    } catch (e: any) {
      toast(e?.message || 'Não foi possível abrir as informações do app.', 'error');
    }
  };

  /** Troca de senha: abre a credencial para atualizar; login novo: abre o cadastro já com o site/app. */
  const openSuggestion = (s: PasswordChangeSuggestion) => {
    if (s.type === 'update' && s.credentialId) navigation.navigate('CredentialEdit', { id: s.credentialId });
    else navigation.navigate('CredentialEdit', { prefillUrl: s.url || '', prefillPackage: s.packageName || '' });
    AutofillService.dismissPasswordChange(s.id).catch((e: any) => toast(e?.message || 'Não foi possível descartar a sugestão.', 'error'));
  };

  const dismiss = async (id: string) => {
    try {
      await AutofillService.dismissPasswordChange(id);
    } catch (e: any) {
      toast(e?.message || 'Não foi possível descartar a sugestão.', 'error');
    }
  };

  return (
    <Screen title="Preenchimento automático" onBack={() => navigation.goBack()}>
      <Card style={styles.status}>
        <View style={[styles.dot, { backgroundColor: serviceOn ? Colors.success : Colors.danger }]} />
        <View style={styles.flex}>
          <Text style={Type.bodyStrong} accessibilityLiveRegion="polite">
            {serviceOn == null ? 'Verificando o serviço…' : serviceOn ? 'Serviço de acessibilidade ativo' : 'Serviço de acessibilidade inativo'}
          </Text>
          <Text style={Type.small}>Ative "Custódia — Preenchimento" em Configurações › Acessibilidade.</Text>
        </View>
      </Card>
      {serviceOn === false ? (
        <Card style={styles.steps}>
          <Text style={[Type.bodyStrong, styles.mb8]}>Como ativar</Text>
          <Step n={1} text="Toque em “Abrir configurações de acessibilidade”." />
          <Step n={2} text="Entre em Apps instalados (ou Serviços baixados) › Custódia — Preenchimento." />
          <Step n={3} text="Ative a chave e confirme em Permitir." />
          <Step n={4} text="Se aparecer “Configuração restrita”, veja as instruções do Android 13+ abaixo." />
        </Card>
      ) : null}
      <Button title="Abrir configurações de acessibilidade" icon="external-link" variant="secondary" onPress={openSettings} />

      <Section title="Preferências" style={styles.mt16}>
        <ListCard>
          <ToggleRow
            icon="edit-3"
            title="Preencher em outros apps"
            subtitle="Mostra o balão do Custódia nas telas de login, cartão e endereço"
            value={settings.autofillEnabled}
            onChange={v => update({ autofillEnabled: v }, v ? 'Preenchimento automático ativado' : 'Preenchimento automático desativado')}
          />
          <ToggleRow
            icon="shield"
            title="Verificar o endereço antes de preencher"
            subtitle="Bloqueia sites falsos parecidos com os verdadeiros (phishing)"
            value={settings.autofillVerifyUrl}
            onChange={v => update({ autofillVerifyUrl: v }, v ? 'Verificação de URL ativada' : 'Verificação de URL desativada')}
            last
          />
        </ListCard>
      </Section>
      {!settings.autofillVerifyUrl ? <Banner tone="warning" text="Sem a verificação de URL, o Custódia só confere se o site corresponde à credencial, sem procurar sinais de golpe." /> : null}

      <PasswordChanges changes={changes} onOpen={openSuggestion} onDismiss={dismiss} />

      <Section title="Como o Custódia protege o preenchimento">
        <Card>
          <Bullet text="O serviço só lê os campos da tela em foco para saber o app e o site. Nada é enviado a servidores." />
          <Bullet text="As senhas não saem do banco cifrado: você desbloqueia o Custódia, escolhe a credencial e só aquele par vai ao campo, uma vez." />
          <Bullet text="Antes de preencher, o endereço é comparado com o site salvo e com sites conhecidos. Um site falso é bloqueado." />
          <Bullet text="Pastas com a regra “não preencher” e credenciais inativas não aparecem nas sugestões." />
        </Card>
      </Section>

      <Section title="Restrições do Android 11 ou superior">
        <Card>
          <Bullet text="Em apps instalados fora da Play Store, o Android 13+ mostra “Configuração restrita” ao ativar o serviço. Para liberar: toque em “Abrir informações do app” abaixo, depois no menu ⋮ (canto superior) › Permitir configurações restritas, confirme com o PIN e volte a Acessibilidade." />
          <Bullet text="O Android 11+ limita a visibilidade de outros apps: o Custódia identifica o app só pelo pacote em foco, sem listar os instalados." />
          <Bullet text="Nos navegadores, o site é lido da barra de endereço (Chrome, Firefox, Edge, Samsung Internet e Brave). Em outros navegadores, ou com a barra oculta, o preenchimento é bloqueado por segurança." />
          <Bullet text="Alguns apps de banco bloqueiam serviços de acessibilidade. Nesses casos, copie a senha ou use o arrastar em tela dividida." />
          <Button title="Abrir informações do app" icon="info" variant="ghost" small onPress={openAppInfo} />
        </Card>
      </Section>
    </Screen>
  );
}

function PasswordChanges({ changes, onOpen, onDismiss }: { changes: PasswordChangeSuggestion[]; onOpen: (s: PasswordChangeSuggestion) => void; onDismiss: (id: string) => void }) {
  if (!changes.length) return null;
  return (
    <Section title="Logins e trocas de senha detectados">
      <ListCard>
        {changes.map((s, i) => (
          <Row
            key={s.id}
            icon="refresh-cw"
            iconColor={s.type === 'update' ? Colors.warning : Colors.primary}
            title={s.title}
            subtitle={s.type === 'update' ? `Nova senha digitada em ${s.where} • ${timeAgo(s.at)}. Toque para atualizar.` : `Login em ${s.where} • ${timeAgo(s.at)}. Toque para salvar.`}
            onPress={() => onOpen(s)}
            right={<Button title="Ignorar" variant="ghost" small onPress={() => onDismiss(s.id)} />}
            last={i === changes.length - 1}
          />
        ))}
      </ListCard>
    </Section>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <View style={styles.bullet}>
      <Text style={[Type.bodyStrong, styles.bulletDot]}>{n}.</Text>
      <Text style={[Type.small, styles.flex]}>{text}</Text>
    </View>
  );
}

function Bullet({ text }: { text: string }) {
  return (
    <View style={styles.bullet}>
      <Text style={[Type.body, styles.bulletDot]}>•</Text>
      <Text style={[Type.small, styles.flex]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  mt16: { marginTop: 16 },
  status: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  dot: { width: 12, height: 12, borderRadius: 6, marginRight: 12 },
  bullet: { flexDirection: 'row', marginBottom: 8 },
  bulletDot: { width: 20 },
  steps: { marginBottom: 12 },
  mb8: { marginBottom: 8 },
});
