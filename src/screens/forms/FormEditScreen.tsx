// Novo/editar cartão, endereço ou identidade (Cadastro de Endereço).
//  • Cartão: Luhn e bandeira detectada enquanto digita, validade MM/AA, CVV oculto.
//  • Endereço: "Buscar CEP" consulta o ViaCEP (HTTPS, com timeout); sem internet, o cadastro segue manual.
//  • Identidade: CPF com dígito verificador.
// Os erros aparecem no próprio campo (FormService.validate) e também em mensagem.
import React, { useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { Badge, Button, Input, ListCard, Screen, ToggleRow } from '../../components/ui';
import { Type } from '../../theme';
import {
  CardBrandLabels,
  FORM_LIMITS,
  FormErrors,
  FormKindLabels,
  FormService,
  cvvLength,
  detectCardBrand,
  formatCardNumber,
  formatCep,
  formatCpf,
  lookupCep,
  luhnValid,
  newFormItem,
  onlyDigits,
  splitExpiry,
} from '../../services/FormService';
import { Vault } from '../../services/VaultService';
import { toast } from '../../services/events';
import { Address, FormItem, FormKind, Identity, PaymentCard } from '../../types/models';

const NEW_TITLES: Record<FormKind, string> = { card: 'Novo Cartão', address: 'Novo Endereço', identity: 'Nova Identidade' };
const SAVED: Record<FormKind, string> = { card: 'Cartão salvo', address: 'Endereço salvo', identity: 'Identidade salva' };

type Setter<T> = <K extends keyof T>(key: K, value: T[K]) => void;

export default function FormEditScreen({ navigation, route }: any) {
  const editingId: string | undefined = route.params?.id;
  const kind: FormKind = ['card', 'address', 'identity'].includes(route.params?.kind) ? route.params.kind : 'card';
  const [item, setItem] = useState<FormItem>(() => newFormItem(kind));
  const [loaded, setLoaded] = useState(!editingId);
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const initial = useRef<string | null>(null);
  const saved = useRef(false);

  useEffect(() => {
    if (!editingId) return;
    FormService.get(editingId)
      .then(existing => {
        if (existing) setItem(existing);
      })
      .catch((e: any) => toast(e?.message || 'Não foi possível abrir o item.', 'error'))
      .finally(() => setLoaded(true));
  }, [editingId]);

  useEffect(() => {
    if (loaded && initial.current === null) initial.current = JSON.stringify(item);
  }, [loaded, item]);
  useEffect(
    () =>
      navigation.addListener('beforeRemove', (e: any) => {
        if (saved.current || initial.current === null || initial.current === JSON.stringify(item)) return;
        e.preventDefault();
        Alert.alert('Descartar alterações?', 'As alterações ainda não foram salvas.', [
          { text: 'Continuar editando', style: 'cancel' },
          { text: 'Descartar', style: 'destructive', onPress: () => navigation.dispatch(e.data.action) },
        ]);
      }),
    [navigation, item],
  );

  const set = (key: string, value: unknown) => {
    setItem(prev => ({ ...prev, [key]: value }) as FormItem);
    if (errors[key]) setErrors(e => ({ ...e, [key]: undefined }));
  };

  const save = async () => {
    const found = FormService.validate(item);
    const first = Object.values(found).find(Boolean);
    if (first) {
      setErrors(found);
      return toast(first, 'error');
    }
    setSaving(true);
    try {
      await FormService.save(item);
    } catch (e: any) {
      setSaving(false);
      return toast(e?.message || 'Não foi possível salvar.', 'error');
    }
    saved.current = true;
    toast(SAVED[item.kind], 'success');
    navigation.goBack();
  };

  const remove = () =>
    Alert.alert(`Excluir ${FormKindLabels[item.kind].one.toLowerCase()}`, 'Os dados serão apagados de forma irrecuperável.', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Excluir',
        style: 'destructive',
        onPress: async () => {
          if (!Vault.isUnlocked) return;
          try {
            await FormService.remove(item.id);
            saved.current = true;
            toast('Excluído do cofre', 'success');
            navigation.goBack();
          } catch (e: any) {
            toast(e?.message || 'Não foi possível excluir.', 'error');
          }
        },
      },
    ]);

  if (!loaded) return <Screen title="Carregando…" onBack={() => navigation.goBack()}>{null}</Screen>;

  const saveLabel = `Salvar ${FormKindLabels[item.kind].one}`;
  return (
    <Screen
      title={editingId ? `Editar ${FormKindLabels[item.kind].one.toLowerCase()}` : NEW_TITLES[item.kind]}
      onBack={() => navigation.goBack()}
      footer={<Button title={saveLabel} icon="check" onPress={save} loading={saving} />}
    >
      <Input label="Nome para identificar (opcional)" icon="tag" value={item.label} onChangeText={t => set('label', t)} placeholder={item.kind === 'address' ? 'Ex.: Casa, Trabalho' : 'Ex.: Cartão pessoal'} maxLength={FORM_LIMITS.text} />
      {item.kind === 'card' ? <CardFields card={item} set={set as Setter<PaymentCard>} errors={errors} /> : null}
      {item.kind === 'address' ? <AddressFields address={item} setItem={setItem} set={set as Setter<Address>} errors={errors} /> : null}
      {item.kind === 'identity' ? <IdentityFields identity={item} set={set as Setter<Identity>} errors={errors} /> : null}
      {editingId ? <Button title="Excluir" icon="trash-2" variant="danger" onPress={remove} style={styles.mt8} /> : null}
    </Screen>
  );
}

