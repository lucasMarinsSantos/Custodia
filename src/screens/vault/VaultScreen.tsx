// Lista principal: pesquisa avançada, filtros, categorização e ordenação
// inteligente, pastas com arrastar-e-soltar e força de cada senha
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  FlatList,
  PanResponder,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Banner,
  Button,
  Chip,
  ChipRow,
  EmptyState,
  Fab,
  Icon,
  IconButton,
  Input,
  Sheet,
} from '../../components/ui';
import { ServiceIcon, StrengthDot } from '../../components/widgets';
import { Colors, Radius, Shadow, Touch, Type } from '../../theme';
import { useApp, useVaultData } from '../../context/AppState';
import { Repo } from '../../services/Repository';
import {
  localDayBound,
  SearchFilters,
  SearchService,
} from '../../services/SearchService';
import { strengthOf } from '../../services/AnalysisService';
import { sortCredentials } from '../../services/SortService';
import { ClipboardService } from '../../services/ClipboardService';
import { IntegrityService } from '../../services/IntegrityService';
import {
  CategoryLabels,
  Credential,
  CredentialCategory,
  Folder,
  PasswordStrength,
  SortMode,
  StrengthLabels,
} from '../../types/models';
import { Vault } from '../../services/VaultService';
import { toast } from '../../services/events';

const SORT_LABELS: Record<SortMode, string> = {
  smart: 'Inteligente',
  recent: 'Recentes',
  usage: 'Mais usadas',
  alpha: 'A–Z',
};

