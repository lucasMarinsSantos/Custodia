// Cartões, endereços e identidades (Listagem de Endereços).
// Dados sensíveis aparecem mascarados na lista (cartão: só os 4 últimos dígitos; CPF parcial).
import React, { useMemo, useState } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Badge, Button, Card, Chip, ChipRow, EmptyState, Fab, Icon, Input, Loading, Screen, Sheet } from '../../components/ui';
import { Colors, Type } from '../../theme';
import { useVaultData } from '../../context/AppState';
import { CardBrandLabels, FormKindLabels, FormService, formTitle, formatCep, maskCardNumber, maskCpf, onlyDigits } from '../../services/FormService';
import { ClipboardService } from '../../services/ClipboardService';
import { Vault } from '../../services/VaultService';
import { toast } from '../../services/events';
import { FormItem, FormKind } from '../../types/models';
import { stripAccents } from '../../utils';

export const FORM_KIND_ICONS: Record<FormKind, string> = { card: 'credit-card', address: 'map-pin', identity: 'user' };
const LIST_TITLES: Record<FormKind, string> = { card: 'Meus Cartões', address: 'Meus Endereços', identity: 'Minhas Identidades' };
const KINDS: FormKind[] = ['card', 'address', 'identity'];
const DELETED: Record<FormKind, string> = { card: 'Cartão excluído', address: 'Endereço excluído', identity: 'Identidade excluída' };

/** Segunda linha do item na lista, sem expor o dado completo. */
export function formSummary(item: FormItem): string {
  if (item.kind === 'card') return `${CardBrandLabels[item.brand]} ${maskCardNumber(item.number)} • validade ${item.expMonth}/${item.expYear}`;
  if (item.kind === 'address') return [item.neighborhood, [item.city, item.state].filter(Boolean).join(' - ')].filter(Boolean).join(', ');
  return [maskCpf(item.cpf), item.email].filter(Boolean).join(' • ') || 'Sem CPF';
}

/** O que o botão "copiar" das opções copia, e se é sensível (some da área de transferência). */
function copyTarget(item: FormItem): { value: string; label: string; sensitive: boolean } {
  if (item.kind === 'card') return { value: onlyDigits(item.number), label: 'Número do cartão', sensitive: true };
  if (item.kind === 'address') return { value: [`${item.street}, ${item.number}`, item.complement, item.neighborhood, `${item.city} - ${item.state}`, formatCep(item.zipCode)].filter(Boolean).join(', '), label: 'Endereço', sensitive: false };
  return { value: item.cpf, label: 'CPF', sensitive: true };
}

