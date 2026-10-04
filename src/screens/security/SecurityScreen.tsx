// Saúde das senhas: pontuação geral, distribuição da força e destaque para
// senhas fracas, curtas ou repetidas, com atalho para cada credencial.
import React, { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Banner, Card, EmptyState, Icon, Screen, Section } from '../../components/ui';
import { HBarChart, ScoreRing, StackedBar } from '../../components/widgets';
import { Colors, Radius, Shadow, StrengthColors, Type } from '../../theme';
import { useVaultData } from '../../context/AppState';
import { Repo } from '../../services/Repository';
import { AnalysisService } from '../../services/AnalysisService';
import { Credential, PasswordStrength, StrengthLabels } from '../../types/models';

const ORDER: PasswordStrength[] = ['very_strong', 'strong', 'medium', 'weak', 'critical'];

function scoreLabel(score: number): string {
  if (score >= 85) return 'Muito forte';
  if (score >= 65) return 'Forte';
  if (score >= 45) return 'Médio';
  if (score >= 25) return 'Fraco';
  return 'Crítico';
}

function AttentionBanner({ count }: { count: number }) {
  if (count === 0) return <Banner tone="success" text="Nenhuma senha fraca ou repetida. Excelente!" />;
  const title = count === 1 ? '1 senha precisa de atenção' : `${count} senhas precisam de atenção`;
  return <Banner tone="warning" title={title} text="Veja abaixo as senhas fracas, curtas ou repetidas e troque-as usando o gerador." />;
}

function AttentionList({ report, onOpen }: { report: ReturnType<typeof AnalysisService.report>; onOpen: (id: string) => void }) {
  return (
    <Section title="Senhas que precisam de atenção">
      {report.recommendations.length === 0 && report.short.length === 0 ? (
        <Text style={Type.small}>Nada por aqui.</Text>
      ) : null}
      {report.recommendations.slice(0, 12).map(r => (
        <TouchableOpacity key={r.id} accessibilityRole="button" onPress={() => onOpen(r.credentialId)} style={styles.rec}>
          <View style={[styles.recBar, { backgroundColor: r.severity === 'danger' ? Colors.danger : Colors.orange }]} />
          <View style={styles.flex}>
            <Text style={Type.bodyStrong}>{r.title}</Text>
            <Text style={Type.small}>{r.message}</Text>
          </View>
          <Icon name="chevron-right" size={18} color={Colors.textTertiary} />
        </TouchableOpacity>
      ))}
      {report.short
        .filter(c => !report.recommendations.some(r => r.credentialId === c.id))
        .map(c => (
          <TouchableOpacity key={`short:${c.id}`} accessibilityRole="button" onPress={() => onOpen(c.id)} style={styles.rec}>
            <View style={[styles.recBar, { backgroundColor: Colors.info }]} />
            <View style={styles.flex}>
              <Text style={Type.bodyStrong}>Senha curta em {c.title}</Text>
              <Text style={Type.small}>Use pelo menos 12 caracteres.</Text>
            </View>
            <Icon name="chevron-right" size={18} color={Colors.textTertiary} />
          </TouchableOpacity>
        ))}
    </Section>
  );
}

export default function SecurityScreen({ navigation }: any) {
  const [data] = useVaultData(async () => ({ creds: await Repo.credentials() }), { creds: [] as Credential[] });
  const report = useMemo(() => AnalysisService.report(data.creds), [data.creds]);
  const label = scoreLabel(report.score);
  const reusedCount = report.reused.reduce((a, g) => a + g.length, 0);
  const attention = new Set([...report.weak, ...report.short, ...report.reused.flat()].map(c => c.id)).size;
  const pct = (n: number) => (report.total ? Math.round((n / report.total) * 100) : 0);

  return (
    <Screen title="Saúde das senhas" large>
      {report.total === 0 ? (
        <EmptyState icon="shield" title="Nenhuma senha para analisar" message="Adicione credenciais ao cofre para ver a força das suas senhas." />
      ) : (
        <>
          <Card style={styles.scoreCard}>
            <ScoreRing score={report.score} label={label} />
            <Text style={[Type.small, styles.mt12]}>Índice geral de força das senhas do cofre</Text>
          </Card>
          <AttentionBanner count={attention} />

          <View style={styles.stats}>
            <Stat icon="key" color={Colors.primary} value={String(report.total)} label="Total de senhas" />
            <Stat icon="check-circle" color={Colors.success} value={`${report.strongPercent}%`} label="Senhas fortes" />
            <Stat icon="alert-triangle" color={Colors.danger} value={String(report.weak.length)} label="Fracas / críticas" />
            <Stat icon="copy" color={Colors.orange} value={String(reusedCount)} label="Repetidas" />
          </View>

          <Section title="Gráfico de força (fortes × fracas × repetidas)">
            <Card>
              <StackedBar parts={[...ORDER].reverse().map(s => ({ value: report.distribution[s], color: StrengthColors[s] }))} />
              <View style={styles.gap} />
              <HBarChart data={ORDER.map(s => ({ label: StrengthLabels[s], value: report.distribution[s], color: StrengthColors[s] }))} />
              <View style={styles.legend}>
                <Text style={Type.small}>
                  Fortes: {pct(report.distribution.strong + report.distribution.very_strong)}% • Fracas: {pct(report.weak.length)}% • Reutilizadas: {pct(reusedCount)}%
                </Text>
              </View>
            </Card>
          </Section>

          <AttentionList report={report} onOpen={id => navigation.navigate('CredentialDetail', { id })} />

        </>
      )}
    </Screen>
  );
}

function Stat({ icon, color, value, label }: { icon: string; color: string; value: string; label: string }) {
  return (
    <View style={styles.stat} accessible accessibilityLabel={`${label}: ${value}`}>
      <View style={[styles.statIcon, { backgroundColor: color + '1A' }]}>
        <Icon name={icon} size={17} color={color} />
      </View>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={Type.small}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  mt12: { marginTop: 12 },
  gap: { height: 14 },
  center: { textAlign: 'center', marginTop: 4 },
  scoreCard: { alignItems: 'center', paddingVertical: 24, marginBottom: 14 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 },
  stat: { width: '48.5%', backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: 16, borderWidth: 1, borderColor: Colors.borderLight, ...Shadow.card },
  statIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  statValue: { fontSize: 24, fontWeight: '800', color: Colors.text },
  legend: { marginTop: 6 },
  rec: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: Colors.borderLight, ...Shadow.card },
  recBar: { width: 4, alignSelf: 'stretch', borderRadius: 2, marginRight: 12 },
});
