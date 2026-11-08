// Componentes base da interface
//
// Todos os componentes interativos expõem papel (accessibilityRole), nome (accessibilityLabel)
// e estado (accessibilityState) ao TalkBack/VoiceOver e respeitam o alvo mínimo de toque (48dp).
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityRole,
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControlProps,
  ScrollView,
  StyleProp,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TextInputProps,
  TouchableOpacity,
  View,
  ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/Feather';
import { Colors, Radius, Shadow, Spacing, Touch, Type } from '../theme';
import { bus, Events, toast } from '../services/events';

export { Icon };

// ---------------------------------------------------------------------------
// Tela + cabeçalho
// ---------------------------------------------------------------------------
interface HeaderProps {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  right?: React.ReactNode;
  large?: boolean;
}

export function Header({ title, subtitle, onBack, right, large }: HeaderProps) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.header, { paddingTop: insets.top + (large ? 14 : 8) }]}>
      <View style={styles.headerRow}>
        {onBack ? (
          <TouchableOpacity onPress={onBack} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Voltar" hitSlop={Touch.hitSlop}>
            <Icon name="arrow-left" size={22} color={Colors.text} />
          </TouchableOpacity>
        ) : null}
        <View style={styles.flex}>
          <Text style={large ? Type.h1 : Type.h2} numberOfLines={1} accessibilityRole="header">
            {title}
          </Text>
          {subtitle ? (
            <Text style={[Type.small, styles.mt2]} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {right ? <View style={styles.headerRight}>{right}</View> : null}
      </View>
    </View>
  );
}

interface ScreenProps {
  title?: string;
  subtitle?: string;
  onBack?: () => void;
  right?: React.ReactNode;
  children: React.ReactNode;
  scroll?: boolean;
  large?: boolean;
  footer?: React.ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
  refreshControl?: React.ReactElement<RefreshControlProps>;
}

/** Permite que um filho (ex.: teclado seguro) role a tela até ficar visível. */
const ScreenScrollContext = createContext<{ reveal: (view: any) => void } | null>(null);
export const useScreenScroll = () => useContext(ScreenScrollContext);

const FOOTER_GAP = 24;

export function Screen({ title, subtitle, onBack, right, children, scroll = true, large, footer, contentStyle, refreshControl }: ScreenProps) {
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<any>(null);
  const offset = useRef(0);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (revealTimer.current) clearTimeout(revealTimer.current);
    },
    [],
  );
  const reveal = useCallback((view: any) => {
    if (revealTimer.current) clearTimeout(revealTimer.current);
    revealTimer.current = setTimeout(() => {
      const sv: any = scrollRef.current;
      if (!view || !sv) return;
      view.measureInWindow((_x: number, y: number, _w: number, h: number) => {
        sv.measureInWindow?.((_sx: number, sy: number, _sw: number, sh: number) => {
          const overflow = y + h - (sy + sh) + 16;
          if (overflow > 0) sv.scrollTo({ y: offset.current + overflow, animated: true });
          else if (y < sy) sv.scrollTo({ y: Math.max(0, offset.current - (sy - y) - 16), animated: true });
        });
      });
    }, 60);
  }, []);
  const scrollCtx = useMemo(() => ({ reveal }), [reveal]);
  return (
    // Com edge-to-edge (Android 15+) o sistema não redimensiona a janela: o padding evita que o teclado cubra os campos.
    <KeyboardAvoidingView style={styles.screen} behavior="padding">
      {title !== undefined ? <Header title={title} subtitle={subtitle} onBack={onBack} right={right} large={large} /> : null}
      {scroll ? (
        <ScreenScrollContext.Provider value={scrollCtx}>
          <ScrollView
            ref={scrollRef}
            contentContainerStyle={[styles.scrollContent, { paddingBottom: footer ? FOOTER_GAP : insets.bottom + 32 }, contentStyle]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            showsVerticalScrollIndicator={false}
            refreshControl={refreshControl}
            scrollEventThrottle={32}
            onScroll={e => {
              offset.current = e.nativeEvent.contentOffset.y;
            }}
          >
            {children}
          </ScrollView>
        </ScreenScrollContext.Provider>
      ) : (
        <View style={[styles.flex, contentStyle]}>{children}</View>
      )}
      {footer ? <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>{footer}</View> : null}
    </KeyboardAvoidingView>
  );
}

