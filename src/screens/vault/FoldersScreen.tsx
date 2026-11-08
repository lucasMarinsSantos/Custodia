// Pastas e subpastas
import React, { useState } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Button, Chip, EmptyState, Fab, Icon, Input, ListCard, Screen, Sheet } from '../../components/ui';
import { Colors, Type } from '../../theme';
import { useVaultData } from '../../context/AppState';
import { LIMITS, newFolder, Repo } from '../../services/Repository';
import { Vault } from '../../services/VaultService';
import { Credential, Folder } from '../../types/models';
import { toast } from '../../services/events';
import { PolicyService } from '../../services/PolicyService';
import { useReauth } from '../../components/ReauthPrompt';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export default function FoldersScreen({ navigation }: any) {
  const [data] = useVaultData(async () => ({ folders: await Repo.folders(), creds: await Repo.credentials() }), { folders: [] as Folder[], creds: [] as Credential[] });
  const [editing, setEditing] = useState<Folder | null>(null);
  const reauth = useReauth();

  const tree: { folder: Folder; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    data.folders
      .filter(f => f.parentId === parent)
      .forEach(f => {
        tree.push({ folder: f, depth });
        if (depth < 32) walk(f.id, depth + 1); // proteção contra dados corrompidos (ciclos)
      });
  };
  walk(null, 0);

  const count = (id: string) => Repo.countInFolder(data.folders, data.creds, id);

  const save = async () => {
    if (!editing) return;
    try {
      const isNewFolder = !data.folders.find(f => f.id === editing.id);
      // Tirar uma pasta de dentro de outra com regras de segurança afrouxa as regras: pede a senha
      const before = data.folders.find(f => f.id === editing.id);
      const loosens = !!before && before.parentId !== editing.parentId && !PolicyService.isEmpty(PolicyService.effective(data.folders, before.parentId));
      if (loosens && !(await reauth.ensure())) return;
      await Repo.saveFolder(editing);
      toast(isNewFolder ? `Pasta "${editing.name.trim()}" criada` : 'Pasta atualizada', 'success');
      setEditing(null);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const doDelete = async (folder: Folder, mode: 'move' | 'delete') => {
    // O diálogo do Android sobrevive ao bloqueio do cofre: só age se a sessão ainda estiver aberta
    if (!Vault.isUnlocked) return;
    try {
      await Repo.deleteFolder(folder.id, mode);
      setEditing(null);
      toast(mode === 'delete' ? 'Pasta e credenciais excluídas' : 'Pasta excluída, credenciais movidas para a raiz', 'success');
    } catch (e: any) {
      toast(e?.message || 'Não foi possível excluir a pasta.', 'error');
    }
  };

  const remove = () => {
    if (!editing) return;
    const folder = editing;
    const n = count(folder.id);
    const subs = Repo.descendantIds(data.folders, folder.id).length - 1;
    if (n === 0) {
      const subsText = subs ? ' e ' + plural(subs, 'subpasta', 'subpastas') : '';
      Alert.alert('Excluir pasta', `Excluir "${folder.name}"${subsText}?`, [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Excluir', style: 'destructive', onPress: () => doDelete(folder, 'move') },
      ]);
      return;
    }
    // Cenário BDD: pasta com credenciais → mover para a raiz ou excluir também
    const subText = subs ? ` As ${plural(subs, 'subpasta', 'subpastas')} também ${subs === 1 ? 'será excluída' : 'serão excluídas'}.` : '';
    Alert.alert('Excluir pasta com credenciais', `"${folder.name}" possui ${plural(n, 'credencial', 'credenciais')}.${subText} O que deseja fazer com as credenciais?`, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Excluir também', style: 'destructive', onPress: () => doDelete(folder, 'delete') },
      { text: 'Mover para a raiz', onPress: () => doDelete(folder, 'move') },
    ]);
  };

  const isNew = editing && !data.folders.find(f => f.id === editing.id);

  return (
    <View style={styles.flex}>
      <Screen title="Pastas" subtitle="Organize suas credenciais em pastas e subpastas" onBack={() => navigation.goBack()}>
        {tree.length === 0 ? (
          <EmptyState icon="folder" title="Nenhuma pasta" message="Crie pastas como Pessoal, Trabalho e Finanças. Na lista principal, segure e arraste credenciais para reorganizar." />
        ) : (
          <ListCard>
            {tree.map(({ folder: f, depth }, i) => (
              <TouchableOpacity key={f.id} onPress={() => setEditing({ ...f })} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={`Pasta ${f.name}, ${count(f.id)} credenciais`} accessibilityHint="Editar pasta">
                <View style={[styles.item, i < tree.length - 1 && styles.itemBorder, { paddingLeft: 16 + depth * 22 }]}>
                  {depth > 0 ? <Icon name="corner-down-right" size={14} color={Colors.textTertiary} style={styles.mr6} /> : null}
                  <View style={[styles.folderIcon, { backgroundColor: f.color + '22' }]}>
                    <Icon name="folder" size={17} color={f.color} />
                  </View>
                  <View style={styles.flex}>
                    <Text style={Type.bodyStrong}>{f.name}</Text>
                    {!PolicyService.isEmpty(f.policy) ? <Text style={Type.caption}>Com regras de segurança</Text> : null}
                    <Text style={Type.caption}>
                      {count(f.id)} {count(f.id) === 1 ? 'credencial' : 'credenciais'}
                    </Text>
                  </View>
                  {!PolicyService.isEmpty(f.policy) ? <Icon name="shield" size={16} color={Colors.primary} style={styles.ml8} /> : null}
                  <Icon name="chevron-right" size={18} color={Colors.textTertiary} style={styles.ml8} />
                </View>
              </TouchableOpacity>
            ))}
          </ListCard>
        )}
      </Screen>
      <Fab icon="folder-plus" label="Nova pasta" onPress={() => setEditing(newFolder(''))} />

      <Sheet visible={!!editing} onClose={() => setEditing(null)} title={isNew ? 'Nova pasta' : 'Editar pasta'}>
        {editing ? (
          <>
            <Input label="Nome" value={editing.name} onChangeText={t => setEditing({ ...editing, name: t })} placeholder="Ex.: Finanças" maxLength={LIMITS.folderName} autoFocus={!!isNew} />
            <Text style={[Type.label, styles.mb8]}>Dentro de</Text>
            <View style={[styles.wrap, styles.mb14]}>
              <Chip label="Raiz" active={!editing.parentId} onPress={() => setEditing({ ...editing, parentId: null })} />
              {data.folders
                .filter(f => f.id !== editing.id && !Repo.descendantIds(data.folders, editing.id).includes(f.id))
                .map(f => (
                  <Chip key={f.id} label={Repo.folderPath(data.folders, f.id)} active={editing.parentId === f.id} onPress={() => setEditing({ ...editing, parentId: f.id })} />
                ))}
            </View>
            <Button title="Salvar" icon="check" onPress={save} />
            {!isNew ? (
              <Button
                title="Regras de segurança"
                variant="outline"
                icon="shield"
                style={styles.mt10}
                onPress={() => {
                  const id = editing.id;
                  setEditing(null);
                  navigation.navigate('FolderRules', { folderId: id });
                }}
              />
            ) : null}
            {!isNew ? <Button title="Excluir pasta" variant="danger" icon="trash-2" onPress={remove} style={styles.mt10} /> : null}
          </>
        ) : null}
      </Sheet>
      {reauth.element}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  item: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingRight: 16 },
  itemBorder: { borderBottomWidth: 1, borderBottomColor: Colors.divider },
  folderIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  mr6: { marginRight: 6 },
  ml8: { marginLeft: 8 },
  mb8: { marginBottom: 8 },
  mb14: { marginBottom: 14 },
  mb16: { marginBottom: 16 },
  mt10: { marginTop: 10 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  color: { width: 32, height: 32, borderRadius: 16, borderWidth: 3, borderColor: 'transparent' },
  colorOn: { borderColor: Colors.text },
});
