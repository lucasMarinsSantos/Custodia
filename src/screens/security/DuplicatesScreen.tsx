// Credenciais duplicadas: senhas reutilizadas, contas repetidas (mesmo site e usuário) e senhas parecidas
// Ações: trocar a senha (abre o cadastro) e mesclar contas repetidas (com confirmação).
import React from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Banner, Button, Card, EmptyState, Icon, Screen, Section } from '../../components/ui';
import { ServiceIcon } from '../../components/widgets';
import { Colors, Type } from '../../theme';
import { useVaultData } from '../../context/AppState';
import { Repo } from '../../services/Repository';
import { DuplicateGroup, DuplicateKind, DuplicateService } from '../../services/DuplicateService';
import { toast } from '../../services/events';
import { Credential } from '../../types/models';
import { timeAgo } from '../../utils';

/** Títulos das seções (o primeiro segue o cenário BDD "Senhas Reutilizadas"). */
export const SECTION_TITLES: Record<DuplicateKind, string> = {
  same_password: 'Senhas Reutilizadas',
  same_account: 'Contas repetidas',
  similar_password: 'Senhas parecidas',
};

const HINTS: Record<DuplicateKind, string> = {
  same_password: 'Se um desses serviços vazar, todos os outros ficam expostos. Troque a senha para uma única em cada conta.',
  same_account: 'O mesmo site e usuário cadastrados mais de uma vez. Mescle para ficar com um registro só.',
  similar_password: 'Só os números ou símbolos mudam: quem descobre uma adivinha as outras rápido.',
};

const ORDER: DuplicateKind[] = ['same_password', 'same_account', 'similar_password'];

function ItemRow({ c, onOpen, onChange }: { c: Credential; onOpen: () => void; onChange?: () => void }) {
  return (
    <View style={styles.item}>
      <TouchableOpacity style={styles.itemMain} onPress={onOpen} accessibilityRole="button" accessibilityLabel={`Abrir ${c.title}`}>
        <ServiceIcon credential={c} size={36} />
        <View style={styles.flex}>
          <Text style={Type.bodyStrong} numberOfLines={1}>
            {c.title}
          </Text>
          <Text style={Type.caption} numberOfLines={1}>
            {[c.username, `alterada ${timeAgo(c.passwordChangedAt)}`].filter(Boolean).join(' • ')}
          </Text>
        </View>
      </TouchableOpacity>
      {onChange ? <Button small variant="outline" title="Trocar senha" onPress={onChange} accessibilityHint={`Abre o cadastro de ${c.title}`} /> : null}
    </View>
  );
}

function GroupCard({ g, navigation, onMerge }: { g: DuplicateGroup; navigation: any; onMerge: (g: DuplicateGroup) => void }) {
  const edit = (c: Credential) => () => navigation.navigate('CredentialEdit', { id: c.id });
  return (
    <Card style={styles.group}>
      <View style={styles.groupHead}>
        <Icon name={g.kind === 'same_account' ? 'users' : 'copy'} size={16} color={Colors.orange} />
        <Text style={[Type.small, styles.flex]}>{g.label}</Text>
      </View>
      {g.items.map(c => (
        <ItemRow key={c.id} c={c} onOpen={() => navigation.navigate('CredentialDetail', { id: c.id })} onChange={g.kind === 'same_account' ? undefined : edit(c)} />
      ))}
      {g.kind === 'same_account' ? <Button small icon="git-merge" title="Mesclar" onPress={() => onMerge(g)} style={styles.merge} /> : null}
    </Card>
  );
}

export default function DuplicatesScreen({ navigation }: any) {
  const [groups] = useVaultData(async () => DuplicateService.find(await Repo.credentials()), [] as DuplicateGroup[]);

  const merge = (g: DuplicateGroup) => {
    // Fica o registro alterado por último; os outros completam os campos vazios e são excluídos
    const keep = [...g.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const others = g.items.filter(c => c.id !== keep.id);
    const what = others.length === 1 ? 'o outro registro' : `os outros ${others.length}`;
    Alert.alert('Mesclar contas repetidas', `Manter "${keep.title}" e excluir ${what}? Campos vazios, notas e senhas antigas são aproveitados.`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Mesclar',
        style: 'destructive',
        onPress: () => {
          DuplicateService.merge(
            keep.id,
            others.map(c => c.id),
          )
            .then(() => toast('Contas mescladas', 'success'))
            .catch((e: any) => toast(e?.message || 'Não foi possível mesclar as contas', 'error'));
        },
      },
    ]);
  };

  return (
    <Screen title="Credenciais duplicadas" onBack={() => navigation.goBack()}>
      {groups.length === 0 ? (
        <EmptyState icon="check-circle" title="Nenhuma duplicata" message="Cada conta tem uma senha única e não há cadastros repetidos." />
      ) : (
        ORDER.map(kind => {
          const list = groups.filter(g => g.kind === kind);
          if (!list.length) return null;
          return (
            <Section key={kind} title={SECTION_TITLES[kind]}>
              <Banner tone="warning" text={HINTS[kind]} />
              {list.map(g => (
                <GroupCard key={g.id} g={g} navigation={navigation} onMerge={merge} />
              ))}
            </Section>
          );
        })
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  group: { marginTop: 10 },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  itemMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48 },
  merge: { marginTop: 8, alignSelf: 'flex-start' },
});
