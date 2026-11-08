// Campo da senha mestra com suporte ao teclado virtual seguro (anti-keylogger)
import React, { useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Colors, Radius, Touch, Type } from '../theme';
import { bus, Events } from '../services/events';
import { Icon, useScreenScroll } from './ui';
import { SecureKeyboard } from './widgets';

interface Props {
  value: string;
  onChange: (v: string) => void;
  secureKeyboard: boolean;
  placeholder?: string;
  label?: string;
  onSubmit?: () => void;
  autoFocus?: boolean;
}

/** Campo "falso" do teclado seguro: mostra os pontos e abre o teclado embaralhado ao toque. */
function SecureField(p: { value: string; visible: boolean; placeholder: string; label: string; expanded: boolean; onPress: () => void }) {
  let text = p.placeholder;
  if (p.value) text = p.visible ? p.value : '•'.repeat(p.value.length);
  return (
    <TouchableOpacity
      style={styles.fake}
      onPress={p.onPress}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={p.label}
      accessibilityHint="Abre o teclado seguro com teclas embaralhadas"
      accessibilityState={{ expanded: p.expanded }}
    >
      <Text style={[styles.fakeText, !p.value && styles.placeholder, p.visible ? styles.spacingVisible : styles.spacingHidden]}>{text}</Text>
    </TouchableOpacity>
  );
}

export function MasterPasswordInput({ value, onChange, secureKeyboard, placeholder = 'Senha mestra', label, onSubmit, autoFocus }: Props) {
  const [visible, setVisible] = useState(false);
  const [kbOpen, setKbOpen] = useState(false);
  const [seed, setSeed] = useState(0);
  const kbRef = useRef<any>(null);
  const screen = useScreenScroll();

  const openKb = () => {
    setSeed(s => s + 1); // embaralha novamente a cada uso
    setKbOpen(true);
  };

  const a11yName = label || placeholder;
  const typedLabel = value ? value.length + ' caracteres digitados' : 'vazia';
  return (
    <View style={styles.container}>
      {label ? (
        <Text style={[Type.label, styles.label]} importantForAccessibility="no" accessibilityElementsHidden>
          {label}
        </Text>
      ) : null}
      <View style={[styles.wrap, kbOpen && styles.wrapActive]}>
        <Icon name="lock" size={18} color={kbOpen ? Colors.primary : Colors.textTertiary} style={styles.lock} />
        {secureKeyboard ? (
          <SecureField value={value} visible={visible} placeholder={placeholder} label={`${a11yName}, ${typedLabel}`} expanded={kbOpen} onPress={openKb} />
        ) : (
          <TextInput
            style={styles.input}
            value={value}
            onChangeText={t => {
              bus.emit(Events.ACTIVITY);
              onChange(t);
            }}
            placeholder={placeholder}
            placeholderTextColor={Colors.placeholder}
            accessibilityLabel={a11yName}
            secureTextEntry={!visible}
            autoCorrect={false}
            autoCapitalize="none"
            autoComplete="off"
            importantForAutofill="no"
            spellCheck={false}
            contextMenuHidden
            autoFocus={autoFocus}
            returnKeyType="done"
            onSubmitEditing={onSubmit}
          />
        )}
        <TouchableOpacity
          onPress={() => setVisible(v => !v)}
          hitSlop={Touch.hitSlop}
          style={styles.eye}
          accessibilityRole="button"
          accessibilityLabel={visible ? 'Ocultar senha' : 'Mostrar senha'}
        >
          <Icon name={visible ? 'eye-off' : 'eye'} size={18} color={Colors.textSecondary} />
        </TouchableOpacity>
      </View>
      {secureKeyboard && kbOpen ? (
        <View ref={kbRef} style={styles.kb} onLayout={() => screen?.reveal(kbRef.current)}>
          <SecureKeyboard
            seed={seed}
            onKey={k => {
              bus.emit(Events.ACTIVITY);
              onChange(value + k);
            }}
            onBackspace={() => onChange(value.slice(0, -1))}
            onDone={() => {
              setKbOpen(false);
              onSubmit?.();
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginBottom: 16 },
  label: { marginBottom: 6 },
  wrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.surface, borderRadius: Radius.md, borderWidth: 1.5, borderColor: Colors.borderStrong, paddingHorizontal: 14, minHeight: 54 },
  wrapActive: { borderColor: Colors.primary, borderWidth: 2 },
  lock: { marginRight: 10 },
  fake: { flex: 1, paddingVertical: 14 },
  fakeText: { fontSize: 16, color: Colors.text },
  spacingVisible: { letterSpacing: 0.5 },
  spacingHidden: { letterSpacing: 3 },
  placeholder: { color: Colors.placeholder },
  input: { flex: 1, fontSize: 16, color: Colors.text, paddingVertical: 12 },
  eye: { paddingLeft: 8, minHeight: 44, justifyContent: 'center' },
  kb: { marginTop: 10, marginHorizontal: -8 },
});
