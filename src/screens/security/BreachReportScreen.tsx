// Vazamentos de senhas: relatório das contas comprometidas, verificação manual e automática
// Privacidade: só os 5 primeiros caracteres do SHA-1 de cada senha saem do aparelho (k-anonimato, BreachService).
import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Badge, Banner, Button, Card, EmptyState, Icon, ListCard, ProgressBar, Screen, Section, ToggleRow } from '../../components/ui';
import { Colors, Type } from '../../theme';
import { useVaultData } from '../../context/AppState';
import { Repo } from '../../services/Repository';
import { BREACH_MESSAGE, BreachEntry, BreachService, BreachStatus, breachText, isFresh } from '../../services/BreachService';
import { Vault } from '../../services/VaultService';
import { toast } from '../../services/events';
import { Credential } from '../../types/models';
import { formatDate, timeAgo } from '../../utils';

interface Item {
  cred: Credential;
  status: BreachStatus;
}

function statusFrom(entry: BreachEntry | undefined, cred: Credential): BreachStatus {
  if (!isFresh(entry, cred)) return { state: 'unknown', count: 0, checkedAt: null };
  return { state: entry.count > 0 ? 'pwned' : 'safe', count: entry.count, checkedAt: entry.checkedAt };
}

async function load(): Promise<{ items: Item[]; lastRun: string | null }> {
  const creds = (await Repo.credentials()).filter(c => !!c.password);
  const cache = await BreachService.load();
  const items: Item[] = creds.map(cred => ({ cred, status: statusFrom(cache[cred.id], cred) }));
  items.sort((a, b) => b.status.count - a.status.count || a.cred.title.localeCompare(b.cred.title, 'pt-BR'));
  return { items, lastRun: await BreachService.lastRun() };
}

function PwnedCard({ item, onChange }: { item: Item; onChange: () => void }) {
  return (
    <Card style={styles.pwned} accessibilityLabel={`${item.cred.title}: ${BREACH_MESSAGE}`}>
      <View style={styles.rowTop}>
        <Icon name="alert-octagon" size={20} color={Colors.danger} />
        <View style={styles.flex}>
          <Text style={Type.bodyStrong}>{item.cred.title}</Text>
          {item.cred.username ? <Text style={Type.small}>{item.cred.username}</Text> : null}
        </View>
        <Badge text={breachText(item.status.count)} color={Colors.danger} bg={Colors.dangerBg} />
      </View>
      <Text style={[Type.small, styles.dangerText]}>{BREACH_MESSAGE}. Troque esta senha o quanto antes, e em todos os sites onde ela foi usada.</Text>
      <Button small variant="danger" icon="edit-2" title="Trocar senha" onPress={onChange} style={styles.changeBtn} />
    </Card>
  );
}

function StatusRow({ item, onOpen }: { item: Item; onOpen: () => void }) {
  const safe = item.status.state === 'safe';
  return (
    <TouchableOpacity style={styles.statusRow} onPress={onOpen} accessibilityRole="button" accessibilityLabel={`${item.cred.title}: ${safe ? 'senha segura' : 'ainda não verificada'}`}>
      <Icon name={safe ? 'check-circle' : 'help-circle'} size={18} color={safe ? Colors.success : Colors.textTertiary} />
      <Text style={[Type.body, styles.flex]} numberOfLines={1}>
        {item.cred.title}
      </Text>
      <Text style={[Type.caption, safe && styles.safeText]}>{safe ? 'Segura' : 'Não verificada'}</Text>
    </TouchableOpacity>
  );
}

export default function BreachReportScreen({ navigation }: any) {
  const [data, reload] = useVaultData(load, { items: [] as Item[], lastRun: null as string | null });
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [offline, setOffline] = useState<string | null>(null);
  const [auto, setAuto] = useState(!!Vault.settings.breachAutoCheck);

  const pwned = data.items.filter(i => i.status.state === 'pwned');
  const others = data.items.filter(i => i.status.state !== 'pwned');

  const run = async () => {
    setRunning(true);
    setOffline(null);
    setProgress(0);
    try {
      const r = await BreachService.checkAll(await Repo.credentials(), (done, total) => setProgress(total ? done / total : 1), { force: true });
      if (r.offline) setOffline(r.error || null);
      else if (r.error) toast(r.error, 'error');
      else if (r.pwned) toast(r.pwned === 1 ? '1 senha apareceu em vazamentos de dados' : `${r.pwned} senhas apareceram em vazamentos de dados`, 'error');
      else toast('Nenhuma senha do cofre apareceu em vazamentos conhecidos', 'success');
      await reload();
    } catch (e: any) {
      toast(e?.message || 'Não foi possível verificar os vazamentos', 'error');
    } finally {
      setRunning(false);
    }
  };

  const toggleAuto = async (v: boolean) => {
    try {
      await Vault.updateSettings({ breachAutoCheck: v });
      setAuto(v);
    } catch (e: any) {
      toast(e?.message || 'Não foi possível salvar o ajuste', 'error');
    }
  };

  return (
    <Screen title="Vazamentos de senhas" onBack={() => navigation.goBack()}>
      <Banner
        tone="info"
        icon="eye-off"
        text="As senhas são conferidas na base do Have I Been Pwned de forma anônima: só os 5 primeiros caracteres do resumo (SHA-1) de cada senha saem do aparelho, nunca a senha."
      />
      <Button icon="search" title={running ? 'Verificando…' : 'Verificar agora'} onPress={run} loading={running} disabled={running} style={styles.mt12} />
      {running ? <ProgressBar value={progress} label="Progresso da verificação" /> : null}
      <Text style={[Type.caption, styles.mt8]}>
        {data.lastRun ? `Última verificação completa: ${formatDate(data.lastRun, true)} (${timeAgo(data.lastRun)})` : 'O cofre ainda não foi verificado por completo.'}
      </Text>
      {offline ? <Banner tone="warning" icon="wifi-off" title="Sem conexão" text={offline} /> : null}

      <Section title="Contas comprometidas">
        {pwned.length === 0 ? (
          <EmptyState icon="shield" title="Nenhuma senha vazada encontrada" message="As senhas já verificadas não aparecem em vazamentos conhecidos." />
        ) : (
          pwned.map(i => <PwnedCard key={i.cred.id} item={i} onChange={() => navigation.navigate('CredentialEdit', { id: i.cred.id })} />)
        )}
      </Section>

      {others.length ? (
        <Section title="Demais senhas">
          <ListCard>
            {others.map(i => (
              <StatusRow key={i.cred.id} item={i} onOpen={() => navigation.navigate('CredentialDetail', { id: i.cred.id })} />
            ))}
          </ListCard>
        </Section>
      ) : null}

      <Section title="Verificação automática">
        <ListCard>
          <ToggleRow icon="refresh-cw" title="Verificar automaticamente" subtitle="Ao salvar ou trocar uma senha e a cada 7 dias. Sem internet, a verificação fica para depois." value={auto} onChange={toggleAuto} last />
        </ListCard>
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  mt8: { marginTop: 8, marginBottom: 12 },
  mt12: { marginTop: 12, marginBottom: 8 },
  pwned: { borderColor: '#FECACA', borderWidth: 1, marginBottom: 10 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dangerText: { color: Colors.danger, marginTop: 8 },
  changeBtn: { marginTop: 10, alignSelf: 'flex-start' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: Colors.divider },
  safeText: { color: Colors.success },
});
