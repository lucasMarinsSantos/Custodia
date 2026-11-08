// Boas-vindas (primeiro acesso)
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Icon } from '../../components/ui';
import { Colors, Type } from '../../theme';

const FEATURES = [
  { icon: 'lock', title: 'Cofre criptografado', text: 'Banco local SQLCipher (AES-256) com chave protegida pelo Android Keystore.' },
  { icon: 'aperture', title: 'Acesso rápido e seguro', text: 'Senha mestra forte, biometria e bloqueio automático.' },
  { icon: 'refresh-cw', title: 'Gerador e análise de senhas', text: 'Crie senhas fortes e veja quais precisam ser trocadas.' },
];

export default function WelcomeScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.root}>
      <View style={[styles.hero, { paddingTop: insets.top + 40 }]}>
        <View style={styles.logo}>
          <Icon name="shield" size={38} color={Colors.primary} />
        </View>
        <Text style={styles.brand}>Custódia</Text>
        <Text style={styles.tagline}>Seu cofre de senhas, só seu.</Text>
      </View>
      <View style={[styles.body, { paddingBottom: insets.bottom + 24 }]}>
        <View>
          {FEATURES.map(f => (
            <View key={f.title} style={styles.feature}>
              <View style={styles.featureIcon}>
                <Icon name={f.icon} size={20} color={Colors.primary} />
              </View>
              <View style={styles.flex}>
                <Text style={Type.bodyStrong}>{f.title}</Text>
                <Text style={Type.small}>{f.text}</Text>
              </View>
            </View>
          ))}
        </View>
        <View>
          <Button title="Criar meu cofre" icon="arrow-right" onPress={() => navigation.navigate('Setup')} />
          <Text style={[Type.caption, styles.footer]}>Modelo zero-knowledge • Android Keystore • v0.1</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  flex: { flex: 1 },
  hero: { alignItems: 'center', paddingBottom: 44, borderBottomLeftRadius: 32, borderBottomRightRadius: 32, backgroundColor: Colors.primary },
  logo: { width: 84, height: 84, borderRadius: 26, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  brand: { fontSize: 34, fontWeight: '800', color: '#fff', letterSpacing: -0.8 },
  tagline: { fontSize: 16, color: '#CCFBF1', marginTop: 6 },
  body: { flex: 1, padding: 24, justifyContent: 'space-between' },
  feature: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  featureIcon: { width: 46, height: 46, borderRadius: 14, backgroundColor: Colors.primarySoft, alignItems: 'center', justifyContent: 'center', marginRight: 14 },
  footer: { textAlign: 'center', marginTop: 14 },
});
