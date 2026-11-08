// Perfis: pessoal e profissional, cada um com banco, chaves, biometria e ajustes próprios
// Trocar bloqueia o perfil atual (a chave dele sai da memória) e abre a tela de login do outro.
// Excluir exige a senha mestra do perfil (e o código 2FA, se ativo) e apaga o banco com secure_delete.
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { Badge, Banner, Button, Chip, Input, ListCard, Row, Screen, Section, Sheet } from '../../components/ui';
import { MasterPasswordInput } from '../../components/MasterPasswordInput';
import { StrengthMeter } from '../../components/widgets';
import { Colors, Type } from '../../theme';
import { MAX_PROFILES, MasterPasswordPolicy, PROFILE_NAME_MAX, Vault } from '../../services/VaultService';
import { bus, Events, toast } from '../../services/events';
import { Profile, ProfileType } from '../../types/models';

export const PROFILE_TYPE_LABEL: Record<ProfileType, string> = { personal: 'Pessoal', professional: 'Profissional' };

function TypeChips({ value, onChange }: { value: ProfileType; onChange: (t: ProfileType) => void }) {
  return (
    <View style={styles.wrap}>
      <Chip label="Pessoal" icon="home" active={value === 'personal'} onPress={() => onChange('personal')} />
      <Chip label="Profissional" icon="briefcase" active={value === 'professional'} onPress={() => onChange('professional')} />
    </View>
  );
}

function NewProfileSheet({ onClose }: { onClose: () => void }) {
  const [type, setType] = useState<ProfileType>('professional');
  const [name, setName] = useState('Profissional');
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    const err = MasterPasswordPolicy.error(pw);
    if (err) return toast(err, 'error');
    if (pw !== confirm) return toast('As senhas não coincidem', 'error');
    setBusy(true);
    try {
      // Fecha o perfil atual e abre o novo; em seguida aparece a tela do código de recuperação dele
      await Vault.createProfile({ name, type, masterPassword: pw });
      toast(`Perfil "${name.trim()}" criado`, 'success');
    } catch (e: any) {
      setBusy(false);
      toast(e?.message || 'Não foi possível criar o perfil.', 'error');
    }
  };

  return (
    <Sheet visible onClose={onClose} title="Novo perfil">
      <TypeChips
        value={type}
        onChange={t => {
          setType(t);
          if (name === PROFILE_TYPE_LABEL[type]) setName(PROFILE_TYPE_LABEL[t]);
        }}
      />
      <Input label="Nome do perfil" value={name} onChangeText={setName} maxLength={PROFILE_NAME_MAX} />
      <Text style={[Type.small, styles.mb8]}>Cada perfil é um cofre separado, com a sua própria senha mestra, banco cifrado e biometria.</Text>
      <MasterPasswordInput label="Senha mestra do novo perfil" value={pw} onChange={setPw} secureKeyboard={!!Vault.settings.secureKeyboard} />
      <StrengthMeter password={pw} checkCommon />
      <View style={styles.gap} />
      <MasterPasswordInput label="Confirmar senha mestra" value={confirm} onChange={setConfirm} secureKeyboard={!!Vault.settings.secureKeyboard} />
      <View style={styles.gap} />
      <Button title="Criar perfil" icon="user-plus" onPress={create} loading={busy} disabled={!name.trim() || !pw} />
    </Sheet>
  );
}

