// Componentes específicos do app
import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Image, LayoutChangeEvent, PanResponder, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors, colorFor, Radius, scoreColor, StrengthColors, StrengthTextColors, Type } from '../theme';
import { Credential, PasswordStrength, StrengthLabels } from '../types/models';
import { IconService } from '../services/IconService';
import { PasswordService, StrengthLevel } from '../services/PasswordService';
import { bus, Events } from '../services/events';
import { CLIPBOARD_EVENT, ClipboardService, ClipboardState } from '../services/ClipboardService';
import { randomInt } from '../crypto';

// ---------------------------------------------------------------------------
// Ícone do serviço (logo baixado, glifo personalizado, imagem ou inicial)
// ---------------------------------------------------------------------------
export const ServiceIcon = memo(function ServiceIconView({ credential, size = 44 }: { credential: Pick<Credential, 'title' | 'url' | 'icon'>; size?: number }) {
  const icon = credential.icon || { kind: 'auto' };
  const wantsLogo = icon.kind === 'auto';
  const [logoState, setLogoState] = useState<{ url: string; logo: string | null | undefined }>(() => ({
    url: credential.url,
    logo: wantsLogo ? IconService.cached(credential.url) : null,
  }));
  // Se o item foi reciclado pela lista para outra URL, descarta o logo anterior no mesmo render.
  const logo = logoState.url === credential.url ? logoState.logo : wantsLogo ? IconService.cached(credential.url) : null;
  useEffect(() => {
    let alive = true;
    if (wantsLogo && credential.url && logo === undefined) {
      const url = credential.url;
      IconService.logoFor(url, true)
        .then(l => {
          if (alive) setLogoState({ url, logo: l });
        })
        .catch(() => {
          if (alive) setLogoState({ url, logo: null });
        });
    }
    return () => {
      alive = false;
    };
  }, [credential.url, wantsLogo, logo]);

  const radius = size * 0.28;
  if (icon.kind === 'image' && icon.image) {
    return <Image source={{ uri: icon.image }} style={{ width: size, height: size, borderRadius: radius }} accessibilityIgnoresInvertColors importantForAccessibility="no" />;
  }
  if (icon.kind === 'glyph' && icon.glyph) {
    return (
      <View style={[styles.iconBox, { width: size, height: size, borderRadius: radius, backgroundColor: icon.color || Colors.primary }]}>
        <Icon name={icon.glyph} size={size * 0.48} color="#fff" />
      </View>
    );
  }
  if (logo) {
    return (
      <View style={[styles.iconBox, styles.logoBox, { width: size, height: size, borderRadius: radius }]}>
        <Image source={{ uri: logo }} style={{ width: size * 0.62, height: size * 0.62 }} resizeMode="contain" />
      </View>
    );
  }
  const bg = icon.color || colorFor(credential.title || '?');
  return (
    <View style={[styles.iconBox, { width: size, height: size, borderRadius: radius, backgroundColor: bg }]}>
      <Text style={[styles.initial, { fontSize: size * 0.42 }]} maxFontSizeMultiplier={1.2}>
        {(Array.from((credential.title || '?').trim())[0] || '?').toUpperCase()}
      </Text>
    </View>
  );
});

