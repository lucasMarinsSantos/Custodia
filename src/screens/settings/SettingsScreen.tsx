// Configurações
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button, ListCard, Row, Screen, Section, ToggleRow } from '../../components/ui';
import { Colors, Type } from '../../theme';
import { useApp, useVaultData } from '../../context/AppState';
import { Vault } from '../../services/VaultService';
import { Repo } from '../../services/Repository';
import { bus, Events, toast } from '../../services/events';
import { Security } from '../../native';

export default function SettingsScreen({ navigation }: any) {
  const { profile } = useApp();
  const [settings, setSettings] = useState(Vault.settings);
  const [bioAvailable, setBioAvailable] = useState<{ available: boolean; reason?: string } | null>(null);
  const [data] = useVaultData(async () => ({ creds: (await Repo.credentials()).length, folders: (await Repo.folders()).length }), { creds: 0, folders: 0 });

  useEffect(() => bus.on(Events.SETTINGS_CHANGED, s => setSettings({ ...s })), []);
  useEffect(() => {
    Security.biometricAvailable().then(setBioAvailable).catch(() => setBioAvailable({ available: false }));
  }, []);

  const toggleBio = async (v: boolean) => {
    try {
      if (v) await Vault.enableBiometric();
      else await Vault.disableBiometric();
      toast(v ? 'Desbloqueio biométrico ativado' : 'Biometria desativada', 'success');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <Screen title="Ajustes" large>
      <View style={styles.profile}>
        <View style={[styles.avatar, { backgroundColor: profile?.color || Colors.primary }]}>
          <Text style={styles.avatarText}>C</Text>
        </View>
        <View style={styles.flex}>
          <Text style={Type.h2}>{profile?.name || 'Meu cofre'}</Text>
          <Text style={Type.small}>
            {data.creds} {data.creds === 1 ? 'credencial' : 'credenciais'} • {data.folders} {data.folders === 1 ? 'pasta' : 'pastas'} • cofre local
          </Text>
        </View>
      </View>

      <Section title="Segurança">
        <ListCard>
          <Row icon="lock" title="Alterar senha mestra" onPress={() => navigation.navigate('ChangePassword')} />
          <ToggleRow
            icon="aperture"
            title="Desbloqueio biométrico"
            subtitle={bioAvailable && !bioAvailable.available ? bioAvailable.reason || 'Indisponível neste aparelho' : 'Digital ou reconhecimento facial'}
            value={settings.biometricEnabled}
            onChange={toggleBio}
          />
          <Row
            icon="clock"
            title="Bloqueio, sessão e teclado seguro"
            subtitle={`Inatividade: ${settings.autoLockMinutes} min • proximidade ${settings.proximityLock ? 'ativa' : 'desativada'} • teclado seguro ${settings.secureKeyboard ? 'ativo' : 'desativado'}`}
            onPress={() => navigation.navigate('SecuritySettings')}
          />
          <Row icon="life-buoy" title="Opções de recuperação" subtitle="Código de emergência, frase e perguntas" onPress={() => navigation.navigate('RecoveryOptions')} />
          <Row icon="smartphone" title="Verificação em duas etapas" subtitle="Código TOTP do app autenticador para abrir o cofre" onPress={() => navigation.navigate('TwoFactor')} last />
        </ListCard>
      </Section>

      <Section title="Integrações">
        <ListCard>
          <Row icon="edit-3" title="Preenchimento automático" subtitle={settings.autofillEnabled ? 'Ativo em outros apps e navegadores' : 'Desativado'} onPress={() => navigation.navigate('Autofill')} />
          <Row icon="link" title="Extensão de navegador" subtitle={settings.browserBridge ? 'Conexão permitida' : 'Desligada'} onPress={() => navigation.navigate('BrowserExtension')} last />
        </ListCard>
      </Section>

      <Section title="Organização">
        <ListCard>
          <Row icon="layers" title="Perfis" subtitle="Pessoal e profissional, cada um com o seu cofre" onPress={() => navigation.navigate('Profiles')} />
          <Row icon="folder" title="Pastas e subpastas" onPress={() => navigation.navigate('Folders')} />
          <Row icon="credit-card" title="Cartões, endereços e identidades" subtitle="Dados para preencher formulários" onPress={() => navigation.navigate('Forms')} />
          <Row
            icon="calendar"
            title="Troca e validade das senhas"
            subtitle={`Sugerir troca após ${settings.passwordMaxAgeDays || 90} dias • vencidas ${settings.autoInactiveOnExpire !== false ? 'ficam inativas' : 'só destacadas'}`}
            onPress={() => navigation.navigate('PasswordAgeSettings')}
            last
          />
        </ListCard>
      </Section>

      <Section title="Sincronização">
        <ListCard>
          <Row
            icon="refresh-cw"
            title="Sincronização entre aparelhos"
            subtitle={settings.syncEnabled ? 'Ativa • cifrada de ponta a ponta' : 'Desligada • conecte outro aparelho com segurança'}
            onPress={() => navigation.navigate('Sync')}
            last
          />
        </ListCard>
      </Section>

      <Section title="Dados">
        <ListCard>
          <Row icon="repeat" title="Importar e exportar" subtitle="CSV/JSON de outros gerenciadores, foto (OCR), exportação cifrada e inventário" onPress={() => navigation.navigate('ImportExport')} />
          <Row icon="archive" title="Backup" subtitle={settings.autoBackup ? `Automático a cada ${settings.backupIntervalDays} dias, cifrado` : 'Backup automático desativado'} onPress={() => navigation.navigate('Backup')} last />
        </ListCard>
      </Section>

      <Section title="Geral">
        <ListCard>
          <Row icon="info" title="Sobre e integridade do banco" onPress={() => navigation.navigate('About')} last />
        </ListCard>
      </Section>

      <Button title="Bloquear cofre agora" icon="lock" variant="outline" onPress={() => Vault.lock('manual')} />
      <Text style={[Type.caption, styles.version]}>Custódia v0.2.0 • zero-knowledge</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  profile: { flexDirection: 'row', alignItems: 'center', marginBottom: 24 },
  avatar: { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center', marginRight: 14 },
  avatarText: { color: '#fff', fontSize: 22, fontWeight: '800' },
  version: { textAlign: 'center', marginTop: 16 },
});
