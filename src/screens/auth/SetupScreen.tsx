// Criação do cofre: senha mestra (mín. 12 caracteres) com validação de força em tempo real
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Banner, Button, Chip, Icon, Input, Screen } from '../../components/ui';
import { StrengthMeter } from '../../components/widgets';
import { MasterPasswordInput } from '../../components/MasterPasswordInput';
import { Colors, Type } from '../../theme';
import { MasterPasswordPolicy, Vault } from '../../services/VaultService';
import { toast } from '../../services/events';

const RULES: { key: keyof ReturnType<typeof MasterPasswordPolicy.check>; label: string }[] = [
  { key: 'length', label: 'Mínimo de 12 caracteres' },
  { key: 'upper', label: 'Letra maiúscula' },
  { key: 'lower', label: 'Letra minúscula' },
  { key: 'number', label: 'Número' },
  { key: 'symbol', label: 'Símbolo (!@#…)' },
];

export default function SetupScreen({ navigation }: any) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [hint, setHint] = useState('');
  const [secureKb, setSecureKb] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const checks = MasterPasswordPolicy.check(password);
  const common = MasterPasswordPolicy.isCommon(password);
  const matches = password === confirm && confirm.length > 0;

  const create = async () => {
    setError(null);
    const policyError = MasterPasswordPolicy.error(password);
    if (policyError) return setError(policyError);
    if (password !== confirm) return setError('As senhas não coincidem');
    setBusy(true);
    try {
      await Vault.createVault({ masterPassword: password, hint });
      toast('Cofre criado com sucesso', 'success');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      title="Criar senha mestra"
      subtitle="Ela protege tudo e só você a conhece"
      onBack={navigation.canGoBack() ? () => navigation.goBack() : undefined}
      footer={<Button title="Criar cofre" icon="check" onPress={create} loading={busy} />}
    >
      <View style={styles.kbRow}>
        <Chip label={secureKb ? 'Teclado seguro ativo' : 'Usar teclado seguro'} icon="grid" active={secureKb} onPress={() => setSecureKb(v => !v)} />
      </View>
      <MasterPasswordInput label="Senha mestra" value={password} onChange={setPassword} secureKeyboard={secureKb} placeholder="Nova senha mestra" />
      <StrengthMeter password={password} showFeedback={false} checkCommon />

      <View style={styles.rules}>
        {RULES.map(r => (
          <View key={r.key} style={styles.rule}>
            <Icon name={checks[r.key] ? 'check-circle' : 'circle'} size={16} color={checks[r.key] ? Colors.success : Colors.textTertiary} />
            <Text style={[Type.small, styles.ruleText, { color: checks[r.key] ? Colors.text : Colors.textSecondary }]}>{r.label}</Text>
          </View>
        ))}
        {common ? (
          <View style={styles.rule}>
            <Icon name="x-circle" size={16} color={Colors.danger} />
            <Text style={[Type.small, styles.ruleText, { color: Colors.danger }]}>Senha presente na lista das mais comuns</Text>
          </View>
        ) : null}
      </View>

      <MasterPasswordInput label="Confirmar senha mestra" value={confirm} onChange={setConfirm} secureKeyboard={secureKb} placeholder="Repita a senha" />
      {confirm.length > 0 && !matches ? <Text style={[Type.small, styles.mismatch]}>As senhas não coincidem</Text> : null}

      <Input label="Dica (opcional)" icon="info" value={hint} onChangeText={setHint} placeholder="Algo que só você entende" />
      <Banner tone="warning" title="Guarde bem esta senha" text="O Custódia usa arquitetura zero-knowledge. Na próxima tela você receberá um código de recuperação, que é a forma de restaurar o acesso em uma emergência." />
      {error ? <Banner tone="danger" icon="alert-circle" text={error} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  kbRow: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 6 },
  rules: { marginTop: 14, marginBottom: 18 },
  rule: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  ruleText: { marginLeft: 8 },
  mismatch: { color: Colors.danger, marginTop: -8, marginBottom: 12 },
});