export default function VaultScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const { profile } = useApp();
  const [data, , loading] = useVaultData(
    async () => {
      const [creds, folders, integrity] = await Promise.all([
        Repo.credentials(),
        Repo.folders(),
        IntegrityService.lastResult(),
      ]);
      return { creds, folders, integrity };
    },
    {
      creds: [] as Credential[],
      folders: [] as Folder[],
      integrity: null as Awaited<
        ReturnType<typeof IntegrityService.lastResult>
      >,
    },
  );
  const [query, setQuery] = useState('');
  const [folderFilter, setFolderFilter] = useState<
    string | 'all' | 'fav' | 'none'
  >('all');
  const [sort, setSort] = useState<SortMode>(
    (Vault.settings.sortMode as SortMode) || 'smart',
  );
  const [filters, setFilters] = useState<SearchFilters>({});
  const [filterOpen, setFilterOpen] = useState(false);

  // --- Arrastar-e-soltar para pastas -------------------------------------
  const [dragItem, setDragItem] = useState<Credential | null>(null);
  const [hoverTarget, setHoverTarget] = useState<string | null>(null);
  const dragRef = useRef<string | null>(null);
  const ghost = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const targets = useRef<
    Record<string, { x: number; y: number; w: number; h: number }>
  >({});
  const targetViews = useRef<Record<string, any>>({});

  const measureTargets = () => {
    Object.entries(targetViews.current).forEach(([id, v]) => {
      v?.measureInWindow(
        (x: number, y: number, w: number, h: number) =>
          (targets.current[id] = { x, y, w, h }),
      );
    });
  };

  const hitTest = (x: number, y: number) => {
    for (const [id, r] of Object.entries(targets.current)) {
      if (x >= r.x && x <= r.x + r.w && y >= r.y - 10 && y <= r.y + r.h + 10)
        return id;
    }
    return null;
  };

  const dragItemRef = useRef<Credential | null>(null);
  const grantedRef = useRef(false);
  const cancelIfNotDragging = () => {
    setTimeout(() => {
      if (dragRef.current && !grantedRef.current) {
        dragRef.current = null;
        dragItemRef.current = null;
        setDragItem(null);
      }
    }, 120);
  };
  const startDrag = (c: Credential, pageX: number, pageY: number) => {
    // Medidas antigas podem ser de pastas que já foram excluídas
    targets.current = {};
    dragRef.current = c.id;
    dragItemRef.current = c;
    grantedRef.current = false;
    ghost.setValue({ x: pageX - 120, y: pageY - 30 });
    setDragItem(c);
    setTimeout(measureTargets, 60);
  };

  const endDrag = async (x: number, y: number) => {
    const c = dragItemRef.current;
    dragItemRef.current = null;
    const target = hitTest(x, y);
    dragRef.current = null;
    setDragItem(null);
    setHoverTarget(null);
    if (c && target) {
      const folderId = target === '__none' ? null : target;
      if ((c.folderId || null) === folderId || !Vault.isUnlocked) return; // já está nesta pasta
      try {
        await Repo.moveCredential(c.id, folderId);
        toast(
          folderId ? 'Credencial movida para a pasta' : 'Removida da pasta',
          'success',
        );
      } catch (e: any) {
        toast(e?.message || 'Não foi possível mover a credencial.', 'error');
      }
    }
  };
  const endDragRef = useRef(endDrag);
  endDragRef.current = endDrag;

  const responders = useRef(
    new Map<string, ReturnType<typeof PanResponder.create>>(),
  );
  // Remove responders de credenciais excluídas (evita crescimento indefinido do cache).
  useEffect(() => {
    const ids = new Set(data.creds.map(c => c.id));
    for (const id of responders.current.keys())
      if (!ids.has(id)) responders.current.delete(id);
  }, [data.creds]);
  const makeResponder = (c: Credential) => {
    const cached = responders.current.get(c.id);
    if (cached) return cached;
    const r = PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponderCapture: () => dragRef.current === c.id,
      onMoveShouldSetPanResponder: () => dragRef.current === c.id,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        grantedRef.current = true;
      },
      onPanResponderMove: (_e, g) => {
        ghost.setValue({ x: g.moveX - 120, y: g.moveY - 30 });
        setHoverTarget(hitTest(g.moveX, g.moveY));
      },
      onPanResponderRelease: (_e, g) => {
        endDragRef.current(g.moveX, g.moveY);
      },
      onPanResponderTerminate: () => {
        dragRef.current = null;
        dragItemRef.current = null;
        setDragItem(null);
      },
    });
    responders.current.set(c.id, r);
    return r;
  };

  // --- Filtragem e ordenação -------------------------------------------------
  const list = useMemo(() => {
    let items = SearchService.search(data.creds, query, filters, data.folders);
    if (folderFilter === 'fav') items = items.filter(c => c.favorite);
    else if (folderFilter === 'none') items = items.filter(c => !c.folderId);
    else if (folderFilter !== 'all') {
      const ids = new Set(Repo.descendantIds(data.folders, folderFilter));
      items = items.filter(c => c.folderId && ids.has(c.folderId));
    }
    return sortCredentials(items, sort);
  }, [data.creds, data.folders, query, filters, folderFilter, sort]);

  // Se a pasta selecionada foi excluída, volta para "Todas"
  useEffect(() => {
    if (
      !SPECIAL_FILTERS.includes(folderFilter) &&
      !data.folders.some(f => f.id === folderFilter)
    )
      setFolderFilter('all');
    // O filtro avançado também esquece pastas excluídas (senão a lista fica vazia sem como desmarcar)
    setFilters(f => {
      if (!f.folderIds?.length) return f;
      const kept = f.folderIds.filter(fid =>
        data.folders.some(x => x.id === fid),
      );
      return kept.length === f.folderIds.length
        ? f
        : { ...f, folderIds: kept.length ? kept : null };
    });
  }, [data.folders, folderFilter]);

  const topFolders = data.folders.filter(f => !f.parentId);
  const activeFilters = Object.values(filters).filter(v =>
    Array.isArray(v) ? v.length : !!v,
  ).length;

  useEffect(() => {
    if (sort !== Vault.settings.sortMode)
      Vault.updateSettings({ sortMode: sort }).catch(() => {});
  }, [sort]);

  const open = (c: Credential) => {
    Repo.touch(c.id).catch(() => {});
    navigation.navigate('CredentialDetail', { id: c.id });
  };

  const copyPassword = async (c: Credential) => {
    try {
      await ClipboardService.copy(c.password, 'Senha');
      await Repo.recordUsage(c.id);
    } catch (e: any) {
      toast(e?.message || 'Não foi possível copiar a senha.', 'error');
    }
  };

  // Handlers estáveis para as linhas memoizadas: leem sempre a versão mais recente via ref.
  const actions = useRef({
    open,
    copyPassword,
    startDrag,
    cancelIfNotDragging,
  });
  actions.current = { open, copyPassword, startDrag, cancelIfNotDragging };
  const rowActions = useMemo<RowActions>(
    () => ({
      open: c => actions.current.open(c),
      copy: c => actions.current.copyPassword(c),
      longPress: (c, x, y) => actions.current.startDrag(c, x, y),
      pressOut: () => actions.current.cancelIfNotDragging(),
    }),
    [],
  );

  const renderItem = useCallback(
    ({ item }: { item: Credential }) => (
      <CredentialRow
        item={item}
        responder={makeResponder(item)}
        dragging={dragItem?.id === item.id}
        actions={rowActions}
      />
    ),
    // makeResponder usa apenas refs estáveis
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dragItem?.id, rowActions],
  );

  const header = (
    <View>
      <View style={[styles.top, { paddingTop: insets.top + 14 }]}>
        <View style={styles.flex}>
          <Text style={Type.h1} accessibilityRole="header">
            Meus acessos
          </Text>
          <Text style={[Type.small, styles.mt2]}>
            {profile?.name || 'Meu cofre'} • {data.creds.length}{' '}
            {data.creds.length === 1 ? 'item' : 'itens'}
          </Text>
        </View>
        <IconButton
          name="folder"
          onPress={() => navigation.navigate('Folders')}
          label="Pastas"
        />
        <View style={styles.w8} />
        <IconButton
          name="lock"
          onPress={() => Vault.lock('manual')}
          label="Bloquear agora"
        />
      </View>

      {data.integrity && !data.integrity.ok ? (
        <View style={styles.px16}>
          <Banner
            tone="danger"
            title="Falha na verificação de integridade"
            text={`${data.integrity.message} Toque para ver os detalhes.`}
            onPress={() => navigation.navigate('About')}
          />
        </View>
      ) : null}

      <View style={styles.searchRow}>
        <View style={styles.search}>
          <Icon name="search" size={18} color={Colors.textTertiary} />
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder='Buscar (ex.: gmail OR "banco" -antigo)'
            placeholderTextColor={Colors.placeholder}
            accessibilityLabel="Buscar no cofre"
            accessibilityHint="Aceita operadores E, OU, NÃO e campos como usuario:"
            returnKeyType="search"
            autoCapitalize="none"
            autoCorrect={false}
          />
          {query ? (
            <TouchableOpacity
              onPress={() => setQuery('')}
              hitSlop={Touch.hitSlop}
              accessibilityRole="button"
              accessibilityLabel="Limpar busca"
            >
              <Icon name="x" size={16} color={Colors.textTertiary} />
            </TouchableOpacity>
          ) : null}
        </View>
        <IconButton
          name="sliders"
          onPress={() => setFilterOpen(true)}
          bg={activeFilters ? Colors.primarySoft : undefined}
          color={activeFilters ? Colors.primary : Colors.text}
          badge={activeFilters || undefined}
          label="Filtros"
        />
      </View>

      <ChipRow style={styles.pb10}>
        <Chip
          label="Todas"
          active={folderFilter === 'all'}
          onPress={() => setFolderFilter('all')}
        />
        <Chip
          label="Favoritas"
          icon="star"
          active={folderFilter === 'fav'}
          onPress={() => setFolderFilter('fav')}
        />
        {topFolders.map(f => (
          <Chip
            key={f.id}
            label={f.name}
            icon="folder"
            color={f.color}
            active={folderFilter === f.id}
            onPress={() => setFolderFilter(f.id)}
          />
        ))}
        <Chip
          label="Sem pasta"
          active={folderFilter === 'none'}
          onPress={() => setFolderFilter('none')}
        />
      </ChipRow>
      <ChipRow style={styles.pb12}>
        {(Object.keys(SORT_LABELS) as SortMode[]).map(m => (
          <TouchableOpacity
            key={m}
            onPress={() => setSort(m)}
            style={[styles.sortChip, sort === m && styles.sortChipActive]}
            hitSlop={{ top: 8, bottom: 8 }}
            accessibilityRole="button"
            accessibilityLabel={`Ordenar: ${SORT_LABELS[m]}`}
            accessibilityState={{ selected: sort === m }}
          >
            {m === sort ? (
              <Icon
                name="bar-chart-2"
                size={12}
                color={Colors.primaryDark}
                style={styles.mr4}
              />
            ) : null}
            <Text
              style={[
                Type.caption,
                styles.bold,
                {
                  color: sort === m ? Colors.primaryDark : Colors.textSecondary,
                },
              ]}
            >
              {SORT_LABELS[m]}
            </Text>
          </TouchableOpacity>
        ))}
      </ChipRow>
      {data.creds.length > 1 && data.folders.length > 0 ? (
        <Text style={[Type.caption, styles.dragHint]}>
          Dica: segure e arraste um item até uma pasta para reorganizar.
        </Text>
      ) : null}
    </View>
  );

  return (
    <View style={styles.root}>
      <FlatList
        data={list}
        keyExtractor={keyOf}
        renderItem={renderItem}
        extraData={dragItem?.id}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        initialNumToRender={12}
        maxToRenderPerBatch={10}
        windowSize={11}
        removeClippedSubviews
        ListHeaderComponent={header}
        scrollEnabled={!dragItem}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={emptyState(loading, data.creds.length)}
      />
      <Fab
        label="Adicionar"
        onPress={() =>
          navigation.navigate('CredentialEdit', {
            folderId: SPECIAL_FILTERS.includes(folderFilter)
              ? null
              : folderFilter,
          })
        }
      />

      {/* Alvos de soltura (pastas) exibidos durante o arraste */}
      {dragItem ? (
        <View
          style={[styles.dropBar, { top: insets.top + 8 }]}
          pointerEvents="none"
        >
          <Text style={[Type.caption, styles.dropTitle]}>
            Solte sobre uma pasta
          </Text>
          <View style={styles.wrapTight}>
            {[
              { id: '__none', name: 'Sem pasta', color: Colors.textSecondary },
              ...data.folders,
            ].map(f => (
              <View
                key={f.id}
                ref={r => {
                  targetViews.current[f.id] = r;
                }}
                style={[
                  styles.dropTarget,
                  hoverTarget === f.id && styles.dropTargetOn,
                ]}
              >
                <Icon
                  name="folder"
                  size={14}
                  color={
                    hoverTarget === f.id ? '#fff' : f.color || Colors.primary
                  }
                />
                <Text
                  style={[
                    styles.dropText,
                    hoverTarget === f.id && styles.dropTextOn,
                  ]}
                >
                  {f.id === '__none'
                    ? f.name
                    : Repo.folderPath(data.folders, f.id)}
                </Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}
      {dragItem ? (
        <Animated.View
          pointerEvents="none"
          style={[styles.ghost, { transform: ghost.getTranslateTransform() }]}
        >
          <ServiceIcon credential={dragItem} size={32} />
          <Text style={[Type.bodyStrong, styles.ml10]} numberOfLines={1}>
            {dragItem.title}
          </Text>
        </Animated.View>
      ) : null}

      <FilterSheet
        visible={filterOpen}
        onClose={() => setFilterOpen(false)}
        filters={filters}
        setFilters={setFilters}
        folders={data.folders}
      />
    </View>
  );
}

const SPECIAL_FILTERS: string[] = ['all', 'fav', 'none'];

function emptyState(loading: boolean, total: number) {
  if (loading && total === 0) return undefined;
  if (total === 0)
    return (
      <EmptyState
        icon="key"
        title="Seu cofre está vazio"
        message="Toque em + para adicionar sua primeira credencial."
      />
    );
  return (
    <EmptyState
      icon="search"
      title="Nenhuma credencial encontrada"
      message="Revise a busca ou os filtros aplicados."
    />
  );
}

/** Mensagem de erro para a data do filtro (vazio = sem filtro). */
function dateError(day?: string | null): string | null {
  if (!day) return null;
  return localDayBound(day, false) === null ? 'Data inválida' : null;
}

/** Liga/desliga um valor numa lista de filtro (lista vazia volta a significar "sem filtro"). */
function toggleIn<T>(list: T[] | null | undefined, value: T): T[] {
  const cur = list || [];
  return cur.includes(value) ? cur.filter(x => x !== value) : [...cur, value];
}

function FilterSheet({
  visible,
  onClose,
  filters,
  setFilters,
  folders,
}: {
  visible: boolean;
  onClose: () => void;
  filters: SearchFilters;
  setFilters: React.Dispatch<React.SetStateAction<SearchFilters>>;
  folders: Folder[];
}) {
  return (
    <Sheet visible={visible} onClose={onClose} title="Filtros avançados">
      <View style={styles.wrap}>
        <Chip
          label="Apenas favoritos"
          icon="star"
          active={!!filters.onlyFavorites}
          onPress={() =>
            setFilters(f => ({ ...f, onlyFavorites: !f.onlyFavorites }))
          }
        />
      </View>
      <Text style={[Type.label, styles.mb8]}>Categoria</Text>
      <View style={styles.wrap}>
        {(Object.keys(CategoryLabels) as CredentialCategory[]).map(cat => {
          const on = filters.categories?.includes(cat);
          return (
            <Chip
              key={cat}
              label={CategoryLabels[cat]}
              active={on}
              onPress={() =>
                setFilters(f => ({
                  ...f,
                  categories: toggleIn(f.categories, cat),
                }))
              }
            />
          );
        })}
      </View>
      {folders.length ? (
        <>
          <Text style={[Type.label, styles.mv8]}>Pasta</Text>
          <View style={styles.wrap}>
            {folders.map(fo => {
              const on = filters.folderIds?.includes(fo.id);
              return (
                <Chip
                  key={fo.id}
                  label={Repo.folderPath(folders, fo.id)}
                  icon="folder"
                  color={fo.color}
                  active={on}
                  onPress={() =>
                    setFilters(f => ({
                      ...f,
                      folderIds: toggleIn(f.folderIds, fo.id),
                    }))
                  }
                />
              );
            })}
          </View>
        </>
      ) : null}
      <Text style={[Type.label, styles.mv8]}>Força da senha</Text>
      <View style={styles.wrap}>
        {(Object.keys(StrengthLabels) as PasswordStrength[]).map(st => {
          const on = filters.strengths?.includes(st);
          return (
            <Chip
              key={st}
              label={StrengthLabels[st]}
              active={on}
              onPress={() =>
                setFilters(f => ({
                  ...f,
                  strengths: toggleIn(f.strengths, st),
                }))
              }
            />
          );
        })}
      </View>
      <Text style={[Type.label, styles.mv8]}>Data de criação (AAAA-MM-DD)</Text>
      <View style={styles.row10}>
        <Input
          containerStyle={styles.flex}
          placeholder="De"
          value={filters.createdFrom || ''}
          onChangeText={t =>
            setFilters(f => ({ ...f, createdFrom: t || null }))
          }
          error={dateError(filters.createdFrom)}
          maxLength={10}
          keyboardType="numbers-and-punctuation"
        />
        <Input
          containerStyle={styles.flex}
          placeholder="Até"
          value={filters.createdTo || ''}
          onChangeText={t => setFilters(f => ({ ...f, createdTo: t || null }))}
          error={dateError(filters.createdTo)}
          maxLength={10}
          keyboardType="numbers-and-punctuation"
        />
      </View>
      <View style={styles.help}>
        <Text style={Type.bodyStrong}>Operadores de busca</Text>
        <Text style={[Type.small, styles.mt4]}>
          AND / E • OR / OU • NOT / -termo • (agrupamento) • "frase exata"{'\n'}
          Campos: titulo: usuario: url: notas: campo: categoria: pasta:
        </Text>
      </View>
      <View style={[styles.row10, styles.mt8]}>
        <Button
          title="Limpar"
          variant="outline"
          style={styles.flex}
          onPress={() => setFilters({})}
        />
        <Button title="Aplicar" style={styles.flex} onPress={onClose} />
      </View>
    </Sheet>
  );
}

const keyOf = (c: Credential) => c.id;

interface RowActions {
  open: (c: Credential) => void;
  copy: (c: Credential) => void;
  longPress: (c: Credential, pageX: number, pageY: number) => void;
  pressOut: () => void;
}

/** Linha da lista memoizada: só re-renderiza quando o próprio item muda. */
const CredentialRow = memo(function CredentialRowView({
  item,
  responder,
  dragging,
  actions,
}: {
  item: Credential;
  responder: ReturnType<typeof PanResponder.create>;
  dragging: boolean;
  actions: RowActions;
}) {
  const s = strengthOf(item.password);
  const a11y = [
    item.title,
    item.username || item.url,
    item.favorite ? 'favorita' : null,
    `senha ${StrengthLabels[s].toLowerCase()}`,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <View {...responder.panHandlers} style={dragging ? styles.dragging : null}>
      <TouchableOpacity
        activeOpacity={0.75}
        style={styles.item}
        onPress={() => actions.open(item)}
        delayLongPress={350}
        onPressOut={actions.pressOut}
        onLongPress={e =>
          actions.longPress(item, e.nativeEvent.pageX, e.nativeEvent.pageY)
        }
        accessibilityRole="button"
        accessibilityLabel={a11y}
        accessibilityHint="Toque para abrir. Toque longo e arraste para mover para uma pasta"
        accessibilityActions={[
          { name: 'activate' },
          { name: 'copy', label: 'Copiar senha' },
        ]}
        onAccessibilityAction={e =>
          e.nativeEvent.actionName === 'copy'
            ? actions.copy(item)
            : actions.open(item)
        }
      >
        <ServiceIcon credential={item} />
        <View style={styles.itemBody}>
          <View style={styles.itemTitleRow}>
            <Text style={[Type.bodyStrong, styles.shrink]} numberOfLines={1}>
              {item.title}
            </Text>
            {item.favorite ? (
              <Icon
                name="star"
                size={13}
                color={Colors.gold}
                style={styles.ml6}
              />
            ) : null}
          </View>
          <Text style={[Type.small, styles.mt2]} numberOfLines={1}>
            {item.username || item.url || '—'}
          </Text>
          <Text style={[Type.caption, styles.mt2]} numberOfLines={1}>
            {CategoryLabels[item.category]}
          </Text>
        </View>
        <StrengthDot strength={s} />
        <TouchableOpacity
          onPress={() => actions.copy(item)}
          style={styles.copyBtn}
          hitSlop={Touch.hitSlop}
          accessibilityRole="button"
          accessibilityLabel={`Copiar senha de ${item.title}`}
        >
          <Icon name="copy" size={17} color={Colors.primary} />
        </TouchableOpacity>
      </TouchableOpacity>
    </View>
  );
});

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  flex: { flex: 1 },
  listContent: { paddingBottom: 110 },
  dragging: { opacity: 0.35 },
  itemBody: { flex: 1, marginLeft: 12 },
  itemTitleRow: { flexDirection: 'row', alignItems: 'center' },
  shrink: { flexShrink: 1 },
  ml6: { marginLeft: 6 },
  ml10: { marginLeft: 10 },
  mr4: { marginRight: 4 },
  mt2: { marginTop: 2 },
  mt4: { marginTop: 4 },
  mt8: { marginTop: 8 },
  mb8: { marginBottom: 8 },
  mv8: { marginVertical: 8 },
  w8: { width: 8 },
  px16: { paddingHorizontal: 16 },
  pb10: { paddingBottom: 10 },
  pb12: { paddingBottom: 12 },
  bold: { fontWeight: '700' },
  row10: { flexDirection: 'row', gap: 10 },
  dragHint: { paddingHorizontal: 20, marginBottom: 8 },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 14,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 10,
    marginBottom: 14,
  },
  search: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 12,
    height: 48,
  },
  searchInput: { flex: 1, marginLeft: 8, fontSize: 14, color: Colors.text },
  sortChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    minHeight: 32,
    borderRadius: 16,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  sortChipActive: {
    backgroundColor: Colors.primaryLight,
    borderColor: Colors.primaryLight,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    marginHorizontal: 16,
    marginBottom: 10,
    padding: 14,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    ...Shadow.card,
  },
  copyBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primarySoft,
    marginLeft: 10,
  },
  dropBar: {
    position: 'absolute',
    left: 12,
    right: 12,
    backgroundColor: 'rgba(13,27,42,0.92)',
    borderRadius: 16,
    padding: 12,
  },
  dropTitle: { color: '#fff', marginBottom: 8, marginLeft: 4 },
  dropTarget: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 38,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  dropTargetOn: { backgroundColor: Colors.primary, borderColor: '#fff' },
  dropText: {
    marginLeft: 6,
    fontWeight: '700',
    fontSize: 13,
    color: Colors.text,
  },
  dropTextOn: { color: '#fff' },
  ghost: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: 240,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 10,
    borderWidth: 2,
    borderColor: Colors.primary,
    ...Shadow.raised,
  },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  wrapTight: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  help: {
    backgroundColor: Colors.surfaceAlt,
    borderRadius: 12,
    padding: 12,
    marginTop: 8,
  },
});
