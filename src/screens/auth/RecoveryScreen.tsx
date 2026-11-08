// Recuperação de acesso e restauração de emergência:
// código de recuperação de uso único, frase de 12 palavras ou perguntas de segurança.
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Banner, Button, Chip, Input, Screen } from '../../components/ui';
import { StrengthMeter } from '../../components/widgets';
import { MasterPasswordInput } from '../../components/MasterPasswordInput';
import { Type } from '../../theme';
import { MasterPasswordPolicy, Vault } from '../../services/VaultService';
import { toast } from '../../services/events';

export default function RecoveryScreen({ navigation, route }: any) {
  const [profileId, setProfileId] = useState<string | null>(route.params?.profileId || null);
  const [method, setMethod] = useState<'code' | 'phrase' | 'questions'>('code');
  const [options, setOptions] = useState<{ questions: string[] | null; phrase: boolean }>({ questions: null, phrase: false });
  const [code, setCode] = useState('');
  const [phrase, setPhrase] = useState('');
  const [answers, setAnswers] = useState<string[]>([]);
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secureKeyboard, setSecureKeyboard] = useState(false);
  const [twoFactor, setTwoFactor] = useState(false);
  const [totp, setTotp] = useState('');

  useEffect(() => {
    (async () => {
      const id = profileId || (await Vault.getProfile())?.id;
      if (!id) return;
      setProfileId(id);
      setSecureKeyboard(!!(await Vault.loadSettings(id)).secureKeyboard);
      const o = await Vault.getRecoveryOptions(id);
      setOptions(o);
      setAnswers((o.questions || []).map(() => ''));
      setTwoFactor(await Vault.isTwoFactorEnabled(id));
    })();
  }, [profileId]);

  const submit = async () => {
    setError(null);
    if (!profileId) return;
    const policyError = MasterPasswordPolicy.error(pw);
    if (policyError) return setError(policyError);
    if (pw !== confirm) return setError('As senhas não coincidem');
    setBusy(true);
    try {
      const secret = method === 'code' ? code : method === 'phrase' ? phrase : answers;
      const { newRecoveryCode, dropped } = await Vault.recover(profileId, method, secret as any, pw, twoFactor ? totp : undefined);
      toast(newRecoveryCode ? 'Acesso restaurado. Guarde o NOVO código de recuperação.' : 'Senha mestra redefinida. Reative a biometria em Ajustes.', 'success');
      // Cofre da versão 0.1: frase/perguntas antigas ficaram presas à chave trocada e precisam ser refeitas
      if (dropped.length) toast('A chave do cofre foi trocada. Configure de novo a frase e as perguntas em Ajustes › Opções de recuperação.', 'info');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Recuperar acesso" subtitle="Restauração de emergência do cofre" onBack={() => navigation.goBack()} footer={<Button title="Redefinir senha e entrar" icon="unlock" onPress={submit} loading={busy} />}>
      <View style={styles.methods}>
        <Chip label="Código de recuperação" icon="hash" active={method === 'code'} onPress={() => setMethod('code')} />
        {options.phrase ? <Chip label="Frase" icon="type" active={method === 'phrase'} onPress={() => setMethod('phrase')} /> : null}
        {options.questions ? <Chip label="Perguntas" icon="help-circle" active={method === 'questions'} onPress={() => setMethod('questions')} /> : null}
      </View>

      {method === 'code' ? (
        <>
          <Input label="Código de recuperação" icon="hash" value={code} onChangeText={setCode} autoCapitalize="characters" placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" mono />
          <Text style={[Type.caption, styles.note]}>O código é de uso único: após a restauração, um novo código será gerado.</Text>
        </>
      ) : null}
      {method === 'phrase' ? <Input label="Frase de recuperação (12 palavras)" value={phrase} onChangeText={setPhrase} multiline autoCapitalize="none" placeholder="palavra1 palavra2 …" /> : null}
      {method === 'questions' && options.questions
        ? options.questions.map((q, i) => (
            <Input key={i} label={q} value={answers[i]} secure onChangeText={t => setAnswers(a => a.map((x, j) => (j === i ? t : x)))} placeholder="Resposta" />
          ))
        : null}

      {twoFactor ? (
        <Input label="Código de verificação (2FA) ou código de reserva" icon="smartphone" value={totp} onChangeText={t => setTotp(t.slice(0, 16))} autoCapitalize="characters" mono placeholder="000000" />
      ) : null}

      <Text style={[Type.h3, styles.title]}>Nova senha mestra</Text>
      <MasterPasswordInput label="Nova senha mestra" value={pw} onChange={setPw} secureKeyboard={secureKeyboard} />
      <StrengthMeter password={pw} checkCommon />
      <View style={styles.gap} />
      <MasterPasswordInput label="Confirmar nova senha" value={confirm} onChange={setConfirm} secureKeyboard={secureKeyboard} />
      <Banner tone="info" text="Por segurança, o desbloqueio biométrico é desativado após a redefinição. Falhas repetidas bloqueiam temporariamente novas tentativas." />
      {error ? <Banner tone="danger" icon="alert-circle" text={error} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  methods: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 18 },
  note: { marginTop: -8, marginBottom: 12 },
  title: { marginTop: 8, marginBottom: 12 },
  gap: { height: 14 },
});
