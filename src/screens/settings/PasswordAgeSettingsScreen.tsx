// Ajustes de troca e validade das senhas
//  • Prazo padrão para sugerir a troca (90 dias), configurável
//  • Credencial vencida fica inativa automaticamente (fora do preenchimento automático)
//  • Atalho para a lista de vencidas e senhas para trocar
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Banner, Chip, KeyValue, Card, ListCard, Screen, Section, ToggleRow } from '../../components/ui';
import { Type } from '../../theme';
import { useVaultData } from '../../context/AppState';
import { ExpiryService, MAX_AGE_CHOICES } from '../../services/ExpiryService';
import { Repo } from '../../services/Repository';
import { Vault } from '../../services/VaultService';
import { bus, Events, toast } from '../../services/events';
import { AppSettings } from '../../types/models';
import { timeAgo } from '../../utils';

export default function PasswordAgeSettingsScreen({ navigation }: any) {
  const [settings, setSettings] = useState(Vault.settings);
  useEffect(() => bus.on(Events.SETTINGS_CHANGED, s => setSettings({ ...s })), []);
  const [data] = useVaultData(
    async () => {
      const [creds, folders, lastSweep] = await Promise.all([Repo.credentials(), Repo.folders(), ExpiryService.lastSweep()]);
      const { expired, old } = ExpiryService.attention(creds, folders);
      return { expired: expired.length, old: old.length, inactive: creds.filter(c => c.inactive).length, lastSweep };
    },
    { expired: 0, old: 0, inactive: 0, lastSweep: null as string | null },
    [settings.passwordMaxAgeDays],
  );

  const update = async (patch: Partial<AppSettings>, message: string) => {
    if (!Vault.isUnlocked) return;
    try {
      await Vault.updateSettings(patch);
      // Aplica na hora: vencidas ficam inativas e os alertas novos aparecem
      await ExpiryService.sweep();
      toast(message, 'success');
    } catch (e: any) {
      toast(e?.message || 'Não foi possível salvar o ajuste.', 'error');
    }
  };

  return (
    <Screen title="Troca e validade das senhas" onBack={() => navigation.goBack()}>
      {data.expired || data.old ? (
        <Banner
          tone={data.expired ? 'danger' : 'warning'}
          title="Senhas expiradas"
          text={`${data.expired} vencida(s) e ${data.old} para trocar. Veja no Cofre, filtro "Vencidas / Trocar".`}
          onPress={() => navigation.navigate('Main', { screen: 'Vault' })}
        />
      ) : null}

      <Section title="Sugestão de troca">
        <Text style={[Type.small, styles.mb10]}>Avisamos quando uma senha fica mais antiga que o prazo. Cada credencial pode ter um prazo próprio (na edição) e as regras de pasta também valem; vale sempre o menor.</Text>
        <View style={styles.wrap}>
          {MAX_AGE_CHOICES.map(d => (
            <Chip key={d} label={`${d} dias`} active={settings.passwordMaxAgeDays === d} onPress={() => update({ passwordMaxAgeDays: d }, `Prazo padrão: ${d} dias`)} />
          ))}
        </View>
      </Section>

      <Section title="Validade">
        <ListCard>
          <ToggleRow
            icon="slash"
            title="Inativar credenciais vencidas"
            subtitle="Ficam fora do preenchimento automático até você trocar a senha ou mudar a data"
            value={settings.autoInactiveOnExpire !== false}
            onChange={v => update({ autoInactiveOnExpire: v }, v ? 'Vencidas ficam inativas' : 'Vencidas só ficam destacadas')}
            last
          />
        </ListCard>
      </Section>

      <Section title="Situação">
        <Card>
          <KeyValue label="Vencidas" value={String(data.expired)} />
          <KeyValue label="Senhas para trocar" value={String(data.old)} />
          <KeyValue label="Inativas" value={String(data.inactive)} />
          <KeyValue label="Última verificação" value={data.lastSweep ? timeAgo(data.lastSweep) : 'Ainda não verificado'} />
        </Card>
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
  mb10: { marginBottom: 10 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
