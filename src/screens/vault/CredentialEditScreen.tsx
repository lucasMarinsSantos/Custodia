// Nova/editar credencial: campos completos, categorização inteligente,
// pasta, gerador integrado, força em tempo real e ícone personalizado
import React, { useEffect, useRef, useState } from 'react';
import { Alert, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Badge, Button, Card, Chip, Icon, Input, ListCard, Screen, Section, Sheet, ToggleRow } from '../../components/ui';
import { ServiceIcon, StrengthMeter } from '../../components/widgets';
import { ExpiryEditor } from '../../components/lifecycle';
import { Colors, Touch, Type } from '../../theme';
import { LIMITS, newCredential, Repo } from '../../services/Repository';
import { CategoryService, Confidence } from '../../services/CategoryService';
import { GLYPHS, ICON_COLORS } from '../../services/IconService';
import { uuid } from '../../crypto';
import { System } from '../../native';
import { toast } from '../../services/events';
import { DictionaryService } from '../../services/DictionaryService';
import { DictionaryWarning } from '../../components/DictionaryWarning';
import { FolderRulesService } from '../../services/FolderRulesService';
import { CategoryLabels, Credential, CredentialCategory, CustomField, Folder } from '../../types/models';
import { mergePrefill, OcrScan } from '../../components/OcrScan';
import { AssociatedSitesEditor } from '../../components/AssociatedSites';
import { prefillFromAutofill } from '../../services/AssociationService';

