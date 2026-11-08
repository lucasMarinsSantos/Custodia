// Regras de segurança da pasta: editor com herança para as subpastas
// O que vem das pastas acima aparece ligado e travado ("Herdada"); a pasta só pode endurecer as regras herdadas.
// Alterar uma pasta que já tem regras pede a senha mestra (senão bastaria desligar a regra para ver a senha).
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Banner, Button, Chip, Input, ListCard, Screen, Section, ToggleRow } from '../../components/ui';
import { Type } from '../../theme';
import { useVaultData } from '../../context/AppState';
import { Repo } from '../../services/Repository';
import { PolicyService } from '../../services/PolicyService';
import { FolderRulesService, POLICY_LIMITS } from '../../services/FolderRulesService';
import { useReauth } from '../../components/ReauthPrompt';
import { toast } from '../../services/events';
import { DefaultFolderPolicy, Folder, FolderPolicy, PasswordStrength, StrengthLabels } from '../../types/models';

const STRENGTH_CHOICES: PasswordStrength[] = ['weak', 'medium', 'strong', 'very_strong'];
const INHERITED = 'Herdada de uma pasta acima';

type Draft = Omit<FolderPolicy, 'maxAgeDays' | 'clipboardSeconds'> & { maxAgeDays: string; clipboardSeconds: string };

const toDraft = (p: FolderPolicy): Draft => ({ ...p, maxAgeDays: p.maxAgeDays ? String(p.maxAgeDays) : '', clipboardSeconds: p.clipboardSeconds ? String(p.clipboardSeconds) : '' });

export default function FolderRulesScreen({ navigation, route }: any) {
  const folderId: string = route.params?.folderId;
  const [folders] = useVaultData(() => Repo.folders(), [] as Folder[]);
  const folder = folders.find(f => f.id === folderId);
  const inherited = useMemo(() => FolderRulesService.inherited(folders, folderId), [folders, folderId]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const reauth = useReauth();

  useEffect(() => {
    if (folder && !draft) setDraft(toDraft({ ...DefaultFolderPolicy, ...folder.policy }));
  }, [folder, draft]);

  if (!folder || !draft) {
    return (
      <Screen title="Regras da pasta" onBack={() => navigation.goBack()}>
        <Banner tone="info" text="Carregando a pasta…" />
      </Screen>
    );
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(d => (d ? { ...d, [key]: value } : d));

  const save = async () => {
    setBusy(true);
    try {
      const hadRules = !PolicyService.isEmpty(PolicyService.effective(folders, folderId));
      if (hadRules && !(await reauth.ensure())) return;
      await FolderRulesService.save(folderId, draft);
      toast('Regras da pasta salvas', 'success');
      navigation.goBack();
    } catch (e: any) {
      toast(e?.message || 'Não foi possível salvar as regras.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const flag = (key: 'requireReauth' | 'blockAutofill' | 'blockExport', icon: string, title: string, subtitle: string, last = false) => (
    <ToggleRow
      icon={icon}
      title={title}
      subtitle={inherited[key] ? INHERITED : subtitle}
      value={inherited[key] || draft[key]}
      onChange={v => set(key, v)}
      disabled={inherited[key]}
      last={last}
    />
  );

  return (
    <Screen title="Regras da pasta" subtitle={Repo.folderPath(folders, folderId)} onBack={() => navigation.goBack()} footer={<Button title="Salvar regras" icon="check" onPress={save} loading={busy} />}>
      <Banner tone="info" icon="git-branch" text="As regras valem para esta pasta e para todas as subpastas. Quando uma pasta acima também tem a regra, vale a mais rígida." />
      {!PolicyService.isEmpty(inherited) ? <Banner tone="warning" icon="shield" title="Regras herdadas" text={FolderRulesService.describe(inherited).join(' · ')} /> : null}

      <Section title="Acesso">
        <ListCard>
          {flag('requireReauth', 'lock', 'Reautenticar para ver/copiar', 'Pede a senha mestra ou a biometria antes de mostrar ou copiar a senha')}
          {flag('blockAutofill', 'edit-3', 'Bloquear preenchimento automático', 'As senhas desta pasta não são preenchidas em outros apps')}
          {flag('blockExport', 'upload', 'Bloquear exportação', 'As credenciais desta pasta ficam fora da exportação', true)}
        </ListCard>
      </Section>

      <Section title="Força mínima da senha">
        <View style={styles.wrap}>
          <Chip label="Sem exigência" active={!draft.minStrength} onPress={() => set('minStrength', null)} />
          {STRENGTH_CHOICES.map(s => (
            <Chip key={s} label={StrengthLabels[s]} active={draft.minStrength === s} onPress={() => set('minStrength', s)} />
          ))}
        </View>
        {inherited.minStrength ? <Text style={[Type.caption, styles.note]}>{`${INHERITED}: no mínimo ${StrengthLabels[inherited.minStrength]}.`}</Text> : null}
      </Section>

      <Section title="Prazos">
        <Input
          label="Prazo máximo da senha (dias)"
          icon="calendar"
          value={draft.maxAgeDays}
          onChangeText={t => set('maxAgeDays', t.replace(/\D/g, '').slice(0, 4))}
          keyboardType="number-pad"
          placeholder={inherited.maxAgeDays ? `Herdado: ${inherited.maxAgeDays}` : 'Sem prazo'}
          hint={`Entre ${POLICY_LIMITS.maxAgeDays.min} e ${POLICY_LIMITS.maxAgeDays.max} dias`}
        />
        <Input
          label="Limpar a área de transferência após (segundos)"
          icon="clipboard"
          value={draft.clipboardSeconds}
          onChangeText={t => set('clipboardSeconds', t.replace(/\D/g, '').slice(0, 3))}
          keyboardType="number-pad"
          placeholder={inherited.clipboardSeconds ? `Herdado: ${inherited.clipboardSeconds}` : 'Igual aos Ajustes'}
          hint={`Entre ${POLICY_LIMITS.clipboardSeconds.min} e ${POLICY_LIMITS.clipboardSeconds.max} segundos; nunca passa do tempo dos Ajustes`}
        />
      </Section>
      {reauth.element}
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  note: { marginTop: 8 },
});