// ---------------------------------------------------------------------------
// Medidor de força
// ---------------------------------------------------------------------------
/** `checkCommon`: compara com a lista das 10 mil senhas mais comuns (só para a senha mestra). */
export function StrengthMeter({ password, showFeedback = true, checkCommon = false }: { password: string; showFeedback?: boolean; checkCommon?: boolean }) {
  const a = useMemo(() => PasswordService.analyze(password, { checkCommon }), [password, checkCommon]);
  const bits = useMemo(() => PasswordService.entropyBits(password), [password]);
  const level = password ? StrengthLevel[a.strength] + 1 : 0;
  const color = StrengthColors[a.strength];
  const textColor = StrengthTextColors[a.strength];
  const summary = password ? `Força da senha: ${StrengthLabels[a.strength]}, ${a.score} de 100, ${bits} bits` : 'Força da senha: vazia';
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={summary} accessibilityValue={{ min: 0, max: 100, now: password ? a.score : 0 }} accessibilityLiveRegion="polite">
      <View style={styles.meterRow}>
        {[1, 2, 3, 4, 5].map(i => (
          <View key={i} style={[styles.meterSeg, { backgroundColor: i <= level ? color : Colors.border }]} />
        ))}
      </View>
      {password ? (
        <View style={styles.meterInfo}>
          <Text style={[Type.caption, styles.bold, { color: textColor }]}>
            {StrengthLabels[a.strength]} • {a.score}/100
          </Text>
          <Text style={Type.caption}>{bits} bits</Text>
        </View>
      ) : null}
      {showFeedback && password && a.feedback.length ? <Text style={[Type.caption, styles.meterFeedback]}>{a.feedback.slice(0, 2).join(' • ')}</Text> : null}
    </View>
  );
}

export function StrengthDot({ strength }: { strength: PasswordStrength }) {
  return <View style={[styles.dot, { backgroundColor: StrengthColors[strength] }]} />;
}

// ---------------------------------------------------------------------------
// Gráficos simples
// ---------------------------------------------------------------------------
export function ScoreRing({ score, size = 150, label }: { score: number; size?: number; label: string }) {
  const color = scoreColor(score);
  return (
    <View style={styles.centered} accessible accessibilityRole="image" accessibilityLabel={`Pontuação ${score} de 100, ${label}`}>
      <View style={[styles.ringOuter, { width: size, height: size, borderRadius: size / 2, borderColor: color + '33' }]}>
        <View style={[styles.ringInner, { width: size - 22, height: size - 22, borderRadius: (size - 22) / 2, borderColor: color }]}>
          <Text style={[styles.ringScore, { fontSize: size * 0.24 }]} maxFontSizeMultiplier={1.2}>
            {score}
            <Text style={[styles.ringMax, { fontSize: size * 0.11 }]}>/100</Text>
          </Text>
          <Text style={[styles.ringLabel, { color }]} maxFontSizeMultiplier={1.2}>
            {label}
          </Text>
        </View>
      </View>
    </View>
  );
}

export function HBarChart({ data }: { data: { label: string; value: number; color: string }[] }) {
  const max = Math.max(1, ...data.map(d => d.value));
  return (
    <View>
      {data.map(d => (
        <View key={d.label} style={styles.hbarRow} accessible accessibilityLabel={`${d.label}: ${d.value}`}>
          <Text style={[Type.small, styles.hbarLabel]} numberOfLines={1}>
            {d.label}
          </Text>
          <View style={styles.hbarTrack}>
            <View style={[styles.hbarFill, { width: `${(d.value / max) * 100}%`, backgroundColor: d.color }]} />
          </View>
          <Text style={[Type.bodyStrong, styles.hbarValue]}>{d.value}</Text>
        </View>
      ))}
    </View>
  );
}

