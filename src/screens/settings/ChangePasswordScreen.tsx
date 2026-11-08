// Alterar senha mestra (política: 12+ caracteres, maiúsculas, minúsculas, números e símbolos)
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Banner, Button, Icon, Screen } from '../../components/ui';
import { MasterPasswordInput } from '../../components/MasterPasswordInput';
import { StrengthMeter } from '../../components/widgets';
import { Colors, Type } from '../../theme';
import { MasterPasswordPolicy, Vault } from '../../services/VaultService';
import { toast } from '../../services/events';

export default function ChangePasswordScreen({ navigation }: any) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const kb = Vault.settings.secureKeyboard;
  const checks = MasterPasswordPolicy.check(next);

  const save = async () => {
    setError(null);
    const policyError = MasterPasswordPolicy.error(next);
    if (policyError) return setError(policyError);
    if (next !== confirm) return setError('As senhas não coincidem');
    if (next === current) return setError('A nova senha deve ser diferente da atual.');
    try {
      await Vault.changeMasterPassword(current, next);
      toast('Senha mestra alterada', 'success');
      navigation.goBack();
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <Screen title="Alterar senha mestra" onBack={() => navigation.goBack()} footer={<Button title="Alterar senha" icon="check" onPress={save} disabled={!current || !MasterPasswordPolicy.isValid(next) || next !== confirm} />}>
      <MasterPasswordInput label="Senha atual" value={current} onChange={setCurrent} secureKeyboard={kb} />
      <MasterPasswordInput label="Nova senha mestra" value={next} onChange={setNext} secureKeyboard={kb} />
      <StrengthMeter password={next} showFeedback={false} checkCommon />
      <View style={styles.rules}>
        {(
          [
            ['length', 'Mínimo de 12 caracteres'],
            ['upper', 'Letra maiúscula'],
            ['lower', 'Letra minúscula'],
            ['number', 'Número'],
            ['symbol', 'Símbolo'],
          ] as const
        ).map(([k, l]) => (
          <View key={k} style={styles.rule}>
            <Icon name={checks[k] ? 'check-circle' : 'circle'} size={15} color={checks[k] ? Colors.success : Colors.textTertiary} />
            <Text style={[Type.small, styles.ruleText]}>{l}</Text>
          </View>
        ))}
      </View>
      <MasterPasswordInput label="Confirmar nova senha" value={confirm} onChange={setConfirm} secureKeyboard={kb} />
      <Banner tone="info" text="A chave do banco (DEK) não muda: apenas o envelope protegido pela senha mestra é recriado. Códigos de recuperação continuam válidos." />
      {error ? <Banner tone="danger" text={error} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  rules: { marginVertical: 14 },
  rule: { flexDirection: 'row', alignItems: 'center', marginBottom: 5 },
  ruleText: { marginLeft: 8 },
});
