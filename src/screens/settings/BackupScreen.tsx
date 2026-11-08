// Ajustes › Backup
//  • Backup cifrado automático a cada N dias (padrão 7), verificado no desbloqueio e ao voltar ao app
//  • "Criar Backup" (BDD): senha mestra → arquivo .custodia no armazenamento local (pasta privada ou escolhida)
//  • Cópia pelo seletor do Android (SAF), que também alcança o Google Drive sem configurar OAuth
//  • Google Drive pela API (escopo drive.file), opcional
//  • "Restaurar Backup" (BDD): arquivo → senha → prévia com contagens → confirmação → mesclar ou substituir
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Banner, Button, Card, Chip, ChipRow, KeyValue, ListCard, Row, Screen, Section, Sheet, ToggleRow } from '../../components/ui';
import { PasswordSheet } from '../../components/PasswordSheet';
import { Type } from '../../theme';
import { useVaultData } from '../../context/AppState';
import { toast } from '../../services/events';
import { Vault } from '../../services/VaultService';
import { BACKUP_KEEP, BackupFileV1, BackupService, BackupStatus, RestoreMode, RestorePreview } from '../../services/BackupService';
import { BackupDoc } from '../../native/backup';

const INTERVALS = [1, 3, 7, 14, 30];
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'nunca');
const DRIVE_STATE: Record<string, string> = { ok: 'conectado', not_configured: 'não configurado', error: 'com erro' };

function StatusCard({ status }: { status: BackupStatus }) {
  return (
    <Card>
      <KeyValue label="Último backup" value={fmt(status.lastAt)} />
      <KeyValue label="Próximo backup automático" value={status.autoBackup ? fmt(status.nextAt) : 'desativado'} />
      <KeyValue label="Destino" value={status.destinationLabel} />
      {status.lastError ? <Banner tone="danger" icon="alert-triangle" text={`Último erro: ${status.lastError}`} /> : null}
    </Card>
  );
}

function ScheduleSection({ status, reload }: { status: BackupStatus; reload: () => Promise<void> }) {
  const update = async (patch: Parameters<typeof Vault.updateSettings>[0]) => {
    try {
      await Vault.updateSettings(patch);
      await reload();
    } catch (e: any) {
      toast(e?.message || 'Não foi possível salvar o ajuste', 'error');
    }
  };
  return (
    <Section title="Backup automático">
      <ListCard>
        <ToggleRow icon="clock" title="Backup automático cifrado" subtitle={`A cada ${status.intervalDays} ${status.intervalDays === 1 ? 'dia' : 'dias'} • mantém os ${BACKUP_KEEP} mais recentes`} value={status.autoBackup} onChange={v => update({ autoBackup: v })} last />
      </ListCard>
      {status.autoBackup ? (
        <ChipRow>
          {INTERVALS.map(d => (
            <Chip key={d} label={`${d} ${d === 1 ? 'dia' : 'dias'}`} active={status.intervalDays === d} onPress={() => update({ backupIntervalDays: d })} />
          ))}
        </ChipRow>
      ) : null}
    </Section>
  );
}

function DestinationSection({ status, reload }: { status: BackupStatus; reload: () => Promise<void> }) {
  const choose = async () => {
    try {
      if (await BackupService.chooseFolder()) {
        toast('Pasta de destino escolhida', 'success');
        await reload();
      }
    } catch (e: any) {
      toast(e?.message || 'Não foi possível usar a pasta escolhida', 'error');
    }
  };
  const internal = async () => {
    try {
      await BackupService.selectInternal();
      await reload();
    } catch (e: any) {
      toast(e?.message || 'Não foi possível alterar o destino', 'error');
    }
  };
  return (
    <Section title="Destino">
      <ListCard>
        <Row icon="folder" title="Escolher pasta de destino" subtitle={status.destination === 'folder' ? status.destinationLabel : 'Hoje: armazenamento interno do app'} onPress={choose} chevron />
        <Row icon="smartphone" title="Usar o armazenamento interno do app" subtitle="Pasta privada, inacessível a outros apps" onPress={internal} disabled={status.destination === 'internal'} last />
      </ListCard>
    </Section>
  );
}

