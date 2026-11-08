// Histórico de tentativas de login: sucesso ou falha, método, data e hora e aparelho (sem GPS)
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Chip, ChipRow, EmptyState, Icon, ListCard, Screen } from '../../components/ui';
import { Colors, Type } from '../../theme';
import { useVaultData } from '../../context/AppState';
import { AccessLogService, MethodLabels, RETENTION_DAYS } from '../../services/AccessLogService';
import { AccessLogEntry } from '../../types/models';
import { formatDate } from '../../utils';

function EntryRow({ e }: { e: AccessLogEntry }) {
  const when = formatDate(e.at, true);
  const what = e.success ? 'Acesso permitido' : 'Tentativa de acesso falha';
  return (
    <View style={styles.row} accessible accessibilityLabel={`${what}, ${MethodLabels[e.method]}, ${when}${e.device ? ', ' + e.device : ''}`}>
      <View style={[styles.icon, { backgroundColor: e.success ? Colors.successBg : Colors.dangerBg }]}>
        <Icon name={e.success ? 'unlock' : 'x-octagon'} size={17} color={e.success ? Colors.success : Colors.danger} />
      </View>
      <View style={styles.flex}>
        <Text style={[Type.bodyStrong, !e.success && styles.fail]}>{what}</Text>
        <Text style={Type.small}>
          {MethodLabels[e.method]} • {when}
        </Text>
        {e.detail ? <Text style={Type.caption}>{e.detail}</Text> : null}
        {e.device ? <Text style={Type.caption}>{e.device}</Text> : null}
      </View>
    </View>
  );
}

export default function AccessLogScreen({ navigation }: any) {
  const [onlyFailures, setOnlyFailures] = useState(false);
  const [entries] = useVaultData(() => AccessLogService.list({ onlyFailures }), [] as AccessLogEntry[], [onlyFailures]);
  const failures = entries.filter(e => !e.success).length;

  return (
    <Screen title="Histórico de acessos" onBack={() => navigation.goBack()}>
      <Text style={[Type.small, styles.intro]}>
        Cada desbloqueio do cofre fica registrado por {RETENTION_DAYS} dias: senha mestra, biometria, recuperação ou código 2FA, com a data, a hora e o
        aparelho. Tentativas com o cofre fechado aparecem aqui no próximo acesso.
      </Text>
      <ChipRow style={styles.chips}>
        <Chip label="Todos" active={!onlyFailures} onPress={() => setOnlyFailures(false)} />
        <Chip label="Só falhas" icon="x-octagon" active={onlyFailures} onPress={() => setOnlyFailures(true)} />
      </ChipRow>
      {entries.length === 0 ? (
        <EmptyState icon="clock" title={onlyFailures ? 'Nenhuma tentativa falha' : 'Nenhum acesso registrado'} message="Os próximos desbloqueios aparecem aqui." />
      ) : (
        <>
          {!onlyFailures && failures ? <Text style={[Type.caption, styles.count]}>{failures === 1 ? '1 tentativa falha' : `${failures} tentativas falhas`} no período</Text> : null}
          <ListCard>
            {entries.slice(0, 300).map(e => (
              <EntryRow key={e.id} e={e} />
            ))}
          </ListCard>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  intro: { marginBottom: 12 },
  chips: { marginBottom: 12 },
  count: { marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: Colors.divider },
  icon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  fail: { color: Colors.danger },
});
