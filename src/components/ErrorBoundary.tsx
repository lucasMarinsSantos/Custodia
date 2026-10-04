// Captura erros de renderização: em vez de uma tela branca, mostra uma recuperação segura.
// Nenhum dado do cofre é exibido na mensagem (só o tipo do erro).
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import { Colors, Radius, Type } from '../theme';

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode; onReset?: () => void }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error.name, info.componentStack?.split('\n').slice(0, 4).join('\n'));
  }

  reset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <View style={styles.wrap} accessibilityRole="alert">
        <View style={styles.icon}>
          <Icon name="alert-triangle" size={30} color={Colors.warning} />
        </View>
        <Text style={[Type.h2, styles.center]} accessibilityRole="header">
          Algo deu errado nesta tela
        </Text>
        <Text style={[Type.small, styles.msg]}>Seus dados continuam cifrados e seguros. Tente abrir a tela novamente.</Text>
        <Text style={[Type.caption, styles.center]}>{this.state.error.name}</Text>
        <TouchableOpacity style={styles.btn} onPress={this.reset} accessibilityRole="button" accessibilityLabel="Tentar novamente">
          <Icon name="refresh-cw" size={18} color="#fff" />
          <Text style={styles.btnText}>Tentar novamente</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: Colors.background },
  icon: { width: 72, height: 72, borderRadius: 36, backgroundColor: Colors.warningBg, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  center: { textAlign: 'center' },
  msg: { textAlign: 'center', marginTop: 8, marginBottom: 8, maxWidth: 300 },
  btn: { marginTop: 20, minHeight: 52, paddingHorizontal: 24, borderRadius: Radius.md, backgroundColor: Colors.primary, flexDirection: 'row', alignItems: 'center', gap: 8 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
