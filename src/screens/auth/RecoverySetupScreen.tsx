// Onboarding: código de recuperação (restauração de emergência), frase/perguntas opcionais e biometria
import React, { useEffect, useState } from 'react';
import { Alert, BackHandler, StyleSheet, Text, View } from 'react-native';
import {
  Banner,
  Button,
  Card,
  Input,
  ListCard,
  Screen,
  Section,
  ToggleRow,
} from '../../components/ui';
import { Colors, Type } from '../../theme';
import { useApp } from '../../context/AppState';
import { Vault } from '../../services/VaultService';
import { ClipboardService } from '../../services/ClipboardService';
import { Security, System } from '../../native';
import { formatDate } from '../../utils';
import { toB64, utf8 } from '../../crypto';
import { toast } from '../../services/events';
import { SessionService } from '../../services/SessionService';

export default function RecoverySetupScreen({ navigation }: any) {
  const { recoveryCode, setRecoveryCode } = useApp();
  const [code] = useState(recoveryCode || '');
  const [phrase, setPhrase] = useState<string | null>(null);
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bio, setBio] = useState(false);
  const [showQuestions, setShowQuestions] = useState(false);
  const [qs, setQs] = useState([
    {
      question: 'Qual o nome do seu primeiro animal de estimação?',
      answer: '',
    },
    { question: 'Em que cidade seus pais se conheceram?', answer: '' },
    {
      question: 'Qual era o apelido do seu melhor amigo de infância?',
      answer: '',
    },
  ]);
  const [qsSaved, setQsSaved] = useState(false);

  useEffect(() => {
    Security.biometricAvailable()
      .then(r => setBioAvailable(r.available))
      .catch(() => {});
  }, []);

  // O código de recuperação aparece uma única vez: enquanto esta tela estiver aberta o cofre não bloqueia por
  // inatividade (dá tempo de anotar) e o botão "voltar" do Android pede confirmação em vez de fechar o app.
  useEffect(() => {
    SessionService.holdInactivity(true);
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      Alert.alert(
        'Já guardou o código?',
        'O código de recuperação não será exibido de novo. Toque em "Concluir" quando terminar.',
        [{ text: 'Continuar aqui' }],
      );
      return true;
    });
    return () => {
      SessionService.holdInactivity(false);
      sub.remove();
    };
  }, []);

  const saveFile = async () => {
    const phraseBlock = phrase
      ? '\nFrase de recuperação:\n' + phrase + '\n'
      : '';
    const text = `CUSTÓDIA - CÓDIGO DE RECUPERAÇÃO\nGerado em: ${formatDate(
      new Date().toISOString(),
      true,
    )}\n\n${code}\n${phraseBlock}\nGuarde este arquivo impresso ou offline em local seguro.\n`;
    const ok = await System.saveFile(
      'custodia-codigo-recuperacao.txt',
      'text/plain',
      toB64(utf8(text)),
    );
    if (ok)
      toast('Arquivo salvo. Imprima e apague a cópia digital.', 'success');
  };

  const toggleBio = async (v: boolean) => {
    try {
      if (v) await Vault.enableBiometric();
      else await Vault.disableBiometric();
      setBio(v);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const saveQuestions = async () => {
    try {
      await Vault.setSecurityQuestions(qs);
      setQsSaved(true);
      toast('Perguntas de segurança salvas (cifradas localmente)', 'success');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const finish = () => {
    setRecoveryCode(null);
    navigation.reset({ index: 0, routes: [{ name: 'Main' }] });
  };

  return (
    <Screen
      title="Proteja seu acesso"
      subtitle="Etapa final da configuração"
      large
      footer={<Button title="Concluir" icon="check" onPress={finish} />}
    >
      <Card style={styles.codeCard}>
        <Text style={[Type.label, styles.codeLabel]}>
          Código de recuperação
        </Text>
        <Text selectable style={styles.code}>
          {code.split('-').slice(0, 3).join('-')}
          {'\n'}
          {code.split('-').slice(3).join('-')}
        </Text>
        <Text style={[Type.small, styles.codeHint]}>
          Permite redefinir a senha mestra em uma emergência. Imprima ou anote e
          guarde em local seguro.
        </Text>
        <View style={styles.codeActions}>
          <Button
            small
            variant="secondary"
            icon="copy"
            title="Copiar"
            onPress={() => ClipboardService.copy(code, 'Código')}
          />
          <Button
            small
            variant="secondary"
            icon="download"
            title="Salvar arquivo"
            onPress={saveFile}
          />
        </View>
      </Card>

      <Section title="Opções adicionais de recuperação">
        <Card style={styles.mb12}>
          <Text style={Type.bodyStrong}>Frase de recuperação</Text>
          <Text style={[Type.small, styles.cardText]}>
            12 palavras cifradas e armazenadas apenas no aparelho.
          </Text>
          {phrase ? (
            <View style={styles.words}>
              {phrase.split(' ').map((w, i) => (
                <View key={i} style={styles.word}>
                  <Text style={styles.wordText}>
                    {i + 1}. {w}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
          <Button
            small
            variant={phrase ? 'outline' : 'secondary'}
            icon="refresh-cw"
            title={phrase ? 'Gerar outra frase' : 'Gerar frase'}
            onPress={async () => setPhrase(await Vault.setRecoveryPhrase())}
          />
        </Card>

        <Card>
          <Text style={Type.bodyStrong}>Perguntas de segurança</Text>
          <Text style={[Type.small, styles.cardText]}>
            Personalize perguntas e respostas. Todas as respostas serão
            exigidas.
          </Text>
          {showQuestions ? (
            <>
              {qs.map((q, i) => (
                <View key={i}>
                  <Input
                    label={`Pergunta ${i + 1}`}
                    value={q.question}
                    onChangeText={t => {
                      setQsSaved(false);
                      setQs(prev =>
                        prev.map((p, j) =>
                          j === i ? { ...p, question: t } : p,
                        ),
                      );
                    }}
                  />
                  <Input
                    placeholder="Resposta"
                    value={q.answer}
                    secure
                    onChangeText={t => {
                      setQsSaved(false);
                      setQs(prev =>
                        prev.map((p, j) => (j === i ? { ...p, answer: t } : p)),
                      );
                    }}
                  />
                </View>
              ))}
              <Button
                small
                icon="save"
                title={qsSaved ? 'Salvas ✓' : 'Salvar perguntas'}
                onPress={saveQuestions}
              />
            </>
          ) : (
            <Button
              small
              variant="secondary"
              icon="help-circle"
              title="Definir perguntas"
              onPress={() => setShowQuestions(true)}
            />
          )}
        </Card>
      </Section>

      {bioAvailable ? (
        <ListCard style={styles.bioCard}>
          <ToggleRow
            icon="aperture"
            title="Desbloqueio biométrico"
            subtitle="Digital ou reconhecimento facial"
            value={bio}
            onChange={toggleBio}
            last
          />
        </ListCard>
      ) : (
        <Banner
          tone="info"
          text="Biometria não disponível ou não cadastrada neste aparelho. Você pode ativá-la depois em Ajustes."
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  codeCard: {
    alignItems: 'center',
    marginBottom: 16,
    backgroundColor: Colors.navy,
    borderColor: Colors.navy,
  },
  codeLabel: { color: '#5EEAD4' },
  code: {
    fontFamily: 'monospace',
    fontSize: 20,
    fontWeight: '800',
    color: '#fff',
    letterSpacing: 1.5,
    textAlign: 'center',
    marginVertical: 14,
    lineHeight: 32,
  },
  codeHint: { color: '#CBD5E1', textAlign: 'center' },
  codeActions: { flexDirection: 'row', gap: 10, marginTop: 16 },
  mb12: { marginBottom: 12 },
  words: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  word: {
    backgroundColor: Colors.primarySoft,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  wordText: { color: Colors.primaryDark, fontWeight: '700' },
  cardText: { marginTop: 4, marginBottom: 12 },
  bioCard: { marginBottom: 16 },
});
