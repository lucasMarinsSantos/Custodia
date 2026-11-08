// Detalhe da nota segura: texto, anexos (pré-visualização de imagens, salvar no aparelho), favorito,
// edição e exclusão segura (: a nota e os anexos são sobrescritos antes de apagar).
import React, { useState } from 'react';
import { Alert, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Badge, Banner, Button, Card, Icon, IconButton, KeyValue, Loading, Screen, Section } from '../../components/ui';
import { Colors, Type } from '../../theme';
import { useVaultData } from '../../context/AppState';
import { NoteService, formatBytes, isPreviewableImage } from '../../services/NoteService';
import { ClipboardService } from '../../services/ClipboardService';
import { Vault } from '../../services/VaultService';
import { System } from '../../native';
import { toast } from '../../services/events';
import { NoteAttachment, NoteCategoryLabels, SecureNote } from '../../types/models';
import { formatDate } from '../../utils';
import { NOTE_CATEGORY_ICONS } from './NotesScreen';

export default function NoteDetailScreen({ navigation, route }: any) {
  const id: string = route.params?.id;
  const [note, , loading] = useVaultData(() => NoteService.get(id), null as SecureNote | null, [id]);

  if (!note) {
    return (
      <Screen title="Nota" onBack={() => navigation.goBack()}>
        {loading ? <Loading /> : <Banner tone="info" text="Esta nota não existe mais." />}
      </Screen>
    );
  }

  const copy = async () => {
    try {
      await ClipboardService.copy(note.content, 'Nota', true);
    } catch (e: any) {
      toast(e?.message || 'Não foi possível copiar.', 'error');
    }
  };

  const toggleFavorite = async () => {
    if (!Vault.isUnlocked) return;
    try {
      await NoteService.setFavorite(note.id, !note.favorite);
    } catch (e: any) {
      toast(e?.message || 'Não foi possível alterar o favorito.', 'error');
    }
  };

  const remove = () =>
    Alert.alert('Excluir nota', `"${note.title}" e os anexos serão apagados de forma irrecuperável.`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Excluir',
        style: 'destructive',
        onPress: async () => {
          if (!Vault.isUnlocked) return;
          try {
            await NoteService.remove(note.id);
            toast('Nota excluída', 'success');
            navigation.goBack();
          } catch (e: any) {
            toast(e?.message || 'Não foi possível excluir a nota.', 'error');
          }
        },
      },
    ]);

  return (
    <Screen
      title="Nota segura"
      onBack={() => navigation.goBack()}
      right={
        <>
          <IconButton name="star" color={note.favorite ? Colors.gold : Colors.textSecondary} onPress={toggleFavorite} label={note.favorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos'} selected={note.favorite} />
          <IconButton name="edit-2" onPress={() => navigation.navigate('NoteEdit', { id: note.id })} label="Editar nota" />
        </>
      }
    >
      <Text style={[Type.h1, styles.title]} accessibilityRole="header">
        {note.title}
      </Text>
      <View style={styles.badges}>
        <Badge text={NoteCategoryLabels[note.category]} icon={NOTE_CATEGORY_ICONS[note.category]} />
        <Badge text="Cifrada" icon="lock" color={Colors.success} bg={Colors.successBg} />
      </View>

      <Card style={styles.mb16}>
        {note.content ? (
          <Text style={Type.body} selectable>
            {note.content}
          </Text>
        ) : (
          <Text style={Type.small}>Sem texto.</Text>
        )}
        {note.content ? <Button title="Copiar texto" icon="copy" variant="secondary" small onPress={copy} style={styles.mt12} /> : null}
      </Card>

      <Section title={`Anexos (${note.attachments.length})`}>
        {note.attachments.length === 0 ? <Text style={Type.small}>Nenhum anexo.</Text> : null}
        {note.attachments.map(a => (
          <AttachmentRow key={a.id} attachment={a} />
        ))}
      </Section>

      <Section title="Informações">
        <Card>
          <KeyValue label="Criada em" value={formatDate(note.createdAt, true)} />
          <KeyValue label="Última alteração" value={formatDate(note.updatedAt, true)} />
        </Card>
      </Section>

      <Button title="Excluir nota" icon="trash-2" variant="danger" onPress={remove} />
    </Screen>
  );
}

/** Anexo: imagem só aparece quando o usuário pede; "Salvar no aparelho" usa o seletor do sistema (sem arquivo temporário). */
export function AttachmentRow({ attachment: a, onRemove }: { attachment: NoteAttachment; onRemove?: () => void }) {
  const [preview, setPreview] = useState(false);
  const image = isPreviewableImage(a);
  const save = async () => {
    if (!Vault.isUnlocked) return;
    try {
      const ok = await System.saveFile(a.name, a.mime, a.data);
      if (ok) toast('Anexo salvo no aparelho', 'success');
    } catch (e: any) {
      toast(e?.message || 'Não foi possível salvar o anexo.', 'error');
    }
  };
  return (
    <Card style={styles.attachment}>
      <View style={styles.row}>
        <Icon name={image ? 'image' : 'paperclip'} size={18} color={Colors.primary} />
        <View style={[styles.flex, styles.ml10]} accessible accessibilityLabel={`Anexo ${a.name}, ${formatBytes(a.size)}`}>
          <Text style={Type.bodyStrong} numberOfLines={1}>
            {a.name}
          </Text>
          <Text style={Type.caption}>
            {formatBytes(a.size)} • {a.mime}
          </Text>
        </View>
        {image ? (
          <TouchableOpacity onPress={() => setPreview(p => !p)} style={styles.btn} accessibilityRole="button" accessibilityLabel={`${preview ? 'Ocultar' : 'Mostrar'} imagem ${a.name}`}>
            <Icon name={preview ? 'eye-off' : 'eye'} size={18} color={Colors.textSecondary} />
          </TouchableOpacity>
        ) : null}
        {onRemove ? (
          <TouchableOpacity onPress={onRemove} style={styles.btn} accessibilityRole="button" accessibilityLabel={`Remover anexo ${a.name}`}>
            <Icon name="trash-2" size={18} color={Colors.danger} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity onPress={save} style={styles.btn} accessibilityRole="button" accessibilityLabel={`Salvar anexo ${a.name} no aparelho`}>
            <Icon name="download" size={18} color={Colors.primary} />
          </TouchableOpacity>
        )}
      </View>
      {image && preview ? <Image source={{ uri: `data:${a.mime};base64,${a.data}` }} style={styles.preview} resizeMode="contain" accessibilityLabel={`Imagem ${a.name}`} /> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  title: { marginBottom: 8 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 16 },
  mb16: { marginBottom: 16 },
  mt12: { marginTop: 12 },
  ml10: { marginLeft: 10 },
  row: { flexDirection: 'row', alignItems: 'center' },
  attachment: { marginBottom: 8, padding: 12 },
  btn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  preview: { width: '100%', height: 220, marginTop: 10, borderRadius: 12, backgroundColor: Colors.divider },
});
