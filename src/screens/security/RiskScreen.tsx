// Classificação por risco: nota de 0 a 100 por credencial, do maior risco para o menor, com os motivos
import React, { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Badge, EmptyState, Icon, ListCard, Screen } from '../../components/ui';
import { Colors, Type } from '../../theme';
import { useVaultData } from '../../context/AppState';
import { Repo } from '../../services/Repository';
import { BreachService } from '../../services/BreachService';
import { RiskLevel, RiskLevelLabels, RiskScore, RiskService } from '../../services/RiskService';
import { Credential } from '../../types/models';

export const RISK_COLORS: Record<RiskLevel, { fg: string; bg: string }> = {
  critical: { fg: Colors.danger, bg: Colors.dangerBg },
  high: { fg: Colors.orange, bg: Colors.orangeBg },
  medium: { fg: Colors.warning, bg: Colors.warningBg },
  low: { fg: Colors.success, bg: Colors.successBg },
};

const LEVELS: RiskLevel[] = ['critical', 'high', 'medium', 'low'];

function RiskRow({ cred, risk, onOpen }: { cred: Credential; risk: RiskScore; onOpen: () => void }) {
  const c = RISK_COLORS[risk.level];
  const why = risk.factors.slice(0, 3).map(f => f.label);
  return (
    <TouchableOpacity style={styles.row} onPress={onOpen} accessibilityRole="button" accessibilityLabel={`${cred.title}: risco ${RiskLevelLabels[risk.level]}, ${risk.score} de 100. ${why.join('. ')}`}>
      <View style={[styles.score, { backgroundColor: c.bg }]}>
        <Text style={[styles.scoreText, { color: c.fg }]}>{risk.score}</Text>
      </View>
      <View style={styles.flex}>
        <Text style={Type.bodyStrong} numberOfLines={1}>
          {cred.title}
        </Text>
        <Text style={Type.caption} numberOfLines={2}>
          {why.length ? why.join(' • ') : 'Nenhum problema encontrado'}
        </Text>
      </View>
      <Icon name="chevron-right" size={18} color={Colors.textTertiary} />
    </TouchableOpacity>
  );
}

export default function RiskScreen({ navigation }: any) {
  const [creds] = useVaultData(async () => {
    await BreachService.load(); // o vazamento entra na nota a partir do cache já verificado
    return Repo.credentials();
  }, [] as Credential[]);
  const ranked = useMemo(() => RiskService.rank(creds), [creds]);
  const summary = RiskService.summary(ranked);

  return (
    <Screen title="Classificação por risco" onBack={() => navigation.goBack()}>
      <Text style={[Type.small, styles.intro]}>
        Nota de 0 a 100 combinando força, teste de dicionário, vazamentos, reutilização, idade da senha e validade. Contas de banco, e-mail, governo e
        trabalho pesam mais.
      </Text>
      <View style={styles.badges}>
        {LEVELS.map(l => (
          <Badge key={l} text={`${RiskLevelLabels[l]}: ${summary[l]}`} color={RISK_COLORS[l].fg} bg={RISK_COLORS[l].bg} />
        ))}
      </View>
      {ranked.length === 0 ? (
        <EmptyState icon="bar-chart-2" title="Nenhuma credencial" message="Adicione credenciais para ver a classificação por risco." />
      ) : (
        <ListCard>
          {ranked.map(r => (
            <RiskRow key={r.cred.id} cred={r.cred} risk={r.risk} onOpen={() => navigation.navigate('CredentialDetail', { id: r.cred.id })} />
          ))}
        </ListCard>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  intro: { marginBottom: 12 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, minHeight: 56, borderBottomWidth: 1, borderBottomColor: Colors.divider },
  score: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  scoreText: { fontSize: 17, fontWeight: '800' },
});