// ---------------------------------------------------------------------------
// Botões
// ---------------------------------------------------------------------------
type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'outline';

interface ButtonProps {
  title: string;
  onPress?: () => unknown;
  variant?: ButtonVariant;
  icon?: string;
  loading?: boolean;
  disabled?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
}

const BUTTON_PALETTE: Record<ButtonVariant, { bg: string; fg: string; border: string }> = {
  primary: { bg: Colors.primary, fg: '#FFFFFF', border: Colors.primary },
  secondary: { bg: Colors.primarySoft, fg: Colors.primaryDark, border: Colors.primarySoft },
  danger: { bg: Colors.dangerBg, fg: Colors.danger, border: '#FECACA' },
  ghost: { bg: 'transparent', fg: Colors.primary, border: 'transparent' },
  outline: { bg: Colors.surface, fg: Colors.text, border: Colors.border },
};

/** Guarda contra setState depois da desmontagem (ex.: salvar → navigation.goBack()). */
function useMounted() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

export function Button({ title, onPress, variant = 'primary', icon, loading, disabled, small, style, accessibilityHint }: ButtonProps) {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const mounted = useMounted();
  const isLoading = loading || busy;
  const palette = BUTTON_PALETTE[variant];
  const handle = async () => {
    // `running` evita duplo toque antes do re-render (ex.: salvar duas vezes)
    if (!onPress || isLoading || running.current) return;
    let r: unknown;
    try {
      r = onPress();
    } catch (e: any) {
      toast(e?.message || 'Não foi possível concluir a ação.', 'error');
      return;
    }
    if (r && typeof (r as any).then === 'function') {
      running.current = true;
      setBusy(true);
      try {
        await r;
      } catch (e: any) {
        // Nenhuma falha de ação assíncrona fica silenciosa (ex.: "Muitas tentativas", cofre bloqueado)
        toast(e?.message || 'Não foi possível concluir a ação.', 'error');
      } finally {
        running.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  };
  return (
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={handle}
      disabled={disabled || isLoading}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!(disabled || isLoading), busy: isLoading }}
      style={[
        styles.button,
        small && styles.buttonSmall,
        { backgroundColor: palette.bg, borderColor: palette.border },
        disabled && styles.disabled,
        variant === 'primary' && !disabled ? Shadow.raised : null,
        style,
      ]}
    >
      {isLoading ? (
        <ActivityIndicator color={palette.fg} />
      ) : (
        <>
          {icon ? <Icon name={icon} size={small ? 15 : 18} color={palette.fg} style={styles.mr8} /> : null}
          <Text style={[styles.buttonText, small && styles.buttonTextSmall, { color: palette.fg }]}>{title}</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

interface IconButtonProps {
  name: string;
  onPress?: () => void;
  color?: string;
  bg?: string;
  size?: number;
  /** Nome acessível, obrigatório para botões só com ícone. */
  label: string;
  badge?: number;
  selected?: boolean;
  disabled?: boolean;
}

export function IconButton({ name, onPress, color = Colors.text, bg, size = 20, label, badge, selected, disabled }: IconButtonProps) {
  const a11yLabel = badge ? `${label}, ${badge} ${badge === 1 ? 'novo' : 'novos'}` : label;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={[styles.iconBtn, bg ? { backgroundColor: bg } : null, disabled && styles.disabled]}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      accessibilityState={{ selected, disabled }}
      hitSlop={Touch.hitSlop}
    >
      <Icon name={name} size={size} color={color} />
      {badge ? (
        <View style={styles.badgeDot} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          <Text style={styles.badgeDotText}>{badge > 9 ? '9+' : badge}</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

export function Fab({ onPress, icon = 'plus', label = 'Adicionar' }: { onPress: () => void; icon?: string; label?: string }) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={[styles.fab, Shadow.raised]} accessibilityRole="button" accessibilityLabel={label}>
      <Icon name={icon} size={24} color="#fff" />
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
// Cartões e listas
// ---------------------------------------------------------------------------
export function Card({
  children,
  style,
  onPress,
  accessibilityLabel,
  accessibilityHint,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  if (onPress) {
    return (
      <TouchableOpacity activeOpacity={0.75} onPress={onPress} style={[styles.card, style]} accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityHint={accessibilityHint}>
        {children}
      </TouchableOpacity>
    );
  }
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Section({ title, children, right, style }: { title?: string; children: React.ReactNode; right?: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.section, style]}>
      {title ? (
        <View style={styles.sectionHead}>
          <Text style={Type.label} accessibilityRole="header">
            {title}
          </Text>
          {right}
        </View>
      ) : null}
      {children}
    </View>
  );
}

interface RowProps {
  icon?: string;
  iconColor?: string;
  iconBg?: string;
  title: string;
  subtitle?: string;
  value?: string;
  onPress?: () => void;
  right?: React.ReactNode;
  chevron?: boolean;
  danger?: boolean;
  last?: boolean;
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: { checked?: boolean; disabled?: boolean; selected?: boolean };
  disabled?: boolean;
}

export function Row({ icon, iconColor, iconBg, title, subtitle, value, onPress, right, chevron, danger, last, accessibilityRole, accessibilityState, disabled }: RowProps) {
  const content = (
    <View style={[styles.row, !last && styles.rowBorder, disabled && styles.disabled]}>
      {icon ? (
        <View style={[styles.rowIcon, { backgroundColor: iconBg || (danger ? Colors.dangerBg : Colors.primarySoft) }]}>
          <Icon name={icon} size={18} color={iconColor || (danger ? Colors.danger : Colors.primary)} />
        </View>
      ) : null}
      <View style={styles.flex}>
        <Text style={[Type.bodyStrong, danger && styles.dangerText]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[Type.small, styles.mt2]} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value ? <Text style={[Type.small, styles.ml8]}>{value}</Text> : null}
      {right}
      {chevron ?? !!onPress ? <Icon name="chevron-right" size={18} color={Colors.textTertiary} style={styles.ml6} /> : null}
    </View>
  );
  const label = [title, subtitle, value].filter(Boolean).join(', ');
  return onPress ? (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole={accessibilityRole || 'button'}
      accessibilityLabel={label}
      accessibilityState={{ disabled, ...accessibilityState }}
    >
      {content}
    </TouchableOpacity>
  ) : (
    content
  );
}

export function ToggleRow({ icon, title, subtitle, value, onChange, last, disabled }: { icon?: string; title: string; subtitle?: string; value: boolean; onChange: (v: boolean) => void; last?: boolean; disabled?: boolean }) {
  // A linha inteira alterna o interruptor (alvo de toque grande) e é anunciada como "switch".
  return (
    <Row
      icon={icon}
      title={title}
      subtitle={subtitle}
      last={last}
      chevron={false}
      disabled={disabled}
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      right={
        <Switch
          value={value}
          disabled={disabled}
          onValueChange={onChange}
          trackColor={{ false: Colors.borderStrong, true: Colors.accent }}
          thumbColor={value ? Colors.primary : '#fff'}
          accessibilityLabel={title}
          importantForAccessibility="no"
          accessibilityElementsHidden
        />
      }
    />
  );
}

export function ListCard({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, styles.listCard, style]}>{children}</View>;
}

// ---------------------------------------------------------------------------
// Entradas de texto
// ---------------------------------------------------------------------------
interface InputProps extends TextInputProps {
  label?: string;
  icon?: string;
  secure?: boolean;
  right?: React.ReactNode;
  error?: string | null;
  hint?: string;
  containerStyle?: StyleProp<ViewStyle>;
  mono?: boolean;
  required?: boolean;
}

/** Campos de senha: sem autocorreção, sem maiúsculas automáticas e fora do preenchimento automático do sistema. */
function secureTextProps(secure: boolean | undefined, rest: TextInputProps): Partial<TextInputProps> {
  if (!secure) return {};
  return { autoCorrect: false, autoCapitalize: 'none', autoComplete: rest.autoComplete || 'off', importantForAutofill: rest.importantForAutofill || 'no' };
}

function InputLabel({ label, required }: { label?: string; required?: boolean }) {
  if (!label) return null;
  return (
    <Text style={[Type.label, styles.inputLabel]} importantForAccessibility="no" accessibilityElementsHidden>
      {label}
      {required ? <Text style={styles.dangerText}> *</Text> : null}
    </Text>
  );
}

function EyeToggle({ visible, onToggle }: { visible: boolean; onToggle: () => void }) {
  return (
    <TouchableOpacity onPress={onToggle} hitSlop={Touch.hitSlop} style={styles.eyeBtn} accessibilityRole="button" accessibilityLabel={visible ? 'Ocultar senha' : 'Mostrar senha'}>
      <Icon name={visible ? 'eye-off' : 'eye'} size={18} color={Colors.textSecondary} />
    </TouchableOpacity>
  );
}

function InputMessage({ error, hint }: { error?: string | null; hint?: string }) {
  if (error) {
    return (
      <View style={styles.errorRow} accessibilityLiveRegion="polite" accessibilityRole="alert">
        <Icon name="alert-circle" size={13} color={Colors.danger} style={styles.mr4} />
        <Text style={[Type.small, styles.errorText]}>{error}</Text>
      </View>
    );
  }
  return hint ? <Text style={[Type.caption, styles.mt4]}>{hint}</Text> : null;
}

export function Input({ label, icon, secure, right, error, hint, containerStyle, mono, multiline, style, required, ...rest }: InputProps) {
  const [visible, setVisible] = useState(false);
  const [focused, setFocused] = useState(false);
  const a11yLabel = rest.accessibilityLabel || label || rest.placeholder;
  const fullLabel = required && a11yLabel ? `${a11yLabel}, obrigatório` : a11yLabel;
  return (
    <View style={[styles.inputContainer, containerStyle]}>
      <InputLabel label={label} required={required} />
      <View style={[styles.inputWrap, multiline && styles.inputWrapMulti, focused && styles.inputFocused, error ? styles.inputError : null]}>
        {icon ? <Icon name={icon} size={18} color={focused ? Colors.primary : Colors.textTertiary} style={[styles.mr10, multiline && styles.mt2]} /> : null}
        <TextInput
          {...rest}
          {...secureTextProps(secure, rest)}
          accessibilityLabel={fullLabel}
          accessibilityHint={error || hint || rest.accessibilityHint}
          accessibilityState={{ disabled: rest.editable === false }}
          placeholderTextColor={Colors.placeholder}
          secureTextEntry={secure && !visible}
          multiline={multiline}
          onChangeText={t => {
            // Digitar também conta como atividade (o toque no teclado do sistema não chega à tela do app)
            bus.emit(Events.ACTIVITY);
            rest.onChangeText?.(t);
          }}
          onFocus={e => {
            setFocused(true);
            rest.onFocus?.(e);
          }}
          onBlur={e => {
            setFocused(false);
            rest.onBlur?.(e);
          }}
          style={[styles.input, mono && Type.mono, multiline && styles.inputMulti, style]}
        />
        {secure ? <EyeToggle visible={visible} onToggle={() => setVisible(v => !v)} /> : null}
        {right}
      </View>
      <InputMessage error={error} hint={hint} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Chips, badges, estados
// ---------------------------------------------------------------------------
export function Chip({ label, active, onPress, icon, color, onLongPress }: { label: string; active?: boolean; onPress?: () => void; icon?: string; color?: string; onLongPress?: () => void }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      onLongPress={onLongPress}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active }}
      hitSlop={{ top: 6, bottom: 6 }}
      style={[styles.chip, active && { backgroundColor: color || Colors.primary, borderColor: color || Colors.primary }]}
    >
      {icon ? <Icon name={icon} size={13} color={active ? '#fff' : color || Colors.textSecondary} style={styles.mr5} /> : null}
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

export function ChipRow({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.chipRow, style]}>
      {children}
    </ScrollView>
  );
}

export function Badge({ text, color = Colors.primary, bg = Colors.primarySoft, icon }: { text: string; color?: string; bg?: string; icon?: string }) {
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      {icon ? <Icon name={icon} size={12} color={color} style={styles.mr4} /> : null}
      <Text style={[styles.badgeText, { color }]}>{text}</Text>
    </View>
  );
}

export function EmptyState({ icon, title, message, action }: { icon: string; title: string; message?: string; action?: React.ReactNode }) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Icon name={icon} size={30} color={Colors.primary} />
      </View>
      <Text style={[Type.h3, styles.center]} accessibilityRole="header">
        {title}
      </Text>
      {message ? <Text style={[Type.small, styles.emptyMsg]}>{message}</Text> : null}
      {action ? <View style={styles.mt16}>{action}</View> : null}
    </View>
  );
}

const BANNER_TONES = {
  info: { bg: Colors.infoBg, fg: Colors.info, icon: 'info', border: '#BFDBFE' },
  warning: { bg: Colors.warningBg, fg: Colors.warning, icon: 'alert-triangle', border: '#FDE68A' },
  danger: { bg: Colors.dangerBg, fg: Colors.danger, icon: 'alert-octagon', border: '#FECACA' },
  success: { bg: Colors.successBg, fg: Colors.success, icon: 'check-circle', border: '#BBF7D0' },
};

export function Banner({ icon, text, tone = 'info', onPress, title }: { icon?: string; text: string; tone?: 'info' | 'warning' | 'danger' | 'success'; onPress?: () => void; title?: string }) {
  const t = BANNER_TONES[tone];
  const body = (
    <View style={[styles.banner, { backgroundColor: t.bg, borderColor: t.border }]}>
      <Icon name={icon || t.icon} size={18} color={t.fg} style={styles.bannerIcon} />
      <View style={styles.flex}>
        {title ? <Text style={[Type.bodyStrong, styles.bannerTitle, { color: t.fg }]}>{title}</Text> : null}
        <Text style={[Type.small, styles.textMain]}>{text}</Text>
      </View>
      {onPress ? <Icon name="chevron-right" size={18} color={t.fg} /> : null}
    </View>
  );
  const label = [title, text].filter(Boolean).join('. ');
  return onPress ? (
    <TouchableOpacity activeOpacity={0.8} onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
      {body}
    </TouchableOpacity>
  ) : (
    <View accessible accessibilityLabel={label} accessibilityRole={tone === 'danger' || tone === 'warning' ? 'alert' : 'text'}>
      {body}
    </View>
  );
}

export function ProgressBar({ value, color = Colors.primary, height = 8, label }: { value: number; color?: string; height?: number; label?: string }) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(v * 100) }}
      style={[styles.progressTrack, { height, borderRadius: height }]}
    >
      <View style={{ width: `${v * 100}%`, height, backgroundColor: color, borderRadius: height }} />
    </View>
  );
}

