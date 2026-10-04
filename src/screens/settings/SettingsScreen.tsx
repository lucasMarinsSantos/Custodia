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
          <Row icon="life-buoy" title="Opções de recuperação" subtitle="Código de emergência, frase e perguntas" onPress={() => navigation.navigate('RecoveryOptions')} last />
        </ListCard>
      </Section>

      <Section title="Organização">
        <ListCard>
          <Row icon="folder" title="Pastas e subpastas" onPress={() => navigation.navigate('Folders')} last />
        </ListCard>
      </Section>

      <Section title="Geral">
        <ListCard>
          <Row icon="info" title="Sobre e integridade do banco" onPress={() => navigation.navigate('About')} last />
        </ListCard>
      </Section>

      <Button title="Bloquear cofre agora" icon="lock" variant="outline" onPress={() => Vault.lock('manual')} />
      <Text style={[Type.caption, styles.version]}>Custódia v0.1.0 • zero-knowledge</Text>
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
