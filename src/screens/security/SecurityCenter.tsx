// Central de segurança, exibida na aba Saúde das Senhas:
//  • atalhos para alertas, vazamentos, duplicatas e risco, verificação de site
// e histórico de acessos, com as contagens que pedem atenção;
//  • estatísticas do cofre com gráficos simples feitos só com Views.
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Card, ListCard, Row, Section } from '../../components/ui';
import { HBarChart } from '../../components/widgets';
import { Colors, StrengthColors, Type } from '../../theme';
import { useVaultData } from '../../context/AppState';
import { vaultDb } from '../../db/Database';
import { Repo } from '../../services/Repository';
import { AlertService } from '../../services/AlertService';
import { BreachService, isFresh } from '../../services/BreachService';
import { DuplicateService } from '../../services/DuplicateService';
import { RiskService } from '../../services/RiskService';
import { MetadataService, VaultStats } from '../../services/MetadataService';
import { FormItem, PasswordStrength, SecureNote, StrengthLabels } from '../../types/models';

interface CenterData {
  unread: number;
  pwned: number;
  duplicates: number;
  highRisk: number;
  stats: VaultStats;
}

const STRENGTH_ORDER: PasswordStrength[] = ['very_strong', 'strong', 'medium', 'weak', 'critical'];
const AGE_COLORS = ['#22C55E', '#84CC16', '#EAB308', '#F97316', '#DC2626'];
/** Rótulos únicos para o gráfico (duas credenciais podem ter o mesmo título). */
function uniqueLabels<T>(items: T[], label: (t: T) => string): string[] {
  const seen = new Map<string, number>();
  return items.map(it => {
    const base = label(it);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base} (${n})` : base;
  });
}

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

async function load(): Promise<CenterData> {
  const creds = await Repo.credentials();
  const breaches = await BreachService.load();
  const notes = await vaultDb.all<Pick<SecureNote, 'category'>>('notes').catch(() => []);
  const forms = await vaultDb.all<Pick<FormItem, 'kind'>>('forms').catch(() => []);
  const ranked = RiskService.rank(creds);
  const pwned = creds.filter(c => {
    const e = breaches[c.id];
    return isFresh(e, c) && e.count > 0;
  }).length;
  return {
    unread: await AlertService.unreadCount(),
    pwned,
    duplicates: DuplicateService.find(creds).length,
    highRisk: ranked.filter(r => r.risk.level === 'critical' || r.risk.level === 'high').length,
    stats: MetadataService.stats({ creds, folders: await Repo.folders(), notes, forms }),
  };
}

const EMPTY: CenterData = { unread: 0, pwned: 0, duplicates: 0, highRisk: 0, stats: MetadataService.stats({ creds: [] }) };

export function SecurityCenter({ navigation }: { navigation: any }) {
  const [d] = useVaultData(load, EMPTY);
  const go = (name: string) => () => navigation.navigate(name);
  const warn = (n: number) => (n ? { iconColor: Colors.danger, iconBg: Colors.dangerBg } : {});
  return (
    <>
      <Section title="Central de segurança">
        <ListCard>
          <Row icon="bell" {...warn(d.unread)} title="Alertas de segurança" subtitle={d.unread ? plural(d.unread, 'alerta não lido', 'alertas não lidos') : 'Nenhum alerta não lido'} onPress={go('Alerts')} />
          <Row icon="alert-octagon" {...warn(d.pwned)} title="Vazamentos de senhas" subtitle={d.pwned ? plural(d.pwned, 'senha vazada', 'senhas vazadas') : 'Verificação anônima (Have I Been Pwned)'} onPress={go('BreachReport')} />
          <Row icon="copy" {...warn(d.duplicates)} title="Credenciais duplicadas" subtitle={d.duplicates ? plural(d.duplicates, 'grupo de duplicatas', 'grupos de duplicatas') : 'Nenhuma senha ou conta repetida'} onPress={go('Duplicates')} />
          <Row icon="bar-chart-2" {...warn(d.highRisk)} title="Classificação por risco" subtitle={d.highRisk ? plural(d.highRisk, 'conta de risco alto', 'contas de risco alto') : 'Do maior risco para o menor'} onPress={go('Risk')} />
          <Row icon="globe" title="Verificar site" subtitle="HTTPS, certificado SSL e domínios falsos" onPress={go('UrlCheck')} />
          <Row icon="clock" title="Histórico de acessos" subtitle="Desbloqueios e tentativas que falharam" onPress={go('AccessLog')} last />
        </ListCard>
      </Section>
      {d.stats.totals.credentials ? <VaultStatsPanel stats={d.stats} /> : null}
    </>
  );
}

function Total({ value, label }: { value: number; label: string }) {
  return (
    <View style={styles.total} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={styles.totalValue}>{value}</Text>
      <Text style={Type.caption}>{label}</Text>
    </View>
  );
}

/** Estatísticas do cofre: por categoria, por faixa de idade, por força e mais usadas. */
export function VaultStatsPanel({ stats }: { stats: VaultStats }) {
  const t = stats.totals;
  return (
    <Section title="Estatísticas do cofre">
      <Card>
        <View style={styles.totals}>
          <Total value={t.credentials} label="Credenciais" />
          <Total value={t.folders} label="Pastas" />
          <Total value={t.notes} label="Notas" />
          <Total value={t.forms} label="Formulários" />
        </View>
        <Text style={[Type.label, styles.chartTitle]}>Por categoria</Text>
        <HBarChart data={stats.byCategory.slice(0, 8).map(c => ({ label: c.label, value: c.count, color: Colors.primary }))} />
        <Text style={[Type.label, styles.chartTitle]}>Por idade da senha</Text>
        <HBarChart data={stats.ages.map((a, i) => ({ label: a.label, value: a.count, color: AGE_COLORS[i] }))} />
        <Text style={[Type.small, styles.note]}>
          Idade média: {stats.averageAgeDays} dias{stats.oldest ? ` • mais antiga: ${stats.oldest.title} (${stats.oldest.days} dias)` : ''}
        </Text>
        <Text style={[Type.label, styles.chartTitle]}>Por força</Text>
        <HBarChart data={STRENGTH_ORDER.map(s => ({ label: StrengthLabels[s], value: stats.strength[s], color: StrengthColors[s] }))} />
        <Text style={[Type.label, styles.chartTitle]}>Mais usadas</Text>
        {stats.mostUsed.length ? (
          <HBarChart data={uniqueLabels(stats.mostUsed, m => m.title).map((label, i) => ({ label, value: stats.mostUsed[i].usageCount, color: Colors.info }))} />
        ) : (
          <Text style={Type.small}>Nenhuma credencial usada ainda.</Text>
        )}
        <Text style={[Type.small, styles.note]}>
          {plural(t.favorites, 'favorita', 'favoritas')} • {plural(t.neverUsed, 'nunca usada', 'nunca usadas')} • {plural(t.inactive, 'inativa', 'inativas')}
        </Text>
      </Card>
    </Section>
  );
}

const styles = StyleSheet.create({
  totals: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  total: { alignItems: 'center', flex: 1 },
  totalValue: { fontSize: 22, fontWeight: '800', color: Colors.text },
  chartTitle: { marginTop: 16, marginBottom: 8 },
  note: { marginTop: 6 },
});
