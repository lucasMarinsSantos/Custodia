// Notas Seguras: lista com busca, categorias e favoritas.
// O conteúdo fica no banco cifrado (SQLCipher); a lista mostra só uma prévia de duas linhas.
import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Card, Chip, ChipRow, EmptyState, Fab, Icon, IconButton, Input, Loading, Screen } from '../../components/ui';
import { Colors, Type } from '../../theme';
import { useVaultData } from '../../context/AppState';
import { NoteService } from '../../services/NoteService';
import { NoteCategory, NoteCategoryLabels, SecureNote } from '../../types/models';
import { formatDate } from '../../utils';

export const NOTE_CATEGORY_ICONS: Record<NoteCategory, string> = {
  recovery_key: 'key',
  wifi: 'wifi',
  bank_info: 'dollar-sign',
  document: 'file-text',
  personal: 'user',
  other: 'lock',
};

export default function NotesScreen({ navigation }: any) {
  const [notes, , loading] = useVaultData(() => NoteService.list(), [] as SecureNote[]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<NoteCategory | 'all' | 'fav'>('all');

  const list = useMemo(() => {
    let items = NoteService.search(notes, query);
    if (category === 'fav') items = items.filter(n => n.favorite);
    else if (category !== 'all') items = items.filter(n => n.category === category);
    return items;
  }, [notes, query, category]);

  const used = new Set(notes.map(n => n.category));

  return (
    <View style={styles.root}>
      <Screen
        title="Notas Seguras"
        subtitle={`${notes.length} ${notes.length === 1 ? 'nota' : 'notas'} • cifradas no cofre`}
        large
        right={<IconButton name="credit-card" label="Cartões, endereços e identidades" onPress={() => navigation.navigate('Forms')} />}
      >
        <Input icon="search" value={query} onChangeText={setQuery} placeholder="Buscar notas" accessibilityLabel="Buscar notas" autoCapitalize="none" autoCorrect={false} maxLength={256} />
        <ChipRow style={styles.chips}>
          <Chip label="Todas" active={category === 'all'} onPress={() => setCategory('all')} />
          <Chip label="Favoritas" icon="star" active={category === 'fav'} onPress={() => setCategory('fav')} />
          {NoteService.categories()
            .filter(k => used.has(k))
            .map(k => (
              <Chip key={k} label={NoteCategoryLabels[k]} icon={NOTE_CATEGORY_ICONS[k]} active={category === k} onPress={() => setCategory(k)} />
            ))}
        </ChipRow>

        {loading ? <Loading /> : null}
        {!loading && list.length === 0 ? (
          <EmptyState
            icon="file-text"
            title={notes.length ? 'Nenhuma nota encontrada' : 'Nenhuma nota segura'}
            message={notes.length ? 'Tente outra busca ou categoria.' : 'Guarde chaves de recuperação, senhas de Wi-Fi e dados bancários com a mesma proteção das senhas.'}
          />
        ) : null}
        {list.map(n => (
          <NoteCard key={n.id} note={n} onPress={() => navigation.navigate('NoteDetail', { id: n.id })} />
        ))}
        <View style={styles.fabSpace} />
      </Screen>
      <Fab label="Nova Nota" onPress={() => navigation.navigate('NoteEdit', {})} />
    </View>
  );
}

function NoteCard({ note: n, onPress }: { note: SecureNote; onPress: () => void }) {
  const files = n.attachments.length;
  return (
    <Card
      onPress={onPress}
      style={styles.card}
      accessibilityLabel={[n.title, NoteCategoryLabels[n.category], n.favorite ? 'favorita' : null, files ? `${files} ${files === 1 ? 'anexo' : 'anexos'}` : null].filter(Boolean).join(', ')}
      accessibilityHint="Toque para abrir a nota"
    >
      <View style={styles.row}>
        <View style={styles.icon}>
          <Icon name={NOTE_CATEGORY_ICONS[n.category]} size={18} color={Colors.primary} />
        </View>
        <View style={styles.flex}>
          <View style={styles.titleRow}>
            <Text style={[Type.bodyStrong, styles.shrink]} numberOfLines={1}>
              {n.title}
            </Text>
            {n.favorite ? <Icon name="star" size={13} color={Colors.gold} style={styles.ml6} /> : null}
          </View>
          {n.content ? (
            <Text style={[Type.small, styles.mt2]} numberOfLines={2}>
              {NoteService.preview(n.content)}
            </Text>
          ) : null}
          <View style={styles.footer}>
            <Text style={Type.caption}>{NoteCategoryLabels[n.category]}</Text>
            {files ? (
              <View style={styles.titleRow}>
                <Icon name="paperclip" size={12} color={Colors.textTertiary} />
                <Text style={[Type.caption, styles.ml4]}>{files}</Text>
              </View>
            ) : null}
            <Text style={[Type.caption, styles.date]}>{formatDate(n.createdAt)}</Text>
          </View>
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  flex: { flex: 1 },
  shrink: { flexShrink: 1 },
  chips: { marginBottom: 12 },
  card: { marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  icon: { width: 38, height: 38, borderRadius: 12, backgroundColor: Colors.primarySoft, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  titleRow: { flexDirection: 'row', alignItems: 'center' },
  ml4: { marginLeft: 4 },
  ml6: { marginLeft: 6 },
  mt2: { marginTop: 2 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 },
  date: { marginLeft: 'auto' },
  fabSpace: { height: 80 },
});