function DriveSection({ status, reload }: { status: BackupStatus; reload: () => Promise<void> }) {
  const toggle = async (v: boolean) => {
    try {
      if (v) await BackupService.connectDrive();
      await Vault.updateSettings({ googleDriveBackup: v });
      if (v) toast('Google Drive conectado', 'success');
    } catch (e: any) {
      toast(e?.message || 'Não foi possível conectar o Google Drive', 'error');
    } finally {
      await reload();
    }
  };
  const d = status.drive;
  const lastSent = d.lastAt ? ` • último envio ${fmt(d.lastAt)}` : '';
  const subtitle = d.state ? `Estado: ${DRIVE_STATE[d.state] || d.state}${lastSent}` : 'Escopo drive.file: o app só vê os arquivos que ele mesmo criou';
  return (
    <Section title="Google Drive">
      <ListCard>
        <ToggleRow icon="cloud" title="Enviar também ao Google Drive" subtitle={subtitle} value={d.enabled} onChange={toggle} last />
      </ListCard>
      {d.error ? <Banner tone="warning" text={d.error} /> : null}
    </Section>
  );
}

function RestoreSheet({ preview, onClose }: { preview: RestorePreview | null; onClose: () => void }) {
  const [mode, setMode] = useState<RestoreMode>('merge');
  const [ack, setAck] = useState(false);
  if (!preview) return null;
  const c = preview.counts;
  const restore = async () => {
    try {
      const r = await BackupService.restore(preview, mode);
      const removed = r.removed ? `, ${r.removed} removidos` : '';
      toast(`Backup restaurado: ${r.written} ${r.written === 1 ? 'item gravado' : 'itens gravados'}${removed}`, 'success');
      onClose();
    } catch (e: any) {
      toast(e?.message || 'Não foi possível restaurar o backup', 'error');
    }
  };
  return (
    <Sheet visible onClose={onClose} title="Restaurar backup">
      <Banner tone="success" icon="check-circle" text="Arquivo íntegro: a verificação de integridade (AES-256-GCM) passou." />
      <KeyValue label="Criado em" value={fmt(preview.createdAt)} />
      <KeyValue label="Credenciais" value={String(c.credentials)} />
      <KeyValue label="Pastas" value={String(c.folders)} />
      <KeyValue label="Notas • formulários" value={`${c.notes} • ${c.forms}`} />
      <KeyValue label="Já existem no cofre" value={String(preview.conflicts)} />
      {preview.invalid ? <Banner tone="warning" text={`${preview.invalid} registros inválidos serão ignorados.`} /> : null}
      <ChipRow>
        <Chip label="Mesclar" active={mode === 'merge'} onPress={() => setMode('merge')} />
        <Chip label="Substituir o cofre" active={mode === 'replace'} onPress={() => setMode('replace')} />
      </ChipRow>
      <Text style={[Type.small, styles.mv8]}>
        {mode === 'merge' ? 'Acrescenta o que falta e atualiza o que for mais recente no backup. Nada é apagado.' : 'O cofre fica igual ao backup: o que não estiver no arquivo será apagado.'}
      </Text>
      <ToggleRow title="Confirmo a restauração deste backup" value={ack} onChange={setAck} last />
      <Button title="Restaurar agora" icon="rotate-ccw" variant={mode === 'replace' ? 'danger' : 'primary'} disabled={!ack} onPress={restore} />
    </Sheet>
  );
}

function SavedList({ docs, onOpen }: { docs: BackupDoc[]; onOpen: (d: BackupDoc) => void }) {
  if (!docs.length) return <Text style={Type.small}>Nenhum backup no destino ainda.</Text>;
  return (
    <ListCard>
      {docs.map((d, i) => (
        <Row key={d.uri} icon="archive" title={fmt(new Date(d.modified).toISOString())} subtitle={`${d.name} • ${Math.max(1, Math.round(d.size / 1024))} KB`} onPress={() => onOpen(d)} chevron last={i === docs.length - 1} />
      ))}
    </ListCard>
  );
}

