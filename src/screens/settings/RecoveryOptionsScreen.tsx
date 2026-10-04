// Opções de recuperação: novo código, frase e perguntas de segurança (cifradas localmente)
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Banner, Button, Card, Input, Screen, Section } from '../../components/ui';
import { MasterPasswordInput } from '../../components/MasterPasswordInput';
import { Colors, Type } from '../../theme';
import { Vault } from '../../services/VaultService';
import { ClipboardService } from '../../services/ClipboardService';
import { toast } from '../../services/events';

export default function RecoveryOptionsScreen({ navigation }: any) {
  const [verified, setVerified] = useState(false);
  const [pw, setPw] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [phrase, setPhrase] = useState<string | null>(null);
  const [opts, setOpts] = useState<{ questions: string[] | null; phrase: boolean }>({ questions: null, phrase: false });
  const [qs, setQs] = useState([
    { question: '', answer: '' },
    { question: '', answer: '' },
    { question: '', answer: '' },
  ]);

  useEffect(() => {
    if (Vault.currentProfile) Vault.getRecoveryOptions(Vault.currentProfile.id).then(o => {
      setOpts(o);
      if (o.questions) setQs(o.questions.map(q => ({ question: q, answer: '' })));
    });
  }, [verified]);

  if (!verified) {
    return (
      <Screen title="Opções de recuperação" onBack={() => navigation.goBack()}>
        <Text style={[Type.body, styles.intro]}>Confirme sua senha mestra para alterar os métodos de recuperação.</Text>
        <MasterPasswordInput label="Senha mestra" value={pw} onChange={setPw} secureKeyboard={Vault.settings.secureKeyboard} />
        <Button title="Confirmar" disabled={!pw} onPress={async () => ((await Vault.verifyCurrentPassword(pw)) ? setVerified(true) : toast('Senha mestra incorreta.', 'error'))} />
      </Screen>
    );
  }

  return (
    <Screen title="Opções de recuperação" onBack={() => navigation.goBack()}>
      <Section title="Código de recuperação (restauração de emergência)">
        <Card>
          <Text style={Type.small}>Gerar um novo código invalida o anterior. Imprima e guarde em local seguro.</Text>
          {code ? (
            <Text selectable style={[Type.monoLarge, styles.code]}>
              {code}
            </Text>
          ) : null}
          <View style={styles.codeActions}>
            <Button small variant="secondary" icon="refresh-cw" title="Gerar novo código" onPress={async () => setCode(await Vault.regenerateRecoveryCode())} />
            {code ? <Button small variant="outline" icon="copy" title="Copiar" onPress={() => ClipboardService.copy(code, 'Código')} /> : null}
          </View>
        </Card>
      </Section>

      <Section title={`Frase de recuperação ${opts.phrase ? '(configurada)' : ''}`}>
        <Card>
          {phrase ? (
            <Text selectable style={[Type.bodyStrong, styles.phrase]}>
              {phrase}
            </Text>
          ) : null}
          <Button small variant="secondary" icon="type" title={opts.phrase ? 'Gerar nova frase' : 'Gerar frase'} onPress={async () => setPhrase(await Vault.setRecoveryPhrase())} />
        </Card>
      </Section>

      <Section title={`Perguntas de segurança ${opts.questions ? '(configuradas)' : ''}`}>
        {qs.map((q, i) => (
          <View key={i}>
            <Input label={`Pergunta ${i + 1}`} value={q.question} onChangeText={t => setQs(p => p.map((x, j) => (j === i ? { ...x, question: t } : x)))} placeholder="Escreva sua pergunta" />
            <Input placeholder="Resposta" secure value={q.answer} onChangeText={t => setQs(p => p.map((x, j) => (j === i ? { ...x, answer: t } : x)))} />
          </View>
        ))}
        <Button
          icon="save"
          title="Salvar perguntas"
          onPress={async () => {
            try {
              await Vault.setSecurityQuestions(qs.filter(q => q.question.trim()));
              toast('Perguntas salvas (cifradas localmente, sem envio a servidores)', 'success');
            } catch (e: any) {
              toast(e.message, 'error');
            }
          }}
        />
      </Section>
      <Banner tone="info" text="Todas as opções envelopam a chave do cofre localmente com PBKDF2 + AES-256-GCM. Nada é enviado a servidores." />
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { marginBottom: 14 },
  code: { marginVertical: 12, color: Colors.primary, fontSize: 18 },
  codeActions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  phrase: { color: Colors.primaryDark, marginBottom: 10 },
});