function CardFields({ card, set, errors }: { card: PaymentCard; set: Setter<PaymentCard>; errors: FormErrors }) {
  const brand = detectCardBrand(card.number);
  const digits = onlyDigits(card.number);
  const luhnHint = digits.length >= 13 && !luhnValid(digits) ? 'Número de cartão inválido' : null;
  return (
    <>
      <Input
        label="Número do cartão"
        required
        icon="credit-card"
        value={formatCardNumber(card.number)}
        onChangeText={t => set('number', onlyDigits(t).slice(0, 19))}
        keyboardType="number-pad"
        maxLength={23}
        error={errors.number || luhnHint}
        right={digits.length >= 4 ? <Badge text={CardBrandLabels[brand]} /> : undefined}
        autoComplete="off"
        importantForAutofill="no"
      />
      <Input label="Nome impresso no cartão" required icon="user" value={card.holder} onChangeText={t => set('holder', t)} autoCapitalize="characters" maxLength={FORM_LIMITS.text} error={errors.holder} />
      <View style={styles.row}>
        <Input
          label="Validade (MM/AA)"
          required
          value={card.expYear ? `${card.expMonth}/${card.expYear}` : card.expMonth}
          onChangeText={t => {
            const { expMonth, expYear } = splitExpiry(t);
            set('expMonth', expMonth);
            set('expYear', expYear);
          }}
          keyboardType="number-pad"
          maxLength={5}
          placeholder="MM/AA"
          error={errors.expiry}
          containerStyle={styles.flex}
        />
        <View style={styles.w12} />
        <Input label="CVV" value={card.cvv} onChangeText={t => set('cvv', onlyDigits(t).slice(0, cvvLength(brand)))} keyboardType="number-pad" secure maxLength={4} error={errors.cvv} containerStyle={styles.flex} />
      </View>
    </>
  );
}

