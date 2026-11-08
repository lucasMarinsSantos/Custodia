// "Sites e apps associados": domínios extras (com "*.empresa.com" valendo para todos os subdomínios) e
// pacotes Android em que a credencial pode ser preenchida. Editor (cadastro/edição) e lista (detalhe).
import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Button, Card, Chip, Icon, Input, Section } from './ui';
import { Colors, Touch, Type } from '../theme';
import { addAssociation, Assoc, ASSOC_MSG, AssocKind as Kind } from '../services/AssociationService';

export function AssociatedSitesEditor({ value, onChange }: { value: Assoc; onChange: (next: Assoc) => void }) {
  const [kind, setKind] = useState<Kind>('site');
  const [entry, setEntry] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    const r = addAssociation(value, kind, entry);
    if (r.error || !r.next) {
      setError(r.error || ASSOC_MSG.badSite);
      return;
    }
    setError(null);
    setEntry('');
    onChange(r.next);
  };

  const remove = (k: Kind, item: string) =>
    onChange(k === 'site' ? { ...value, associatedDomains: value.associatedDomains.filter(d => d !== item) } : { ...value, androidPackages: value.androidPackages.filter(p => p !== item) });

  return (
    <Section title="Sites e apps associados">
      <Text style={[Type.small, styles.mb8]}>
        O preenchimento automático também vale nestes endereços e apps. Use *.empresa.com para todos os subdomínios.
      </Text>
      <View style={styles.wrap}>
        <Chip label="Site" icon="globe" active={kind === 'site'} onPress={() => setKind('site')} />
        <Chip label="App Android" icon="smartphone" active={kind === 'app'} onPress={() => setKind('app')} />
      </View>
      <Input
        label={kind === 'site' ? 'Domínio associado' : 'Pacote do app'}
        icon={kind === 'site' ? 'globe' : 'smartphone'}
        value={entry}
        onChangeText={t => {
          setEntry(t);
          if (error) setError(null);
        }}
        placeholder={kind === 'site' ? 'empresa.com ou *.empresa.com' : 'com.empresa.app'}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={kind === 'site' ? 'url' : 'default'}
        maxLength={255}
        error={error}
        onSubmitEditing={add}
        containerStyle={styles.mt10}
      />
      <Button title="Adicionar" icon="plus" variant="secondary" small onPress={add} disabled={!entry.trim()} />
      <AssociatedList value={value} onRemove={remove} />
    </Section>
  );
}

function AssociatedList({ value, onRemove }: { value: Assoc; onRemove?: (k: Kind, item: string) => void }) {
  const items: { k: Kind; item: string }[] = [
    ...value.associatedDomains.map(item => ({ k: 'site' as Kind, item })),
    ...value.androidPackages.map(item => ({ k: 'app' as Kind, item })),
  ];
  if (!items.length) return onRemove ? <Text style={[Type.caption, styles.mt10]}>Nenhum site ou app associado.</Text> : null;
  return (
    <View style={styles.mt10}>
      {items.map(({ k, item }) => (
        <View key={`${k}:${item}`} style={styles.item} accessible={!onRemove} accessibilityLabel={`${k === 'site' ? 'Site' : 'App'} ${item}`}>
          <Icon name={k === 'site' ? 'globe' : 'smartphone'} size={16} color={Colors.textSecondary} />
          <Text style={[Type.body, styles.itemText]} numberOfLines={1}>
            {item}
          </Text>
          {onRemove ? (
            <TouchableOpacity onPress={() => onRemove(k, item)} hitSlop={Touch.hitSlop} style={styles.remove} accessibilityRole="button" accessibilityLabel={`Remover ${item}`}>
              <Icon name="x" size={18} color={Colors.danger} />
            </TouchableOpacity>
          ) : null}
        </View>
      ))}
    </View>
  );
}

/** Lista somente leitura, para o detalhe da credencial. */
export function AssociatedSitesView({ credential }: { credential: Assoc }) {
  if (!credential.associatedDomains.length && !credential.androidPackages.length) return null;
  return (
    <Section title="Sites e apps associados">
      <Card>
        <AssociatedList value={credential} />
      </Card>
    </Section>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  mb8: { marginBottom: 8 },
  mt10: { marginTop: 10 },
  item: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: Colors.divider },
  itemText: { flex: 1, marginLeft: 10 },
  remove: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
