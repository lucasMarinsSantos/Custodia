// Ajustes › Importar e exportar
//  • Importar: arquivo CSV/JSON (Custódia, Bitwarden, Chrome/Edge, LastPass, 1Password, Firefox, KeePass) com
//    prévia, duplicadas (ignorar / substituir / manter as duas) e nada gravado antes da confirmação
//  • Importar por foto ou captura de tela (abre o cadastro com o OCR)
//  • Exportar: JSON cifrado com senha temporária (padrão) ou arquivo legível, só depois de confirmar o risco e
//    reautenticar; pastas com "Bloquear exportação" ficam de fora
//  • Inventário de contas, sem senhas, em CSV ou JSON
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Badge, Banner, Button, Card, Chip, ChipRow, Input, KeyValue, ListCard, Row, Screen, Section, Sheet, ToggleRow } from '../../components/ui';
import { PasswordSheet } from '../../components/PasswordSheet';
import { Colors, Type } from '../../theme';
import { toast } from '../../services/events';
import { Transfer } from '../../native/transfer';
import { DuplicateStrategy, DuplicateStrategyLabels, IMPORT_SUCCESS, ImportPreview, ImportService, MAX_IMPORT_BYTES, PreviewItem } from '../../services/ImportService';
import { ExportFile, ExportFormat, ExportFormatLabels, ExportService, InventoryFormat, PLAIN_EXPORT_WARNING } from '../../services/ExportService';
import { EncryptedEnvelope, filePasswordError, generateTemporaryPassword } from '../../services/transfer/envelope';
import { ParsedFile } from '../../services/transfer/formats';
import { Vault } from '../../services/VaultService';

const IMPORT_MIMES = ['text/csv', 'text/comma-separated-values', 'text/plain', 'application/json', 'application/csv', 'application/vnd.ms-excel', 'application/octet-stream'];
const PREVIEW_LIMIT = 30;
const STATUS_LABEL: Record<PreviewItem['status'], { text: string; color: string; bg: string }> = {
  new: { text: 'Nova', color: Colors.success, bg: Colors.successBg },
  duplicate: { text: 'Duplicada', color: Colors.warning, bg: Colors.warningBg },
  error: { text: 'Erro', color: Colors.danger, bg: Colors.dangerBg },
};

// ---------------------------------------------------------------------------
// Importação
// ---------------------------------------------------------------------------
function PreviewCard({ preview, onCancel, onDone }: { preview: ImportPreview; onCancel: () => void; onDone: () => void }) {
  const [strategy, setStrategy] = useState<DuplicateStrategy>('skip');
  const { counts } = preview;
  const toWrite = counts.new + (strategy === 'skip' ? 0 : counts.duplicate);

  const confirm = async () => {
    try {
      const r = await ImportService.apply(preview, strategy);
      const summary = ImportService.summary(r);
      if (r.added + r.replaced === 0 && r.failed) toast(`Nada foi importado: ${summary}`, 'error');
      else toast(`${IMPORT_SUCCESS}: ${summary}`, 'success');
      onDone();
    } catch (e: any) {
      toast(e?.message || 'Não foi possível importar', 'error');
    }
  };

  return (
    <Card>
      <Text style={Type.h3}>Prévia da importação</Text>
      <Text style={[Type.small, styles.mb8]}>
        {preview.fileName} • {preview.formatLabel}
      </Text>
      <KeyValue label="Itens no arquivo" value={String(counts.total)} />
      <KeyValue label="Novos" value={String(counts.new)} />
      <KeyValue label="Duplicados" value={String(counts.duplicate)} />
      <KeyValue label="Com erro (não serão importados)" value={String(counts.error)} />
      <KeyValue label="Credenciais • notas • formulários" value={`${counts.credentials} • ${counts.notes} • ${counts.forms}`} />
      {counts.duplicate ? (
        <>
          <Text style={[Type.label, styles.mt12]}>Itens que já estão no cofre</Text>
          <ChipRow>
            {(Object.keys(DuplicateStrategyLabels) as DuplicateStrategy[]).map(s => (
              <Chip key={s} label={DuplicateStrategyLabels[s]} active={strategy === s} onPress={() => setStrategy(s)} />
            ))}
          </ChipRow>
        </>
      ) : null}
      <View style={styles.mt12}>
        {preview.items.slice(0, PREVIEW_LIMIT).map((it, i) => (
          <View key={`${it.raw.line}-${i}`} style={styles.previewRow}>
            <Text style={[Type.body, styles.flex]} numberOfLines={1}>
              {it.error || it.label}
            </Text>
            <Badge text={STATUS_LABEL[it.status].text} color={STATUS_LABEL[it.status].color} bg={STATUS_LABEL[it.status].bg} />
          </View>
        ))}
        {preview.items.length > PREVIEW_LIMIT ? <Text style={Type.caption}>e mais {preview.items.length - PREVIEW_LIMIT} itens</Text> : null}
      </View>
      <View style={styles.actions}>
        <Button title="Cancelar" variant="outline" onPress={onCancel} style={styles.flex} />
        <Button title={`Importar ${toWrite}`} icon="download" disabled={!toWrite} onPress={confirm} style={styles.flex} />
      </View>
    </Card>
  );
}