export function StackedBar({ parts }: { parts: { value: number; color: string }[] }) {
  const total = parts.reduce((a, b) => a + b.value, 0) || 1;
  return (
    <View style={styles.stacked} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      {parts.map((p, i) => (p.value ? <View key={i} style={{ flex: p.value / total, backgroundColor: p.color }} /> : null))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Controle deslizante (comprimento da senha)
// ---------------------------------------------------------------------------
export function Slider({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (v: number) => void; label?: string }) {
  const [width, setWidth] = useState(1);
  const widthRef = useRef(1);
  const pct = (value - min) / (max - min);
  // Mantém a versão mais recente de onChange/limites sem recriar o PanResponder no meio do gesto.
  const latest = useRef({ onChange, min, max });
  latest.current = { onChange, min, max };
  const responder = useMemo(() => {
    const update = (x: number) => {
      const l = latest.current;
      const p = Math.max(0, Math.min(1, x / widthRef.current));
      l.onChange(Math.round(l.min + p * (l.max - l.min)));
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: e => update(e.nativeEvent.locationX),
      onPanResponderMove: e => update(e.nativeEvent.locationX),
    });
  }, []);
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min, max, now: value }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={e => onChange(clamp(value + (e.nativeEvent.actionName === 'increment' ? 1 : -1)))}
      onLayout={(e: LayoutChangeEvent) => {
        widthRef.current = e.nativeEvent.layout.width;
        setWidth(e.nativeEvent.layout.width);
      }}
      style={styles.slider}
      {...responder.panHandlers}
    >
      <View pointerEvents="none" style={styles.sliderTrack}>
        <View style={[styles.sliderFill, { width: pct * width }]} />
      </View>
      <View pointerEvents="none" style={[styles.thumb, { left: pct * width - 12 }]} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Teclado virtual seguro (senha mestra): teclas embaralhadas a cada uso,
// sem corretor/histórico/sugestões, o teclado do sistema não é aberto.
// ---------------------------------------------------------------------------
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const DIGITS = '0123456789'.split('');
const SYMBOLS = '!@#$%&*()-_=+[]{};:,.?/\\|<>~^'.split('');

function shuffled<T>(a: T[]): T[] {
  const arr = [...a];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Nomes falados para símbolos (TalkBack costuma ignorar pontuação). */
const SYMBOL_NAMES: Record<string, string> = {
  '!': 'exclamação', '@': 'arroba', '#': 'cerquilha', $: 'cifrão', '%': 'porcento', '&': 'e comercial', '*': 'asterisco',
  '(': 'abre parêntese', ')': 'fecha parêntese', '-': 'hífen', _: 'sublinhado', '=': 'igual', '+': 'mais', '[': 'abre colchete',
  ']': 'fecha colchete', '{': 'abre chave', '}': 'fecha chave', ';': 'ponto e vírgula', ':': 'dois pontos', ',': 'vírgula',
  '.': 'ponto', '?': 'interrogação', '/': 'barra', '\\': 'barra invertida', '|': 'barra vertical', '<': 'menor que',
  '>': 'maior que', '~': 'til', '^': 'circunflexo',
};

const Key = memo(function KeyboardKey({
  k,
  flex = 1,
  onPress,
  children,
  dark,
  shift,
  label,
  selected,
}: {
  k?: string;
  flex?: number;
  onPress: ((k: string) => void) | (() => void);
  children?: React.ReactNode;
  dark?: boolean;
  shift?: boolean;
  label?: string;
  selected?: boolean;
}) {
  const shown = shift && k ? k.toUpperCase() : k;
  const spoken = label || (k ? SYMBOL_NAMES[k] || (shift && /[a-z]/.test(k) ? `${k.toUpperCase()} maiúsculo` : k) : '');
  return (
    <TouchableOpacity
      style={[styles.key, { flex }, dark && styles.keyDark]}
      activeOpacity={0.6}
      onPress={() => (k ? (onPress as (k: string) => void)(k) : (onPress as () => void)())}
      accessibilityRole="keyboardkey"
      accessibilityLabel={spoken}
      accessibilityState={selected !== undefined ? { selected } : undefined}
    >
      {children || <Text style={styles.keyText}>{shown}</Text>}
    </TouchableOpacity>
  );
});

export function SecureKeyboard({ onKey, onBackspace, onDone, seed }: { onKey: (k: string) => void; onBackspace: () => void; onDone: () => void; seed: number }) {
  const [mode, setMode] = useState<'abc' | 'sym'>('abc');
  const [shift, setShift] = useState(false);
  const layout = useMemo(() => {
    const letters = shuffled(LETTERS);
    return {
      digits: shuffled(DIGITS),
      rows: [letters.slice(0, 10), letters.slice(10, 19), letters.slice(19)],
      symbols: shuffled(SYMBOLS),
    };
    // Novo embaralhamento a cada abertura
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);
  const rows = mode === 'abc' ? layout.rows : [layout.symbols.slice(0, 10), layout.symbols.slice(10, 20), layout.symbols.slice(20)];
  const typeKey = (k: string) => onKey(shift ? k.toUpperCase() : k);
  return (
    <View style={styles.keyboard}>
      <View style={styles.kbHeader}>
        <Icon name="shield" size={12} color={Colors.primary} />
        <Text style={[Type.caption, styles.kbTitle]}>Teclado seguro • teclas embaralhadas</Text>
      </View>
      <View style={styles.kbRow}>
        {layout.digits.map(d => (
          <Key key={d} k={d} onPress={typeKey} />
        ))}
      </View>
      {rows.map((row, i) => (
        <View key={i} style={styles.kbRow}>
          {i === 2 ? (
            <Key flex={1.4} dark label={shift ? 'Maiúsculas ativadas' : 'Maiúsculas'} selected={shift} onPress={() => setShift(v => !v)}>
              <Icon name="arrow-up" size={18} color={shift ? Colors.primary : Colors.text} />
            </Key>
          ) : null}
          {row.map(k => (
            <Key key={k} k={k} shift={shift} onPress={typeKey} />
          ))}
          {i === 2 ? (
            <Key flex={1.4} dark label="Apagar" onPress={onBackspace}>
              <Icon name="delete" size={18} color={Colors.text} />
            </Key>
          ) : null}
        </View>
      ))}
      <View style={styles.kbRow}>
        <Key flex={2} dark label={mode === 'abc' ? 'Símbolos' : 'Letras'} onPress={() => setMode(m => (m === 'abc' ? 'sym' : 'abc'))}>
          <Text style={styles.keyText}>{mode === 'abc' ? '#+=' : 'abc'}</Text>
        </Key>
        <Key flex={5} label="Espaço" onPress={() => onKey(' ')}>
          <Text style={[styles.keyText, styles.keyTextSmall]}>espaço</Text>
        </Key>
        <Key flex={2.4} label="Concluir" onPress={onDone}>
          <Text style={[styles.keyText, styles.keyDone]}>OK</Text>
        </Key>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Toast global
// ---------------------------------------------------------------------------
export function ToastHost() {
  const [msg, setMsg] = useState<{ message: string; kind: string } | null>(null);
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let timer: any;
    const off = bus.on(Events.TOAST, (m: any) => {
      setMsg(m);
      AccessibilityInfo.announceForAccessibility(m.message);
      Animated.timing(anim, { toValue: 1, duration: 180, useNativeDriver: true }).start();
      clearTimeout(timer);
      timer = setTimeout(() => {
        Animated.timing(anim, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => setMsg(null));
      }, 2600);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [anim]);
  if (!msg) return null;
  const bg = msg.kind === 'error' ? Colors.danger : msg.kind === 'success' ? Colors.navy : Colors.navyLight;
  const icon = msg.kind === 'error' ? 'alert-circle' : msg.kind === 'success' ? 'check-circle' : 'info';
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      style={[styles.toast, { backgroundColor: bg, opacity: anim, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) }] }]}
    >
      <Icon name={icon} size={18} color="#fff" style={styles.toastIcon} />
      <Text style={styles.toastText}>{msg.message}</Text>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Indicador de área de transferência: contagem regressiva até a limpeza automática
// ---------------------------------------------------------------------------
export function ClipboardIndicator() {
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<ClipboardState | null>(ClipboardService.state);
  const [now, setNow] = useState(Date.now());
  useEffect(() => bus.on(CLIPBOARD_EVENT, (s: ClipboardState | null) => setState(s)), []);
  useEffect(() => {
    if (!state) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [state]);
  if (!state) return null;
  const secs = Math.max(0, Math.ceil((state.expiresAt - now) / 1000));
  return (
    <View style={[styles.clip, { top: insets.top + 6 }]} accessibilityLiveRegion="polite">
      <Icon name="clipboard" size={15} color="#fff" style={styles.clipIcon} />
      <Text style={styles.clipText} numberOfLines={1}>
        Copiado: {state.label} • limpa em {secs}s
      </Text>
      <TouchableOpacity onPress={() => ClipboardService.clearNow()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Limpar área de transferência agora">
        <Text style={styles.clipBtn}>Limpar</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  initial: { color: '#fff', fontWeight: '800' },
  bold: { fontWeight: '700' },
  centered: { alignItems: 'center', justifyContent: 'center' },
  meterRow: { flexDirection: 'row', gap: 4 },
  meterSeg: { flex: 1, height: 5, borderRadius: 3 },
  meterInfo: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  meterFeedback: { marginTop: 4, color: Colors.textSecondary },
  ringScore: { fontWeight: '800', color: Colors.text },
  ringMax: { color: Colors.textTertiary },
  ringLabel: { fontSize: 13, fontWeight: '700' },
  hbarRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  stacked: { flexDirection: 'row', height: 14, borderRadius: 7, overflow: 'hidden', backgroundColor: Colors.divider },
  slider: { height: 44, justifyContent: 'center' },
  keyDark: { backgroundColor: '#CBD5E1' },
  keyTextSmall: { fontSize: 13 },
  keyDone: { color: Colors.primary, fontWeight: '800' },
  kbTitle: { marginLeft: 4, color: Colors.primary },
  iconBox: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  ringOuter: { borderWidth: 11, alignItems: 'center', justifyContent: 'center' },
  ringInner: { borderWidth: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  thumb: { position: 'absolute', width: 24, height: 24, borderRadius: 12, backgroundColor: '#fff', borderWidth: 4, borderColor: Colors.primary, top: 10 },
  keyboard: { backgroundColor: '#E2E8F0', paddingHorizontal: 4, paddingTop: 6, paddingBottom: 8, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  kbHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  kbRow: { flexDirection: 'row', justifyContent: 'center', marginVertical: 3 },
  key: { height: 46, marginHorizontal: 2.5, borderRadius: 7, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 1, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  keyText: { fontSize: 18, color: Colors.text, fontWeight: '500' },
  // Fica à esquerda, abaixo da barra de status, sem cobrir os botões de ação do cabeçalho (à direita)
  clip: { position: 'absolute', left: 12, maxWidth: '64%', flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(15,23,42,0.92)', borderRadius: 20, paddingVertical: 8, paddingHorizontal: 14, elevation: 8 },
  clipIcon: { marginRight: 8 },
  clipText: { color: '#fff', fontSize: 13, fontWeight: '600', flexShrink: 1 },
  clipBtn: { color: '#5EEAD4', fontWeight: '800', fontSize: 13, marginLeft: 12 },
  logoBox: { backgroundColor: '#fff', borderWidth: 1, borderColor: Colors.borderLight },
  dot: { width: 9, height: 9, borderRadius: 5 },
  hbarLabel: { width: 92 },
  hbarTrack: { flex: 1, height: 12, borderRadius: 6, backgroundColor: Colors.divider, overflow: 'hidden' },
  hbarFill: { height: 12, borderRadius: 6 },
  hbarValue: { width: 36, textAlign: 'right', fontSize: 13 },
  sliderTrack: { height: 6, borderRadius: 3, backgroundColor: Colors.border },
  sliderFill: { height: 6, borderRadius: 3, backgroundColor: Colors.primary },
  toastIcon: { marginRight: 10 },
  toastText: { color: '#fff', fontSize: 14, fontWeight: '600', flex: 1 },
  toast: { position: 'absolute', left: 16, right: 16, bottom: 96, borderRadius: Radius.md, paddingVertical: 14, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', elevation: 10, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 12, shadowOffset: { width: 0, height: 6 } },
});