export default function CredentialEditScreen({ navigation, route }: any) {
  const editingId: string | undefined = route.params?.id;
  const [c, setC] = useState<Credential>(() => newCredential({ folderId: route.params?.folderId || null, ...prefillFromAutofill(route.params) }));
  const [folders, setFolders] = useState<Folder[]>([]);
  const [suggestion, setSuggestion] = useState<{ category: CredentialCategory; name?: string; confidence: Confidence } | null>(null);
  const [iconOpen, setIconOpen] = useState(false);
  const [loaded, setLoaded] = useState(!editingId);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // data de validade digitada e ainda inválida bloqueia o salvamento
  const expiryInvalid = useRef(false);
  const categoryTouched = useRef(!!editingId);
  // Snapshot para detectar alterações não salvas ao sair da tela
  const initial = useRef<string | null>(null);
  const saved = useRef(false);
  useEffect(() => {
    if (loaded && initial.current === null) initial.current = JSON.stringify(c);
  }, [loaded, c]);
  useEffect(
    () =>
      navigation.addListener('beforeRemove', (e: any) => {
        if (saved.current || initial.current === null || initial.current === JSON.stringify(c)) return;
        e.preventDefault();
        Alert.alert('Descartar alterações?', 'As alterações nesta credencial ainda não foram salvas.', [
          { text: 'Continuar editando', style: 'cancel' },
          { text: 'Descartar', style: 'destructive', onPress: () => navigation.dispatch(e.data.action) },
        ]);
      }),
    [navigation, c],
  );

  useEffect(() => {
    (async () => {
      setFolders(await Repo.folders());
      if (editingId) {
        const existing = await Repo.credential(editingId);
        if (existing) setC(existing);
        setLoaded(true);
      }
    })();
  }, [editingId]);

  // Senha escolhida no gerador
  useEffect(() => {
    if (route.params?.generated) {
      setC(prev => ({ ...prev, password: route.params.generated }));
      navigation.setParams({ generated: undefined });
    }
  }, [route.params?.generated, navigation]);

  const set = <K extends keyof Credential>(key: K, value: Credential[K]) => setC(prev => ({ ...prev, [key]: value }));

  /** Categorização inteligente: sugere categoria (e site) a partir do nome/URL. */
  const suggest = () => {
    if (!c.url && !c.title) return;
    const s = CategoryService.suggest(c.url, c.title);
    setSuggestion(s);
    if (!categoryTouched.current && s.confidence !== 'baixa') set('category', s.category);
    if (!c.url && c.title) {
      const d = CategoryService.domainForName(c.title);
      if (d) set('url', `https://${d}`);
    }
  };

  const updateField = (id: string, patch: Partial<CustomField>) => set('customFields', c.customFields.map(f => (f.id === id ? { ...f, ...patch } : f)));

  const pickIconImage = async () => {
    let img: Awaited<ReturnType<typeof System.pickImage>> = null;
    try {
      img = await System.pickImage();
    } catch (e: any) {
      return toast(e?.message || 'Não foi possível usar a imagem escolhida.', 'error');
    }
    if (!img) return;
    if (img.base64.length > 400000) return toast('Imagem muito grande (máx. ~300 KB)', 'error');
    set('icon', { kind: 'image', image: `data:${img.mime || 'image/jpeg'};base64,${img.base64}` });
  };

  const save = async () => {
    if (!c.title.trim()) {
      setTitleError('O título é obrigatório');
      return toast('O título é obrigatório', 'error');
    }
    if (expiryInvalid.current) return toast('Data de validade inválida (use DD/MM/AAAA)', 'error');
    // Força mínima exigida pela pasta
    const policyError = FolderRulesService.passwordError(folders, c.folderId, c.password);
    if (policyError) return toast(policyError, 'error');
    setSaving(true);
    try {
      await Repo.saveCredential({ ...c, title: c.title.trim(), username: c.username.trim(), url: c.url.trim(), customFields: c.customFields.filter(f => f.label.trim() || f.value) });
    } catch (e: any) {
      setSaving(false);
      return toast(e?.message || 'Não foi possível salvar a credencial', 'error');
    }
    saved.current = true;
    toast(editingId ? 'Credencial atualizada' : 'Credencial salva no cofre criptografado', 'success');
    navigation.goBack();
  };

  if (!loaded) return <Screen title="Carregando…" onBack={() => navigation.goBack()}>{null}</Screen>;

  return (
    <Screen
      title={editingId ? 'Editar credencial' : 'Nova credencial'}
      onBack={() => navigation.goBack()}
      footer={<Button title={editingId ? 'Salvar alterações' : 'Salvar'} icon="check" onPress={save} loading={saving} />}
    >
      <View style={styles.iconRow}>
        <TouchableOpacity onPress={() => setIconOpen(true)} accessibilityRole="button" accessibilityLabel="Personalizar ícone do serviço">
          <ServiceIcon credential={c} size={58} />
          <View style={styles.editBadge}>
            <Icon name="edit-2" size={11} color="#fff" />
          </View>
        </TouchableOpacity>
        <View style={styles.iconInfo}>
          <Text style={Type.small}>Toque no ícone para personalizar</Text>
          {suggestion ? (
            <View style={styles.suggestion}>
              <Badge text={`Sugestão: ${CategoryLabels[suggestion.category]}`} icon="zap" />
              <Text style={Type.caption}>confiança {suggestion.confidence}</Text>
            </View>
          ) : null}
        </View>
      </View>

      {/* importar por foto/captura de tela (só no cadastro novo; o usuário revisa antes de salvar) */}
      {!editingId ? <OcrScan autoStart={route.params?.scan} onApply={p => setC(prev => mergePrefill(prev, p))} /> : null}

      <Input
        label="Título"
        required
        icon="bookmark"
        value={c.title}
        error={titleError}
        onChangeText={t => {
          set('title', t);
          if (titleError && t.trim()) setTitleError(null);
        }}
        onBlur={suggest}
        placeholder="Ex.: Gmail, Nubank"
        returnKeyType="next"
        maxLength={LIMITS.title}
      />
      <Input label="Site ou app" icon="globe" value={c.url} onChangeText={t => set('url', t)} onBlur={suggest} placeholder="https://exemplo.com" autoCapitalize="none" keyboardType="url" maxLength={LIMITS.url} />
      <Input label="Usuário / e-mail" icon="user" value={c.username} onChangeText={t => set('username', t)} autoCapitalize="none" keyboardType="email-address" maxLength={LIMITS.username} />
      <Input
        label="Senha"
        icon="key"
        value={c.password}
        onChangeText={t => set('password', t)}
        maxLength={LIMITS.password}
        secure
        mono
        right={
          <View style={styles.rowOnly}>
            <TouchableOpacity onPress={() => set('password', DictionaryService.generate())} hitSlop={Touch.hitSlop} style={styles.inlineBtn} accessibilityRole="button" accessibilityLabel="Gerar senha aleatória">
              <Icon name="shuffle" size={18} color={Colors.primary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => navigation.navigate('GeneratorModal', { returnTo: 'CredentialEdit' })} hitSlop={Touch.hitSlop} style={styles.inlineBtn} accessibilityRole="button" accessibilityLabel="Abrir gerador de senhas">
              <Icon name="sliders" size={18} color={Colors.primary} />
            </TouchableOpacity>
          </View>
        }
        containerStyle={styles.mb8}
        error={FolderRulesService.passwordError(folders, c.folderId, c.password) ?? undefined}
      />
      <StrengthMeter password={c.password} />
      <DictionaryWarning password={c.password} />
      <View style={styles.gap} />

      <Section title="Categoria">
        <View style={styles.wrap}>
          {(Object.keys(CategoryLabels) as CredentialCategory[]).map(k => (
            <Chip
              key={k}
              label={CategoryLabels[k]}
              active={c.category === k}
              onPress={() => {
                categoryTouched.current = true;
                set('category', k);
              }}
              icon={suggestion?.category === k ? 'zap' : undefined}
            />
          ))}
        </View>
      </Section>

      <Section title="Pasta">
        <View style={styles.wrap}>
          <Chip label="Sem pasta" active={!c.folderId} onPress={() => set('folderId', null)} />
          {folders.map(f => (
            <Chip key={f.id} label={Repo.folderPath(folders, f.id)} icon="folder" color={f.color} active={c.folderId === f.id} onPress={() => set('folderId', f.id)} />
          ))}
        </View>
      </Section>

      <Section
        title="Campos personalizados"
        right={
          <TouchableOpacity
            onPress={() =>
              c.customFields.length >= LIMITS.customFields
                ? toast(`Use no máximo ${LIMITS.customFields} campos personalizados`, 'error')
                : set('customFields', [...c.customFields, { id: uuid(), label: '', value: '', type: 'text' }])
            }
            hitSlop={Touch.hitSlop}
            accessibilityRole="button"
            accessibilityLabel="Adicionar campo personalizado"
          >
            <Text style={styles.addLink}>+ Adicionar</Text>
          </TouchableOpacity>
        }
      >
        {c.customFields.length === 0 ? <Text style={Type.small}>Ex.: PIN, pergunta de segurança, número da conta.</Text> : null}
        {c.customFields.map(f => (
          <Card key={f.id} style={styles.fieldCard}>
            <Input label="Nome do campo" value={f.label} onChangeText={t => updateField(f.id, { label: t })} maxLength={LIMITS.fieldLabel} containerStyle={styles.mb8} />
            <Input label="Valor" value={f.value} onChangeText={t => updateField(f.id, { value: t })} maxLength={LIMITS.fieldValue} secure={f.type === 'hidden'} containerStyle={styles.mb8} />
            <View style={styles.fieldFooter}>
              <View style={styles.rowGap6}>
                {(['text', 'hidden', 'url', 'email'] as const).map(t => (
                  <Chip key={t} label={{ text: 'Texto', hidden: 'Oculto', url: 'URL', email: 'E-mail' }[t]} active={f.type === t} onPress={() => updateField(f.id, { type: t })} />
                ))}
              </View>
              <TouchableOpacity
                onPress={() => set('customFields', c.customFields.filter(x => x.id !== f.id))}
                style={styles.trashBtn}
                accessibilityRole="button"
                accessibilityLabel={`Remover campo ${f.label || 'sem nome'}`}
              >
                <Icon name="trash-2" size={18} color={Colors.danger} />
              </TouchableOpacity>
            </View>
          </Card>
        ))}
      </Section>

      <AssociatedSitesEditor value={c} onChange={next => setC(prev => ({ ...prev, associatedDomains: next.associatedDomains, androidPackages: next.androidPackages }))} />

      <Input label="Notas" icon="file-text" value={c.notes} onChangeText={t => set('notes', t)} maxLength={LIMITS.notes} multiline placeholder="Informações adicionais (cifradas)" />

      {/* validade e prazo de troca */}
      <ExpiryEditor credential={c} onChange={patch => setC(prev => ({ ...prev, ...patch }))} onInvalid={v => (expiryInvalid.current = v)} />

      <ListCard style={styles.mb16}>
        <ToggleRow icon="star" title="Favorita" subtitle="Aparece primeiro na ordenação inteligente" value={c.favorite} onChange={v => set('favorite', v)} last />
      </ListCard>

      <Sheet visible={iconOpen} onClose={() => setIconOpen(false)} title="Ícone do serviço">
        <View style={styles.wrap}>
          <Chip label="Logo do site (automático)" icon="globe" active={c.icon.kind === 'auto'} onPress={() => set('icon', { kind: 'auto', color: c.icon.color })} />
          <Chip label="Imagem da galeria" icon="image" active={c.icon.kind === 'image'} onPress={pickIconImage} />
        </View>
        <Text style={[Type.label, styles.mv10]}>Ícone</Text>
        <View style={styles.wrap}>
          {GLYPHS.map(g => (
            <TouchableOpacity
              key={g}
              accessibilityRole="button"
              accessibilityLabel={`Ícone ${g}`}
              accessibilityState={{ selected: c.icon.kind === 'glyph' && c.icon.glyph === g }}
              onPress={() => set('icon', { kind: 'glyph', glyph: g, color: c.icon.color || Colors.primary })}
              style={[styles.glyph, c.icon.kind === 'glyph' && c.icon.glyph === g && styles.glyphOn]}
            >
              <Icon name={g} size={18} color={Colors.text} />
            </TouchableOpacity>
          ))}
        </View>
        <Text style={[Type.label, styles.mv10]}>Cor</Text>
        <View style={styles.wrap}>
          {ICON_COLORS.map(col => (
            <TouchableOpacity
              key={col}
              accessibilityRole="button"
              accessibilityLabel={`Cor ${col}`}
              accessibilityState={{ selected: c.icon.color === col }}
              onPress={() => set('icon', { ...c.icon, kind: c.icon.kind === 'image' ? 'auto' : c.icon.kind, color: col })}
              style={[styles.color, { backgroundColor: col }, c.icon.color === col && styles.colorOn]}
            >
              {c.icon.color === col ? <Icon name="check" size={16} color="#fff" /> : null}
            </TouchableOpacity>
          ))}
        </View>
        {c.icon.kind === 'image' && c.icon.image ? <Image source={{ uri: c.icon.image }} style={styles.preview} /> : null}
        <Button title="Concluir" style={styles.mt16} onPress={() => setIconOpen(false)} />
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  iconRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 18 },
  iconInfo: { flex: 1, marginLeft: 14 },
  suggestion: { flexDirection: 'row', alignItems: 'center', marginTop: 6, flexWrap: 'wrap', gap: 6 },
  rowOnly: { flexDirection: 'row' },
  rowGap6: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', flex: 1 },
  gap: { height: 16 },
  mb8: { marginBottom: 8 },
  mb16: { marginBottom: 16 },
  mt16: { marginTop: 16 },
  mv10: { marginVertical: 10 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  editBadge: { position: 'absolute', right: -4, bottom: -4, width: 22, height: 22, borderRadius: 11, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff' },
  inlineBtn: { paddingLeft: 10, minHeight: 44, justifyContent: 'center' },
  addLink: { color: Colors.primary, fontWeight: '700', paddingVertical: 6 },
  fieldCard: { marginBottom: 10, padding: 12 },
  fieldFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  trashBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  glyph: { width: 44, height: 44, borderRadius: 12, borderWidth: 1.5, borderColor: Colors.border, alignItems: 'center', justifyContent: 'center' },
  glyphOn: { borderColor: Colors.primary, backgroundColor: Colors.primarySoft },
  color: { width: 40, height: 40, borderRadius: 20, borderWidth: 3, borderColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  colorOn: { borderColor: Colors.text },
  preview: { width: 64, height: 64, borderRadius: 16, marginTop: 12 },
});