function ManageSheet({ profile, current, onClose }: { profile: Profile; current: boolean; onClose: () => void }) {
  const [name, setName] = useState(profile.name);
  const [type, setType] = useState<ProfileType>(profile.type || 'personal');
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [twoFactor, setTwoFactor] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Vault.isTwoFactorEnabled(profile.id).then(setTwoFactor).catch(() => setTwoFactor(false));
  }, [profile.id]);

  const rename = async () => {
    try {
      await Vault.renameProfile(profile.id, { name, type });
      toast('Perfil atualizado', 'success');
      onClose();
    } catch (e: any) {
      toast(e?.message || 'Não foi possível renomear.', 'error');
    }
  };

  const switchTo = async () => {
    try {
      onClose();
      await Vault.switchProfile(profile.id);
    } catch (e: any) {
      toast(e?.message || 'Não foi possível trocar de perfil.', 'error');
    }
  };

  const doDelete = async () => {
    setBusy(true);
    try {
      await Vault.deleteProfile(profile.id, pw, twoFactor ? code : undefined);
      toast(`Perfil "${profile.name}" excluído`, 'success');
      onClose();
    } catch (e: any) {
      toast(e?.message || 'Não foi possível excluir o perfil.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const askDelete = () =>
    Alert.alert('Excluir perfil', `"${profile.name}" e todas as credenciais dele serão apagados deste aparelho. Isso não pode ser desfeito.`, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Excluir', style: 'destructive', onPress: doDelete },
    ]);

  return (
    <Sheet visible onClose={onClose} title={profile.name}>
      {!current ? <Button title={`Trocar para "${profile.name}"`} icon="repeat" onPress={switchTo} /> : <Badge text="Perfil em uso" icon="check" />}
      <Section title="Renomear" style={styles.mt14}>
        <Input label="Nome do perfil" value={name} onChangeText={setName} maxLength={PROFILE_NAME_MAX} />
        <TypeChips value={type} onChange={setType} />
        <View style={styles.gap} />
        <Button small variant="secondary" icon="edit-2" title="Salvar nome" onPress={rename} disabled={!name.trim()} />
      </Section>
      <Section title="Excluir perfil">
        <Text style={[Type.small, styles.mb8]}>Para excluir, digite a senha mestra deste perfil.</Text>
        <MasterPasswordInput label={`Senha mestra de "${profile.name}"`} value={pw} onChange={setPw} secureKeyboard={!!Vault.settings.secureKeyboard} />
        {twoFactor ? <Input label="Código de verificação (2FA)" icon="hash" value={code} onChangeText={t => setCode(t.slice(0, 16))} mono autoCapitalize="characters" /> : null}
        <View style={styles.gap} />
        <Button title="Excluir perfil" variant="danger" icon="trash-2" onPress={askDelete} loading={busy} disabled={!pw || (twoFactor && !code.trim())} />
      </Section>
    </Sheet>
  );
}

export default function ProfilesScreen({ navigation }: any) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [managing, setManaging] = useState<Profile | null>(null);
  const [creating, setCreating] = useState(false);
  const currentId = Vault.currentProfile?.id;

  const load = useCallback(async () => {
    try {
      setProfiles(await Vault.listProfiles());
    } catch (e: any) {
      toast(e?.message || 'Não foi possível ler os perfis.', 'error');
    }
  }, []);
  useEffect(() => {
    load();
    return bus.on(Events.PROFILES_CHANGED, load);
  }, [load]);

  return (
    <Screen title="Perfis" subtitle="Separe as senhas pessoais das profissionais" onBack={() => navigation.goBack()}>
      <Banner tone="info" icon="layers" text="Cada perfil tem banco cifrado, chaves, biometria e ajustes próprios. Trocar de perfil bloqueia o atual e abre a tela de login do outro." />
      <ListCard>
        {profiles.map((p, i) => (
          <Row
            key={p.id}
            icon={p.type === 'professional' ? 'briefcase' : 'home'}
            iconColor={p.color}
            title={`Perfil ${p.name}`}
            subtitle={`${PROFILE_TYPE_LABEL[p.type || 'personal']}${p.id === currentId ? ' • em uso' : ''}`}
            onPress={() => setManaging(p)}
            chevron
            last={i === profiles.length - 1}
          />
        ))}
      </ListCard>
      <View style={styles.gap} />
      {profiles.length < MAX_PROFILES ? <Button title="Novo perfil" icon="user-plus" variant="outline" onPress={() => setCreating(true)} /> : <Text style={Type.small}>{`Limite de ${MAX_PROFILES} perfis.`}</Text>}
      {managing ? <ManageSheet profile={managing} current={managing.id === currentId} onClose={() => setManaging(null)} /> : null}
      {creating ? <NewProfileSheet onClose={() => setCreating(false)} /> : null}
      <Text style={[Type.caption, styles.note, { color: Colors.textTertiary }]}>As credenciais de um perfil não aparecem no outro.</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  gap: { height: 12 },
  mb8: { marginBottom: 8 },
  mt14: { marginTop: 14 },
  note: { textAlign: 'center', marginTop: 16 },
});
