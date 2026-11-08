// Bloqueio automático, reautenticação, área de transferência e teclado seguro
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Banner, Chip, ListCard, Screen, Section, ToggleRow } from '../../components/ui';
import { Type } from '../../theme';
import { Vault } from '../../services/VaultService';
import { bus, Events } from '../../services/events';
import { AppSettings } from '../../types/models';

function Options({ label, value, options, onChange, suffix }: { label: string; value: number; options: number[]; onChange: (v: number) => void; suffix: string }) {
  return (
    <View style={styles.options}>
      <Text style={[Type.label, styles.optLabel]}>{label}</Text>
      <View style={styles.chips}>
        {options.map(o => (
          <Chip key={o} label={`${o} ${suffix}`} active={value === o} onPress={() => onChange(o)} />
        ))}
      </View>
    </View>
  );
}

export default function SecuritySettingsScreen({ navigation }: any) {
  const [s, setS] = useState<AppSettings>(Vault.settings);
  useEffect(() => bus.on(Events.SETTINGS_CHANGED, v => setS({ ...v })), []);
  const up = (p: Partial<AppSettings>) => Vault.updateSettings(p);

  return (
    <Screen title="Bloqueio e sessão" onBack={() => navigation.goBack()}>
      <Options label="Encerrar sessão após inatividade" value={s.autoLockMinutes} options={[1, 2, 5, 10, 15, 30]} suffix="min" onChange={v => up({ autoLockMinutes: v })} />
      <Options label="Exigir reautenticação ao voltar após" value={s.reauthAfterMinutes} options={[0, 1, 5, 15, 30, 60]} suffix="min" onChange={v => up({ reauthAfterMinutes: v })} />
      <Banner tone="info" text="Qualquer toque na tela reinicia o contador de inatividade. Ao bloquear, a chave do cofre é apagada da memória e é preciso autenticar de novo." />
      <Section title="Proteções">
        <ListCard>
          <ToggleRow icon="smartphone" title="Bloquear ao virar para baixo ou no bolso" subtitle="Sensor de proximidade e acelerômetro, exige autenticação completa" value={s.proximityLock} onChange={v => up({ proximityLock: v })} />
          <ToggleRow icon="minimize-2" title="Bloquear ao desligar a tela" subtitle="Bloqueio imediato ao desligar a tela ou minimizar o app" value={s.lockOnBackground} onChange={v => up({ lockOnBackground: v })} />
          <ToggleRow icon="grid" title="Teclado Seguro" subtitle="Teclado próprio com teclas embaralhadas para a senha mestra (anti-keylogger)" value={s.secureKeyboard} onChange={v => up({ secureKeyboard: v })} last />
        </ListCard>
      </Section>
      <Options label="Limpar área de transferência após" value={s.clipboardSeconds} options={[15, 30, 60, 120]} suffix="s" onChange={v => up({ clipboardSeconds: v })} />
      <Text style={Type.small}>O conteúdo copiado é marcado como sensível (oculto em notificações e pré-visualizações do Android 13+) e apagado também ao minimizar o app.</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  options: { marginBottom: 18 },
  optLabel: { marginBottom: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