type Ask = { kind: 'create' } | { kind: 'copy' } | { kind: 'open'; file: BackupFileV1 };

export default function BackupScreen({ navigation }: any) {
  const [data, reload] = useVaultData(async () => ({ status: await BackupService.status(), docs: await BackupService.list().catch(() => [] as BackupDoc[]) }), null as null | { status: BackupStatus; docs: BackupDoc[] });
  const [ask, setAsk] = useState<Ask | null>(null);
  const [preview, setPreview] = useState<RestorePreview | null>(null);

  const submit = async (pw: string) => {
    if (!ask) return;
    if (ask.kind === 'create') {
      const r = await BackupService.createBackup(pw);
      setAsk(null);
      toast(`Backup criado: ${r.name}${r.drive === 'ok' ? ' (enviado ao Google Drive)' : ''}`, 'success');
    } else if (ask.kind === 'copy') {
      const saved = await BackupService.saveCopy(pw);
      setAsk(null);
      toast(saved ? 'Cópia do backup salva' : 'Cópia cancelada', saved ? 'success' : 'info');
    } else {
      // Senha errada: "Falha na descriptografia. Senha inválida." (exibida na folha e em toast)
      const p = await BackupService.open(ask.file, pw);
      setAsk(null);
      setPreview(p);
    }
    await reload();
  };

  const pickRestore = async () => {
    try {
      const file = await BackupService.pickFile();
      if (file) setAsk({ kind: 'open', file });
    } catch (e: any) {
      toast(e?.message || 'Não foi possível ler o backup', 'error');
    }
  };

  const openSaved = async (d: BackupDoc) => {
    try {
      setAsk({ kind: 'open', file: await BackupService.readDocument(d.uri) });
    } catch (e: any) {
      toast(e?.message || 'Não foi possível ler o backup', 'error');
    }
  };

  const opening = ask?.kind === 'open';
  return (
    <Screen title="Backup" onBack={() => navigation.goBack()}>
      {data ? (
        <>
          <StatusCard status={data.status} />
          <View style={styles.actions}>
            <Button title="Criar Backup" icon="save" onPress={() => setAsk({ kind: 'create' })} />
            <Button title="Salvar uma cópia em…" icon="share" variant="outline" onPress={() => setAsk({ kind: 'copy' })} accessibilityHint="Abre o seletor do Android; você pode escolher o Google Drive ou outra pasta" />
            <Button title="Restaurar Backup" icon="rotate-ccw" variant="secondary" onPress={pickRestore} />
          </View>
          <ScheduleSection status={data.status} reload={reload} />
          <DestinationSection status={data.status} reload={reload} />
          <DriveSection status={data.status} reload={reload} />
          <Section title="Backups salvos">
            <SavedList docs={data.docs} onOpen={openSaved} />
          </Section>
          <Banner tone="info" text="O backup é cifrado (AES-256-GCM) com uma chave derivada da chave do cofre. Para restaurar em outro celular, use a senha mestra que valia no dia do backup ou o código de recuperação." />
        </>
      ) : (
        <Text style={Type.small}>Carregando…</Text>
      )}
      <PasswordSheet
        visible={!!ask}
        title={opening ? 'Abrir backup' : 'Confirme a senha mestra'}
        message={opening ? 'Digite a senha mestra do dia do backup (ou o código de recuperação).' : 'O backup é gerado só depois de confirmar a senha mestra.'}
        label={opening ? 'Senha mestra ou código de recuperação' : 'Senha mestra'}
        confirmTitle={opening ? 'Abrir' : 'Confirmar'}
        onClose={() => setAsk(null)}
        onSubmit={submit}
      />
      <RestoreSheet
        preview={preview}
        onClose={() => {
          setPreview(null);
          reload();
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { gap: 8, marginVertical: 12 },
  mv8: { marginVertical: 8 },
});