export function Divider() {
  return <View style={styles.divider} />;
}

export function Loading({ text }: { text?: string }) {
  return (
    <View style={styles.loading} accessible accessibilityRole="progressbar" accessibilityLabel={text || 'Carregando'}>
      <ActivityIndicator color={Colors.primary} size="large" />
      {text ? <Text style={[Type.small, styles.mt12]}>{text}</Text> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Folha inferior (modal)
// ---------------------------------------------------------------------------
export function Sheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title?: string; children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.sheetOverlay} onPress={onClose} accessibilityRole="button" accessibilityLabel="Fechar" importantForAccessibility="no" />
      <KeyboardAvoidingView behavior="padding">
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 20 }]} accessibilityViewIsModal>
          <View style={styles.sheetHandle} />
          <View style={styles.sheetHead}>
            {title ? (
              <Text style={[Type.h2, styles.flex]} accessibilityRole="header" numberOfLines={2}>
                {title}
              </Text>
            ) : (
              <View style={styles.flex} />
            )}
            <TouchableOpacity onPress={onClose} style={styles.sheetClose} accessibilityRole="button" accessibilityLabel="Fechar" hitSlop={Touch.hitSlop}>
              <Icon name="x" size={20} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" style={styles.sheetScroll} showsVerticalScrollIndicator={false}>
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function KeyValue({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.kv} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={Type.small}>{label}</Text>
      <Text style={[mono ? Type.mono : Type.bodyStrong, styles.kvValue]} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

export const START = 'flex-start' as const;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { textAlign: 'center' },
  mt2: { marginTop: 2 },
  mt4: { marginTop: 4 },
  mt12: { marginTop: 12 },
  mt16: { marginTop: 16 },
  mr4: { marginRight: 4 },
  mr5: { marginRight: 5 },
  mr8: { marginRight: 8 },
  mr10: { marginRight: 10 },
  ml6: { marginLeft: 6 },
  ml8: { marginLeft: 8 },
  disabled: { opacity: 0.5 },
  dangerText: { color: Colors.danger },
  textMain: { color: Colors.text },
  screen: { flex: 1, backgroundColor: Colors.background },
  header: { backgroundColor: Colors.background, paddingHorizontal: Spacing.lg, paddingBottom: Spacing.md },
  headerRow: { flexDirection: 'row', alignItems: 'center', minHeight: 48 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 8 },
  backBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', marginRight: 4, marginLeft: -10 },
  scrollContent: { paddingHorizontal: Spacing.lg, paddingTop: 4 },
  footer: { paddingHorizontal: Spacing.lg, paddingTop: 12, backgroundColor: Colors.background, borderTopWidth: 1, borderTopColor: Colors.borderLight },
  button: { minHeight: 52, borderRadius: Radius.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, paddingVertical: 10, borderWidth: 1 },
  buttonSmall: { minHeight: 44, paddingHorizontal: 14, paddingVertical: 8, borderRadius: Radius.sm },
  buttonText: { fontSize: 16, fontWeight: '700', textAlign: 'center' },
  buttonTextSmall: { fontSize: 14 },
  iconBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.borderLight },
  badgeDot: { position: 'absolute', top: -2, right: -2, minWidth: 18, height: 18, borderRadius: 9, backgroundColor: Colors.danger, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  badgeDotText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  fab: { position: 'absolute', right: 20, bottom: 24, width: 58, height: 58, borderRadius: 29, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  card: { backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.lg, borderWidth: 1, borderColor: Colors.borderLight, ...Shadow.card },
  listCard: { paddingVertical: 0, paddingHorizontal: 0, overflow: 'hidden' },
  section: { marginBottom: Spacing.xl },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.sm, marginLeft: 4 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.lg, paddingVertical: 13, minHeight: 56, backgroundColor: Colors.surface },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: Colors.divider },
  rowIcon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  inputContainer: { marginBottom: Spacing.lg },
  inputLabel: { marginBottom: 6 },
  inputWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.surface, borderRadius: Radius.md, borderWidth: 1.5, borderColor: Colors.borderStrong, paddingHorizontal: 14, minHeight: 52 },
  inputWrapMulti: { alignItems: START, minHeight: 96, paddingVertical: 10 },
  inputFocused: { borderColor: Colors.primary, borderWidth: 2 },
  inputError: { borderColor: Colors.danger },
  input: { flex: 1, fontSize: 15, color: Colors.text, paddingVertical: Platform.OS === 'android' ? 8 : 14 },
  inputMulti: { textAlignVertical: 'top', minHeight: 76 },
  eyeBtn: { paddingLeft: 8, minHeight: 44, justifyContent: 'center' },
  errorRow: { flexDirection: 'row', alignItems: 'center', marginTop: 5 },
  errorText: { color: Colors.danger, flex: 1 },
  chipRow: { paddingHorizontal: Spacing.lg, gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, minHeight: 36, paddingVertical: 6, borderRadius: Radius.pill, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  chipText: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary },
  chipTextActive: { color: '#fff', fontWeight: '700' },
  badge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 4, borderRadius: Radius.pill, alignSelf: START },
  badgeText: { fontSize: 12, fontWeight: '700' },
  empty: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: 24 },
  emptyIcon: { width: 72, height: 72, borderRadius: 36, backgroundColor: Colors.primarySoft, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  emptyMsg: { textAlign: 'center', marginTop: 6, maxWidth: 300 },
  banner: { flexDirection: 'row', alignItems: START, padding: 14, borderRadius: Radius.md, marginBottom: Spacing.md, borderWidth: 1 },
  bannerIcon: { marginRight: 10, marginTop: 1 },
  bannerTitle: { marginBottom: 2 },
  progressTrack: { backgroundColor: Colors.divider, overflow: 'hidden' },
  divider: { height: 1, backgroundColor: Colors.divider, marginVertical: Spacing.md },
  loading: { padding: 40, alignItems: 'center' },
  sheetOverlay: { flex: 1, backgroundColor: Colors.overlay },
  sheet: { backgroundColor: Colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: Spacing.xl, paddingTop: 10 },
  sheetHandle: { width: 44, height: 5, borderRadius: 3, backgroundColor: Colors.border, alignSelf: 'center', marginBottom: 10 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.md },
  sheetClose: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.surfaceAlt, marginLeft: 8 },
  sheetScroll: { maxHeight: 560 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8 },
  kvValue: { fontSize: 14, maxWidth: '60%', textAlign: 'right' },
});
