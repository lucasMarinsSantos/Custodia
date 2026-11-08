// Central de alertas de segurança: lidos e não lidos, com atalho para o item relacionado
import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Button, Chip, ChipRow, EmptyState, Icon, IconButton, ListCard, Screen, Section, ToggleRow } from '../../components/ui';
import { Colors, Type } from '../../theme';
import { useVaultData } from '../../context/AppState';
import { AlertService } from '../../services/AlertService';
import { NotificationService } from '../../services/NotificationService';
import { Vault } from '../../services/VaultService';
import { Repo } from '../../services/Repository';
import { toast } from '../../services/events';
import { SecurityAlert } from '../../types/models';
import { formatDate } from '../../utils';

const SEVERITY = {
  danger: { color: Colors.danger, bg: Colors.dangerBg, icon: 'alert-octagon' },
  warning: { color: Colors.warning, bg: Colors.warningBg, icon: 'alert-triangle' },
  info: { color: Colors.info, bg: Colors.infoBg, icon: 'info' },
};

const fail = (e: any, msg: string) => toast(e?.message || msg, 'error');

function AlertRow({ a, onOpen, onRemove }: { a: SecurityAlert; onOpen: () => void; onRemove: () => void }) {
  const sv = SEVERITY[a.severity] || SEVERITY.info;
  return (
    <View style={styles.row}>
      <TouchableOpacity style={styles.main} onPress={onOpen} accessibilityRole="button" accessibilityLabel={`${a.read ? '' : 'Não lido. '}${a.title}. ${a.message}`}>
        <View style={[styles.icon, { backgroundColor: sv.bg }]}>
          <Icon name={sv.icon} size={17} color={sv.color} />
        </View>
        <View style={styles.flex}>
          <View style={styles.titleRow}>
            {a.read ? null : <View style={styles.dot} />}
            <Text style={[Type.bodyStrong, styles.flex, a.read && styles.readTitle]}>{a.title}</Text>
          </View>
          <Text style={Type.small}>{a.message}</Text>
          <Text style={Type.caption}>{formatDate(a.createdAt, true)}</Text>
        </View>
      </TouchableOpacity>
      <IconButton name="trash-2" label={`Excluir alerta ${a.title}`} color={Colors.textTertiary} onPress={onRemove} size={17} />
    </View>
  );
}

export default function AlertsScreen({ navigation }: any) {
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [alerts] = useVaultData(() => AlertService.list(), [] as SecurityAlert[]);
  const [notify, setNotify] = useState(!!Vault.settings.securityNotifications);
  const unread = alerts.filter(a => !a.read).length;
  const shown = filter === 'unread' ? alerts.filter(a => !a.read) : alerts;

  const open = async (a: SecurityAlert) => {
    try {
      if (!a.read) await AlertService.markRead(a.id);
      if (a.type === 'login_failed') navigation.navigate('AccessLog');
      else if (a.ref && (await Repo.credential(a.ref))) navigation.navigate('CredentialDetail', { id: a.ref });
    } catch (e) {
      fail(e, 'Não foi possível abrir o alerta');
    }
  };

  const markAll = () => AlertService.markRead().catch(e => fail(e, 'Não foi possível marcar os alertas como lidos'));
  const remove = (a: SecurityAlert) => AlertService.remove(a.id).catch(e => fail(e, 'Não foi possível excluir o alerta'));

  const toggleNotify = async (v: boolean) => {
    try {
      if (v && !(await NotificationService.ensurePermission())) toast('Permita as notificações do Custódia nos ajustes do Android para receber os alertas.', 'info');
      await Vault.updateSettings({ securityNotifications: v });
      setNotify(v);
    } catch (e) {
      fail(e, 'Não foi possível salvar o ajuste');
    }
  };

  return (
    <Screen title="Alertas de segurança" onBack={() => navigation.goBack()}>
      <ChipRow style={styles.chips}>
        <Chip label={`Todos (${alerts.length})`} active={filter === 'all'} onPress={() => setFilter('all')} />
        <Chip label={`Não lidos (${unread})`} active={filter === 'unread'} onPress={() => setFilter('unread')} />
      </ChipRow>
      {unread ? <Button small variant="outline" icon="check" title="Marcar todos como lidos" onPress={markAll} style={styles.markAll} /> : null}
      {shown.length === 0 ? (
        <EmptyState icon="bell" title={filter === 'unread' ? 'Nenhum alerta não lido' : 'Nenhum alerta'} message="Tentativas de acesso que falharam, senhas vazadas e outros avisos aparecem aqui." />
      ) : (
        <ListCard>
          {shown.map(a => (
            <AlertRow key={a.id} a={a} onOpen={() => open(a)} onRemove={() => remove(a)} />
          ))}
        </ListCard>
      )}
      <Section title="Notificações">
        <ListCard>
          <ToggleRow icon="bell" title="Notificações de segurança" subtitle="Avisa na barra do Android, sem mostrar senhas nem nomes de contas" value={notify} onChange={toggleNotify} last />
        </ListCard>
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  chips: { marginBottom: 10 },
  markAll: { alignSelf: 'flex-start', marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', paddingRight: 6, borderBottomWidth: 1, borderBottomColor: Colors.divider },
  main: { flex: 1, flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  icon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.danger },
  readTitle: { color: Colors.textSecondary },
});
