// Nova/editar nota segura: título, categoria, texto, pasta, favorito e anexos
// (limite por anexo e total, MIME conferido pelo conteúdo, ver NoteService).
import React, { useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Button, Chip, Input, ListCard, Screen, Section, ToggleRow } from '../../components/ui';
import { Colors, Touch, Type } from '../../theme';
import { NOTE_LIMITS, NoteService, formatBytes, newNote } from '../../services/NoteService';
import { Repo } from '../../services/Repository';
import { Vault } from '../../services/VaultService';
import { Files } from '../../native/files';
import { toast } from '../../services/events';
import { Folder, NoteCategoryLabels, SecureNote } from '../../types/models';
import { AttachmentRow } from './NoteDetailScreen';
import { NOTE_CATEGORY_ICONS } from './NotesScreen';

export default function NoteEditScreen({ navigation, route }: any) {
  const editingId: string | undefined = route.params?.id;
  const [note, setNote] = useState<SecureNote>(() => newNote());
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loaded, setLoaded] = useState(!editingId);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const initial = useRef<string | null>(null);
  const saved = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        setFolders(await Repo.folders());
        if (editingId) {
          const existing = await NoteService.get(editingId);
          if (existing) setNote(existing);
        }
      } catch (e: any) {
        toast(e?.message || 'Não foi possível abrir a nota.', 'error');
      } finally {
        setLoaded(true);
      }
    })();
  }, [editingId]);

  // Alterações não salvas ao sair
  useEffect(() => {
    if (loaded && initial.current === null) initial.current = JSON.stringify(note);
  }, [loaded, note]);
  useEffect(
    () =>
      navigation.addListener('beforeRemove', (e: any) => {
        if (saved.current || initial.current === null || initial.current === JSON.stringify(note)) return;
        e.preventDefault();
        Alert.alert('Descartar alterações?', 'As alterações nesta nota ainda não foram salvas.', [
          { text: 'Continuar editando', style: 'cancel' },
          { text: 'Descartar', style: 'destructive', onPress: () => navigation.dispatch(e.data.action) },
        ]);
      }),
    [navigation, note],
  );

  const set = <K extends keyof SecureNote>(key: K, value: SecureNote[K]) => setNote(prev => ({ ...prev, [key]: value }));
  const totalBytes = note.attachments.reduce((acc, a) => acc + a.size, 0);

  const addAttachment = async () => {
    if (note.attachments.length >= NOTE_LIMITS.attachments) return toast(`Use no máximo ${NOTE_LIMITS.attachments} anexos por nota`, 'error');
    const room = Math.min(NOTE_LIMITS.attachmentBytes, NOTE_LIMITS.totalBytes - totalBytes);
    if (room <= 0) return toast(`Os anexos de uma nota podem somar até ${formatBytes(NOTE_LIMITS.totalBytes)}`, 'error');
    setPicking(true);
    try {
      const file = await Files.pickFile(room);
      if (!file || !Vault.isUnlocked) return;
      // Valida fora do setState: um erro aqui vira mensagem na tela, não uma falha de renderização
      setNote(NoteService.addAttachment(note, file));
      toast(`Anexo "${file.name}" adicionado`, 'success');
    } catch (e: any) {
      toast(e?.message || 'Não foi possível anexar o arquivo.', 'error');
    } finally {
      setPicking(false);
    }
  };

  const save = async () => {
    if (!note.title.trim()) {
      setTitleError('O título é obrigatório');
      return toast('O título é obrigatório', 'error');
    }
    setSaving(true);
    try {
      await NoteService.save(note);
    } catch (e: any) {
      setSaving(false);
      return toast(e?.message || 'Não foi possível salvar a nota.', 'error');
    }
    saved.current = true;
    toast(editingId ? 'Nota atualizada' : 'Nota salva no cofre criptografado', 'success');
    navigation.goBack();
  };

  if (!loaded) return <Screen title="Carregando…" onBack={() => navigation.goBack()}>{null}</Screen>;

  return (
    <Screen
      title={editingId ? 'Editar nota' : 'Nova Nota'}
      onBack={() => navigation.goBack()}
      footer={<Button title={editingId ? 'Salvar alterações' : 'Salvar'} icon="check" onPress={save} loading={saving} />}
    >
      <Input
        label="Título"
        required
        icon="bookmark"
        value={note.title}
        error={titleError}
        onChangeText={t => {
          set('title', t);
          if (titleError && t.trim()) setTitleError(null);
        }}
        placeholder="Ex.: Chave de recuperação - Google"
        maxLength={NOTE_LIMITS.title}
      />

      <Section title="Categoria">
        <View style={styles.wrap}>
          {NoteService.categories().map(k => (
            <Chip key={k} label={NoteCategoryLabels[k]} icon={NOTE_CATEGORY_ICONS[k]} active={note.category === k} onPress={() => set('category', k)} />
          ))}
        </View>
      </Section>

      <Input
        label="Texto confidencial"
        icon="file-text"
        value={note.content}
        onChangeText={t => set('content', t)}
        multiline
        maxLength={NOTE_LIMITS.content}
        placeholder="Chaves, frases de recuperação, dados bancários…"
        autoCorrect={false}
        hint={`${note.content.length}/${NOTE_LIMITS.content} caracteres`}
      />

      <Section
        title={`Anexos (${note.attachments.length}/${NOTE_LIMITS.attachments})`}
        right={
          <TouchableOpacity onPress={addAttachment} disabled={picking} hitSlop={Touch.hitSlop} accessibilityRole="button" accessibilityLabel="Adicionar anexo">
            <Text style={styles.addLink}>{picking ? 'Abrindo…' : '+ Anexar'}</Text>
          </TouchableOpacity>
        }
      >
        <Text style={[Type.caption, styles.mb8]}>
          Até {formatBytes(NOTE_LIMITS.attachmentBytes)} por arquivo e {formatBytes(NOTE_LIMITS.totalBytes)} no total (usado: {formatBytes(totalBytes)}). Os anexos ficam cifrados dentro do cofre.
        </Text>
        {note.attachments.map(a => (
          <AttachmentRow key={a.id} attachment={a} onRemove={() => setNote(prev => NoteService.removeAttachment(prev, a.id))} />
        ))}
      </Section>

      <Section title="Pasta">
        <View style={styles.wrap}>
          <Chip label="Sem pasta" active={!note.folderId} onPress={() => set('folderId', null)} />
          {folders.map(f => (
            <Chip key={f.id} label={Repo.folderPath(folders, f.id)} icon="folder" color={f.color} active={note.folderId === f.id} onPress={() => set('folderId', f.id)} />
          ))}
        </View>
      </Section>

      <ListCard style={styles.mb16}>
        <ToggleRow icon="star" title="Favorita" subtitle="Aparece primeiro na lista de notas" value={note.favorite} onChange={v => set('favorite', v)} last />
      </ListCard>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  mb8: { marginBottom: 8 },
  mb16: { marginBottom: 16 },
  addLink: { color: Colors.primary, fontWeight: '700', paddingVertical: 6 },
});
