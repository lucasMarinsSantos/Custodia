// Histórico de versões da credencial com reversão (rollback)
import React, { useState } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Badge, Card, EmptyState, Icon, Screen } from '../../components/ui';
import { Colors, Type } from '../../theme';
import { useVaultData } from '../../context/AppState';
import { Repo } from '../../services/Repository';
import { ClipboardService } from '../../services/ClipboardService';
import { ChangeType, Credential, CredentialVersion } from '../../types/models';
import { formatDate } from '../../utils';
import { toast } from '../../services/events';
import { Vault } from '../../services/VaultService';

const TYPE_LABEL: Record<ChangeType, { label: string; icon: string; color: string }> = {
  create: { label: 'Criação', icon: 'plus-circle', color: Colors.success },
  update: { label: 'Edição', icon: 'edit-2', color: Colors.info },
  password: { label: 'Troca de senha', icon: 'key', color: Colors.warning },
  restore: { label: 'Reversão', icon: 'rotate-ccw', color: Colors.purple },
  move: { label: 'Movida', icon: 'folder', color: Colors.textSecondary },
  import: { label: 'Importada', icon: 'download', color: Colors.info },
  sync: { label: 'Sincronizada', icon: 'refresh-cw', color: Colors.info },
};

export default function HistoryScreen({ navigation, route }: any) {
  const id = route.params?.id;
  const [data] = useVaultData(async () => ({ cred: await Repo.credential(id), versions: await Repo.versions(id) }), { cred: null as Credential | null, versions: [] as CredentialVersion[] }, [id]);
  const [shown, setShown] = useState<Record<string, boolean>>({});

  const restore = (v: CredentialVersion) =>
    Alert.alert('Restaurar esta versão?', `Os dados voltarão ao estado de ${formatDate(v.changedAt, true)}. A versão atual continuará no histórico.`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Restaurar',
        onPress: async () => {
          if (!Vault.isUnlocked) return; // diálogo aberto antes de um bloqueio do cofre
          try {
            await Repo.restoreVersion(v);
            toast('Versão restaurada', 'success');
            navigation.goBack();
          } catch (e: any) {
            toast(e?.message || 'Não foi possível restaurar a versão.', 'error');
          }
        },
      },
    ]);

  // Só a criação, sem alterações posteriores → "Nenhuma alteração registrada" (cenário BDD)
  const noChanges = data.versions.length <= 1;
  return (
    <Screen title="Histórico" subtitle={data.cred?.title} onBack={() => navigation.goBack()}>
      {noChanges ? (
        <EmptyState icon="clock" title="Nenhuma alteração registrada" message="Quando você editar esta credencial, as versões anteriores aparecerão aqui para restauração." />
      ) : (
        data.versions.map((v, i) => {
          const t = TYPE_LABEL[v.changeType] || TYPE_LABEL.update;
          const pwChanged = i > 0 && v.snapshot.password !== data.cred?.password;
          return (
            <View key={v.id} style={styles.row}>
              <View style={styles.timeline}>
                <View style={[styles.dot, { backgroundColor: t.color + '22' }]}>
                  <Icon name={t.icon} size={13} color={t.color} />
                </View>
                {i < data.versions.length - 1 ? <View style={styles.line} /> : null}
              </View>
              <Card style={styles.card}>
                <View style={styles.cardHead}>
                  <Badge text={t.label} color={t.color} bg={t.color + '1A'} />
                  <Text style={Type.caption}>{formatDate(v.changedAt, true)}</Text>
                </View>
                <Text style={[Type.small, styles.summary]}>{v.summary}</Text>
                {pwChanged ? (
                  <View style={styles.pwRow}>
                    <Text style={[Type.mono, styles.pw]}>{shown[v.id] ? v.snapshot.password || '(vazia)' : '••••••••••'}</Text>
                    <TouchableOpacity accessibilityRole="button" accessibilityLabel={shown[v.id] ? 'Ocultar senha desta versão' : 'Mostrar senha desta versão'} onPress={() => setShown(s => ({ ...s, [v.id]: !s[v.id] }))} style={styles.iconBtn}>
                      <Icon name={shown[v.id] ? 'eye-off' : 'eye'} size={16} color={Colors.textSecondary} />
                    </TouchableOpacity>
                    <TouchableOpacity accessibilityRole="button" accessibilityLabel="Copiar senha desta versão" onPress={() => ClipboardService.copy(v.snapshot.password, 'Senha antiga')} style={styles.iconBtn}>
                      <Icon name="copy" size={16} color={Colors.primary} />
                    </TouchableOpacity>
                  </View>
                ) : null}
                {i > 0 ? (
                  <TouchableOpacity accessibilityRole="button" hitSlop={10} onPress={() => restore(v)} style={styles.restore}>
                    <Icon name="rotate-ccw" size={14} color={Colors.primary} />
                    <Text style={styles.restoreText}>Restaurar esta versão</Text>
                  </TouchableOpacity>
                ) : (
                  <Text style={[Type.caption, styles.summary]}>Versão atual</Text>
                )}
              </Card>
            </View>
          );
        })
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  timeline: { alignItems: 'center', width: 30 },
  dot: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  line: { width: 2, flex: 1, backgroundColor: Colors.border },
  card: { flex: 1, marginLeft: 10, marginBottom: 12, padding: 14 },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  summary: { marginTop: 8, color: Colors.text },
  pwRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  pw: { flex: 1, fontSize: 14 },
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  restore: { marginTop: 10, flexDirection: 'row', alignItems: 'center', minHeight: 36 },
  restoreText: { color: Colors.primary, fontWeight: '700', marginLeft: 6 },
});