function ImportSection({ navigation }: { navigation: any }) {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [locked, setLocked] = useState<{ env: EncryptedEnvelope; name: string } | null>(null);

  const showPreview = async (parsed: ParsedFile, name: string) => setPreview(await ImportService.preview(parsed, name));

  const pick = async () => {
    try {
      const f = await Transfer.pickFile(IMPORT_MIMES, MAX_IMPORT_BYTES);
      if (!f) return;
      const r = ImportService.read(ImportService.decodeFile(f));
      if (r.kind === 'encrypted') setLocked({ env: r.envelope, name: f.name });
      else await showPreview(r.parsed, f.name);
    } catch (e: any) {
      // Inclui o cenário BDD: "Erro de formatação" aborta a importação sem gravar nada
      toast(e?.message || 'Não foi possível ler o arquivo', 'error');
    }
  };

  const unlock = async (password: string) => {
    const parsed = await ImportService.unlock(locked!.env, password);
    const name = locked!.name;
    setLocked(null);
    await showPreview(parsed, name);
  };

  return (
    <Section title="Importar">
      <ListCard>
        <Row icon="upload" title="Importar arquivo CSV ou JSON" subtitle="Custódia, Bitwarden, Chrome/Edge, LastPass, 1Password, Firefox e KeePass" onPress={pick} chevron />
        <Row icon="camera" title="Importar por foto" subtitle="Reconhece usuário e senha de um papel ou cartão (OCR no aparelho)" onPress={() => navigation.navigate('CredentialEdit', { scan: 'camera' })} chevron />
        <Row icon="image" title="Importar de uma captura de tela" subtitle="Escolha a imagem na galeria" onPress={() => navigation.navigate('CredentialEdit', { scan: 'gallery' })} chevron last />
      </ListCard>
      {preview ? <PreviewCard preview={preview} onCancel={() => setPreview(null)} onDone={() => setPreview(null)} /> : null}
      <PasswordSheet
        visible={!!locked}
        title="Arquivo cifrado"
        message="Este arquivo foi exportado pelo Custódia com senha. Digite a senha do arquivo para continuar."
        label="Senha do arquivo"
        confirmTitle="Abrir arquivo"
        onClose={() => setLocked(null)}
        onSubmit={unlock}
      />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Senha do arquivo (exportação cifrada e inventário protegido)
// ---------------------------------------------------------------------------
function FilePassword({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const error = value ? filePasswordError(value) : null;
  return (
    <>
      <Input label="Senha do arquivo" icon="key" mono secure value={value} onChangeText={onChange} error={error} hint="Mínimo de 12 caracteres. A senha não é guardada: anote-a para abrir o arquivo." autoCapitalize="none" />
      <Button title="Gerar senha temporária" icon="refresh-cw" variant="ghost" small onPress={() => onChange(generateTemporaryPassword())} />
    </>
  );
}

/** Reautenticação + montagem + seletor de onde salvar. */
function useExportFlow() {
  const [job, setJob] = useState<(() => Promise<ExportFile>) | null>(null);

  const finish = async (build: () => Promise<ExportFile>) => {
    const file = await build();
    setJob(null);
    const saved = await ExportService.save(file);
    if (!saved) return toast('Exportação cancelada', 'info');
    const omitted = file.omitted ? ` ${file.omitted} ${file.omitted === 1 ? 'item ficou' : 'itens ficaram'} de fora por "Bloquear exportação".` : '';
    toast(`Arquivo salvo com ${file.count} ${file.count === 1 ? 'item' : 'itens'}.${omitted}`, 'success');
  };

  const sheet = (
    <PasswordSheet
      visible={!!job}
      title="Confirme sua identidade"
      message="Exportar exige a senha mestra (ou a biometria) agora."
      confirmTitle="Confirmar e exportar"
      onClose={() => setJob(null)}
      onSubmit={async pw => {
        await ExportService.confirmIdentity({ method: 'password', password: pw });
        await finish(job!);
      }}
      onBiometric={
        Vault.settings.biometricEnabled
          ? async () => {
              await ExportService.confirmIdentity({ method: 'biometric' });
              await finish(job!);
            }
          : undefined
      }
    />
  );
  return { start: (build: () => Promise<ExportFile>) => setJob(() => build), sheet };
}

// ---------------------------------------------------------------------------
// Exportação
// ---------------------------------------------------------------------------
function ExportSection() {
  const [format, setFormat] = useState<ExportFormat>('json_encrypted');
  const [password, setPassword] = useState('');
  const [ack, setAck] = useState(false);
  const flow = useExportFlow();
  const encrypted = format === 'json_encrypted';

  const exportNow = () => {
    if (encrypted) {
      const err = filePasswordError(password);
      if (err) return toast(err, 'error');
    } else if (!ack) {
      return toast('Confirme que entende o risco de exportar um arquivo legível', 'error');
    }
    flow.start(() => ExportService.build(format, { password: encrypted ? password : undefined }));
  };

  return (
    <Section title="Exportar cofre">
      <Card>
        <ChipRow>
          {(Object.keys(ExportFormatLabels) as ExportFormat[]).map(f => (
            <Chip key={f} label={ExportFormatLabels[f]} icon={f === 'json_encrypted' ? 'lock' : 'unlock'} active={format === f} onPress={() => setFormat(f)} />
          ))}
        </ChipRow>
        {encrypted ? (
          <>
            <Text style={[Type.small, styles.mv8]}>AES-256-GCM com chave derivada da senha (PBKDF2). Pode ser importado de volta no Custódia com a mesma senha.</Text>
            <FilePassword value={password} onChange={setPassword} />
          </>
        ) : (
          <>
            <Banner tone="danger" icon="alert-triangle" title="Arquivo sem proteção" text={PLAIN_EXPORT_WARNING} />
            <ToggleRow title="Entendo o risco e quero exportar em texto claro" value={ack} onChange={setAck} last />
          </>
        )}
        <Text style={[Type.caption, styles.mv8]}>Itens de pastas com "Bloquear exportação" ficam de fora.</Text>
        <Button title="Exportar" icon="share" onPress={exportNow} />
      </Card>
      {flow.sheet}
    </Section>
  );
}

function InventorySection() {
  const [format, setFormat] = useState<InventoryFormat>('csv');
  const [protect, setProtect] = useState(false);
  const [password, setPassword] = useState('');
  const flow = useExportFlow();

  const exportNow = () => {
    if (protect) {
      const err = filePasswordError(password);
      if (err) return toast(err, 'error');
    }
    flow.start(() => ExportService.buildInventory(format, { password: protect ? password : undefined }));
  };

  return (
    <Section title="Inventário de contas (sem senhas)">
      <Card>
        <Text style={[Type.small, styles.mb8]}>Lista título, usuário, site, pasta, categoria, força, idade da senha e uso. Nunca inclui senhas, notas ou campos ocultos.</Text>
        <ChipRow>
          <Chip label="CSV" active={format === 'csv'} onPress={() => setFormat('csv')} />
          <Chip label="JSON" active={format === 'json'} onPress={() => setFormat('json')} />
        </ChipRow>
        <ToggleRow title="Proteger o arquivo com senha" value={protect} onChange={setProtect} last />
        {protect ? <FilePassword value={password} onChange={setPassword} /> : null}
        <Button title="Exportar inventário" icon="list" variant="secondary" onPress={exportNow} />
      </Card>
      {flow.sheet}
    </Section>
  );
}

export default function ImportExportScreen({ navigation }: any) {
  const [help, setHelp] = useState(false);
  return (
    <Screen title="Importar e exportar" onBack={() => navigation.goBack()}>
      <ImportSection navigation={navigation} />
      <ExportSection />
      <InventorySection />
      <Button title="Como exportar dos outros gerenciadores" icon="help-circle" variant="ghost" onPress={() => setHelp(true)} />
      <Sheet visible={help} onClose={() => setHelp(false)} title="Exportar de outros gerenciadores">
        <Text style={Type.body}>
          • Bitwarden: Ferramentas › Exportar cofre › JSON (sem senha) ou CSV.{'\n'}• Chrome/Edge: Configurações › Senhas › Exportar senhas (CSV).{'\n'}• LastPass: Opções avançadas › Exportar (CSV).{'\n'}• 1Password: Arquivo › Exportar › CSV.{'\n'}• Firefox: about:logins › Exportar logins (CSV).{'\n\n'}Apague o arquivo legível depois de importar.
        </Text>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  mb8: { marginBottom: 8 },
  mv8: { marginVertical: 8 },
  mt12: { marginTop: 12 },
  previewRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 12 },
});