function AddressFields({ address: a, setItem, set, errors }: { address: Address; setItem: (f: (prev: FormItem) => FormItem) => void; set: Setter<Address>; errors: FormErrors }) {
  const [searching, setSearching] = useState(false);
  const searchCep = async () => {
    if (onlyDigits(a.zipCode).length !== 8) return toast('O CEP deve ter 8 dígitos', 'error');
    setSearching(true);
    try {
      const r = await lookupCep(a.zipCode);
      if (!r) return toast('CEP não encontrado ou sem internet. Preencha o endereço manualmente.', 'info');
      // Só preenche os campos vazios: não apaga o que o usuário já digitou
      setItem(prev => {
        const p = prev as Address;
        return { ...p, street: p.street || r.street, neighborhood: p.neighborhood || r.neighborhood, city: r.city, state: r.state, complement: p.complement || r.complement };
      });
      toast('Endereço preenchido pelo CEP', 'success');
    } finally {
      setSearching(false);
    }
  };
  return (
    <>
      <View style={styles.rowEnd}>
        <Input label="CEP" required icon="map-pin" value={a.zipCode} onChangeText={t => set('zipCode', formatCep(t))} keyboardType="number-pad" maxLength={9} placeholder="00000-000" error={errors.zipCode} containerStyle={styles.flex} />
        <View style={styles.w12} />
        <Button title="Buscar CEP" icon="search" variant="secondary" small loading={searching} onPress={searchCep} accessibilityHint="Consulta o CEP no ViaCEP pela internet" style={styles.cepBtn} />
      </View>
      <Text style={[Type.caption, styles.mb12]}>A busca envia só o CEP ao ViaCEP (HTTPS). Sem internet, preencha manualmente.</Text>
      <Input label="Logradouro" required icon="navigation" value={a.street} onChangeText={t => set('street', t)} placeholder="Rua, Avenida…" maxLength={FORM_LIMITS.long} error={errors.street} />
      <View style={styles.row}>
        <Input label="Número" value={a.number} onChangeText={t => set('number', t)} maxLength={20} containerStyle={styles.w110} />
        <View style={styles.w12} />
        <Input label="Complemento" value={a.complement} onChangeText={t => set('complement', t)} maxLength={FORM_LIMITS.text} containerStyle={styles.flex} />
      </View>
      <Input label="Bairro" value={a.neighborhood} onChangeText={t => set('neighborhood', t)} maxLength={FORM_LIMITS.text} />
      <View style={styles.row}>
        <Input label="Cidade" required value={a.city} onChangeText={t => set('city', t)} maxLength={FORM_LIMITS.text} error={errors.city} containerStyle={styles.flex} />
        <View style={styles.w12} />
        <Input label="Estado" required value={a.state} onChangeText={t => set('state', t.toUpperCase().slice(0, 2))} autoCapitalize="characters" maxLength={2} placeholder="SP" error={errors.state} containerStyle={styles.w90} />
      </View>
      <Input label="Ponto de referência" icon="flag" value={a.reference || ''} onChangeText={t => set('reference', t)} maxLength={FORM_LIMITS.long} />
      <Input label="Nome do destinatário" icon="user" value={a.fullName} onChangeText={t => set('fullName', t)} maxLength={FORM_LIMITS.text} />
      <Input label="Telefone" icon="phone" value={a.phone} onChangeText={t => set('phone', t)} keyboardType="phone-pad" maxLength={20} error={errors.phone} />
      <ListCard style={styles.mb12}>
        <ToggleRow icon="home" title="Definir como endereço principal" value={a.isPrimary} onChange={v => set('isPrimary', v)} last />
      </ListCard>
    </>
  );
}

function IdentityFields({ identity: i, set, errors }: { identity: Identity; set: Setter<Identity>; errors: FormErrors }) {
  return (
    <>
      <Input label="Nome completo" required icon="user" value={i.fullName} onChangeText={t => set('fullName', t)} maxLength={FORM_LIMITS.long} error={errors.fullName} />
      <Input label="CPF" icon="hash" value={i.cpf} onChangeText={t => set('cpf', formatCpf(t))} keyboardType="number-pad" maxLength={14} placeholder="000.000.000-00" error={errors.cpf} />
      <Input label="RG" icon="credit-card" value={i.rg} onChangeText={t => set('rg', t)} maxLength={20} />
      <Input label="Data de nascimento" icon="calendar" value={i.birthDate} onChangeText={t => set('birthDate', t)} placeholder="DD/MM/AAAA" keyboardType="numbers-and-punctuation" maxLength={10} error={errors.birthDate} />
      <Input label="E-mail" icon="mail" value={i.email} onChangeText={t => set('email', t)} keyboardType="email-address" autoCapitalize="none" maxLength={FORM_LIMITS.long} error={errors.email} />
      <Input label="Telefone" icon="phone" value={i.phone} onChangeText={t => set('phone', t)} keyboardType="phone-pad" maxLength={20} error={errors.phone} />
      <Input label="Empresa" icon="briefcase" value={i.company} onChangeText={t => set('company', t)} maxLength={FORM_LIMITS.text} />
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row' },
  rowEnd: { flexDirection: 'row', alignItems: 'flex-start' },
  w12: { width: 12 },
  w90: { width: 90 },
  w110: { width: 110 },
  mt8: { marginTop: 8 },
  mb12: { marginBottom: 12 },
  cepBtn: { marginTop: 22 },
});
