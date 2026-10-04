// Sobre, verificação de integridade do banco e proteção do dispositivo
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  Badge,
  Banner,
  Button,
  Card,
  KeyValue,
  Screen,
  Section,
} from '../../components/ui';
import { Colors, Type } from '../../theme';
import { IntegrityService } from '../../services/IntegrityService';
import { Security } from '../../native';
import { vaultDb } from '../../db/Database';
import { formatDate } from '../../utils';
import { toast } from '../../services/events';

const LICENSES = [
  'React Native (MIT)',
  'React Navigation (MIT)',
  '@op-engineering/op-sqlite + SQLCipher (MIT / BSD)',
  '@noble/ciphers, @noble/hashes (MIT)',
  'react-native-vector-icons / Feather (MIT)',
  'SecLists, 10k senhas comuns (MIT)',
];

export default function AboutScreen({ navigation }: any) {
  const [integrity, setIntegrity] = useState<any>(null);
  const [hw, setHw] = useState<boolean | null>(null);

  useEffect(() => {
    IntegrityService.lastResult().then(setIntegrity);
    Security.isHardwareBacked()
      .then(setHw)
      .catch(() => setHw(false));
  }, []);

  return (
    <Screen title="Sobre" onBack={() => navigation.goBack()}>
      <Card style={styles.headCard}>
        <Text style={Type.h1}>Custódia</Text>
        <Text style={Type.small}>
          Gerenciador de senhas seguro • v0.1.0
        </Text>
        <Text style={[Type.caption, styles.author]}>
          Lucas Gabriel Marins dos Santos • Dispositivos Móveis
        </Text>
      </Card>

      <Section title="Integridade do banco de dados">
        <IntegrityCard integrity={integrity} onChecked={setIntegrity} />
      </Section>

      <Section title="Proteção do dispositivo">
        <Card>
          <KeyValue label="Banco local" value="SQLCipher (AES-256)" />
          <KeyValue
            label="Chave do banco"
            value="DEK aleatória envelopada (PBKDF2-SHA256 310k)"
          />
          <KeyValue label="Android Keystore" value={keystoreLabel(hw)} />
          <KeyValue
            label="Arquivo"
            value={vaultDb.getPath() ? 'custodia_<perfil>.sqlite' : '—'}
          />
        </Card>
      </Section>

      <Section title="Licenças de código aberto">
        <Card>
          {LICENSES.map(l => (
            <Text key={l} style={[Type.small, styles.license]}>
              • {l}
            </Text>
          ))}
        </Card>
      </Section>
      <Banner
        tone="info"
        text="Tudo fica no aparelho: nenhuma senha, chave ou dado do cofre sai dele. A única conexão de rede é para baixar o logo público dos sites cadastrados (só o domínio é enviado ao serviço de ícones)."
      />
    </Screen>
  );
}

function keystoreLabel(hw: boolean | null): string {
  if (hw === null) return '…';
  return hw ? 'Protegido por hardware (TEE/StrongBox)' : 'Software';
}

const FILE_STATUS: Record<string, string> = {
  ok: 'confere',
  mismatch: 'alterado',
};

function IntegrityCard({
  integrity,
  onChecked,
}: {
  integrity: any;
  onChecked: (r: any) => void;
}) {
  const ok = !!integrity?.ok;
  return (
    <Card>
      {integrity ? (
        <>
          <View style={styles.badgeRow}>
            <Badge
              text={ok ? 'Íntegro' : 'Falha'}
              color={ok ? Colors.success : Colors.danger}
              bg={ok ? Colors.successBg : Colors.dangerBg}
              icon={ok ? 'check-circle' : 'alert-octagon'}
            />
          </View>
          <Text style={Type.small}>{integrity.message}</Text>
          <KeyValue
            label="Verificado em"
            value={formatDate(integrity.at, true)}
          />
          <KeyValue
            label="Hash do arquivo cifrado"
            value={FILE_STATUS[integrity.fileStatus] || 'sem registro'}
          />
        </>
      ) : (
        <Text style={Type.small}>Ainda não verificado.</Text>
      )}
      <Button
        small
        variant="secondary"
        icon="check-square"
        title="Verificar agora"
        style={styles.checkBtn}
        onPress={async () => {
          const r = await IntegrityService.checkAfterUnlock();
          await IntegrityService.flush();
          onChecked(await IntegrityService.lastResult());
          toast(r.message, r.ok ? 'success' : 'error');
        }}
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  headCard: { alignItems: 'center', marginBottom: 16 },
  author: { marginTop: 6 },
  badgeRow: { flexDirection: 'row', marginBottom: 8 },
  checkBtn: { marginTop: 10 },
  license: { paddingVertical: 3 },
});