export default function FormsScreen({ navigation, route }: any) {
  const [kind, setKind] = useState<FormKind>(KINDS.includes(route.params?.kind) ? route.params.kind : 'card');
  const [items, , loading] = useVaultData(() => FormService.list(), [] as FormItem[]);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<FormItem | null>(null);

  const list = useMemo(() => {
    const terms = stripAccents(query.toLowerCase()).split(/\s+/).filter(Boolean);
    return items.filter(i => i.kind === kind).filter(i => {
      const hay = stripAccents(`${formTitle(i)} ${formSummary(i)}`.toLowerCase());
      return terms.every(t => hay.includes(t));
    });
  }, [items, kind, query]);

  const copy = async (item: FormItem) => {
    setOptions(null);
    const t = copyTarget(item);
    if (!t.value) return toast('Nada para copiar', 'info');
    try {
      await ClipboardService.copy(t.value, t.label, t.sensitive);
    } catch (e: any) {
      toast(e?.message || 'Não foi possível copiar.', 'error');
    }
  };

  const remove = (item: FormItem) => {
    setOptions(null);
    Alert.alert(`Excluir ${FormKindLabels[item.kind].one.toLowerCase()}`, `"${formTitle(item)}" será apagado de forma irrecuperável.`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Excluir',
        style: 'destructive',
        onPress: async () => {
          if (!Vault.isUnlocked) return;
          try {
            await FormService.remove(item.id);
            toast(DELETED[item.kind], 'success');
          } catch (e: any) {
            toast(e?.message || 'Não foi possível excluir.', 'error');
          }
        },
      },
    ]);
  };

  return (
    <View style={styles.root}>
      <Screen title={LIST_TITLES[kind]} subtitle="Cifrados no cofre • usados no preenchimento de formulários" onBack={() => navigation.goBack()}>
        <ChipRow style={styles.mb12}>
          {KINDS.map(k => (
            <Chip key={k} label={`${FormKindLabels[k].many} (${items.filter(i => i.kind === k).length})`} icon={FORM_KIND_ICONS[k]} active={kind === k} onPress={() => setKind(k)} />
          ))}
        </ChipRow>
        <Input icon="search" value={query} onChangeText={setQuery} placeholder={`Buscar em ${FormKindLabels[kind].many.toLowerCase()}`} accessibilityLabel={`Buscar em ${FormKindLabels[kind].many.toLowerCase()}`} maxLength={120} autoCorrect={false} />

        {loading ? <Loading /> : null}
        {!loading && list.length === 0 ? <EmptyState icon={FORM_KIND_ICONS[kind]} title={query ? 'Nada encontrado' : FormKindLabels[kind].empty} message="Toque em + para adicionar." /> : null}
        {list.map(item => (
          <Card key={item.id} onPress={() => navigation.navigate('FormEdit', { id: item.id, kind: item.kind })} style={styles.card} accessibilityLabel={`${formTitle(item)}, ${formSummary(item)}`} accessibilityHint="Toque para editar">
            <View style={styles.row}>
              <View style={styles.icon}>
                <Icon name={item.kind === 'address' && /trabalho|empresa/i.test(item.label) ? 'briefcase' : FORM_KIND_ICONS[item.kind]} size={18} color={Colors.primary} />
              </View>
              <View style={styles.flex}>
                <View style={styles.titleRow}>
                  <Text style={[Type.bodyStrong, styles.shrink]} numberOfLines={1}>
                    {formTitle(item)}
                  </Text>
                  {item.kind === 'address' && item.isPrimary ? <Badge text="Principal" icon="check" /> : null}
                </View>
                <Text style={[Type.small, styles.mt2]} numberOfLines={2}>
                  {formSummary(item)}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setOptions(item)} style={styles.more} accessibilityRole="button" accessibilityLabel={`Opções de ${formTitle(item)}`}>
                <Icon name="more-vertical" size={20} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>
          </Card>
        ))}
        <View style={styles.fabSpace} />
      </Screen>
      <Fab label={`Adicionar ${FormKindLabels[kind].one.toLowerCase()}`} onPress={() => navigation.navigate('FormEdit', { kind })} />

      <Sheet visible={!!options} onClose={() => setOptions(null)} title={options ? formTitle(options) : ''}>
        {options ? (
          <View style={styles.gap8}>
            <Button
              title="Editar"
              icon="edit-2"
              variant="outline"
              onPress={() => {
                setOptions(null);
                navigation.navigate('FormEdit', { id: options.id, kind: options.kind });
              }}
            />
            <Button title={`Copiar ${copyTarget(options).label.toLowerCase()}`} icon="copy" variant="secondary" onPress={() => copy(options)} />
            <Button title="Excluir" icon="trash-2" variant="danger" onPress={() => remove(options)} />
          </View>
        ) : null}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  flex: { flex: 1 },
  shrink: { flexShrink: 1 },
  mb12: { marginBottom: 12 },
  mt2: { marginTop: 2 },
  card: { marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  icon: { width: 40, height: 40, borderRadius: 12, backgroundColor: Colors.primarySoft, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  more: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  gap8: { gap: 8 },
  fabSpace: { height: 80 },
});
