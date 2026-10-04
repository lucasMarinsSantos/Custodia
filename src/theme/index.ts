// Cores, tipografia e espaçamentos (baseado nos mockups)
//
// Tokens revisados para WCAG 2.1 AA:
// - texto normal ≥ 4,5:1 sobre `surface` (#FFF) e `background` (#F4F7FB);
// - componentes de interface (bordas de campos, trilhas) ≥ 3:1 quando carregam significado;
// - cores "vivas" (StrengthColors, accent) ficam para barras/pontos; texto usa as variantes *Text.
import { Platform, TextStyle } from 'react-native';
import { PasswordStrength } from '../types/models';

export const Colors = {
  background: '#F4F7FB',
  surface: '#FFFFFF',
  surfaceAlt: '#F8FAFC',
  primary: '#0F766E', // branco sobre ele: 5,5:1
  primaryDark: '#115E59',
  primaryLight: '#CCFBF1',
  primarySoft: '#E6FAF6',
  accent: '#14B8A6', // decorativo (trilhas, destaques), não usar como cor de texto
  navy: '#0D1B2A',
  navyLight: '#1E293B',
  text: '#0F172A',
  textSecondary: '#475569', // 7,0:1 sobre background
  textTertiary: '#5B6B82', // 5,0:1 sobre background
  textOnPrimary: '#FFFFFF',
  border: '#E2E8F0', // divisórias e cartões (decorativo)
  borderStrong: '#7C8BA1', // contorno de campos de entrada (3,5:1)
  borderLight: '#EEF2F6',
  divider: '#F1F5F9',
  success: '#15803D',
  successBg: '#F0FDF4',
  warning: '#B45309',
  warningBg: '#FFFBEB',
  orange: '#C2410C',
  orangeBg: '#FFF7ED',
  danger: '#B91C1C',
  dangerBg: '#FEF2F2',
  info: '#1D4ED8',
  infoBg: '#EFF6FF',
  purple: '#6D28D9',
  purpleBg: '#F5F3FF',
  gold: '#CA8A04',
  overlay: 'rgba(15, 23, 42, 0.5)',
  placeholder: '#64748B',
  disabled: '#CBD5E1',
};

/** Cores vivas para barras, pontos e gráficos (elementos não textuais acompanhados de rótulo). */
export const StrengthColors: Record<PasswordStrength, string> = {
  critical: '#DC2626',
  weak: '#F97316',
  medium: '#EAB308',
  strong: '#22C55E',
  very_strong: '#0D9488',
};

/** Variantes legíveis (≥ 4,5:1 sobre branco) para rótulos de força. */
export const StrengthTextColors: Record<PasswordStrength, string> = {
  critical: '#B91C1C',
  weak: '#C2410C',
  medium: '#A16207',
  strong: '#15803D',
  very_strong: '#0F766E',
};

/** Cor associada a uma pontuação 0–100 (texto legível). */
export function scoreColor(score: number): string {
  if (score >= 85) return StrengthTextColors.very_strong;
  if (score >= 65) return StrengthTextColors.strong;
  if (score >= 45) return StrengthTextColors.medium;
  if (score >= 25) return StrengthTextColors.weak;
  return StrengthTextColors.critical;
}

export const Spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 };
export const Radius = { sm: 8, md: 12, lg: 16, xl: 20, pill: 999 };

/** Alvo mínimo de toque (Material: 48dp; WCAG 2.5.5: 44pt). */
export const Touch = { min: 48, hitSlop: { top: 8, bottom: 8, left: 8, right: 8 } };

const mono = Platform.select({ android: 'monospace', default: 'Courier' });

export const Type: Record<string, TextStyle> = {
  display: { fontSize: 30, fontWeight: '800', color: Colors.text, letterSpacing: -0.6 },
  h1: { fontSize: 26, fontWeight: '800', color: Colors.text, letterSpacing: -0.5 },
  h2: { fontSize: 20, fontWeight: '700', color: Colors.text, letterSpacing: -0.2 },
  h3: { fontSize: 17, fontWeight: '700', color: Colors.text },
  body: { fontSize: 15, fontWeight: '400', color: Colors.text, lineHeight: 22 },
  bodyStrong: { fontSize: 15, fontWeight: '600', color: Colors.text },
  small: { fontSize: 13, fontWeight: '400', color: Colors.textSecondary, lineHeight: 19 },
  caption: { fontSize: 12, fontWeight: '500', color: Colors.textTertiary, lineHeight: 16 },
  label: { fontSize: 11, fontWeight: '700', color: Colors.textTertiary, letterSpacing: 0.8, textTransform: 'uppercase' },
  mono: { fontFamily: mono, fontSize: 16, color: Colors.text, letterSpacing: 0.5 },
  monoLarge: { fontFamily: mono, fontSize: 22, fontWeight: '700', color: Colors.text, letterSpacing: 1 },
};

export const Shadow = {
  card: {
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 12,
    elevation: 2,
  },
  raised: {
    shadowColor: '#0F766E',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.28,
    shadowRadius: 14,
    elevation: 8,
  },
};

/** Paleta de avatares: todas com contraste ≥ 4,5:1 para a inicial em branco. */
export const AvatarPalette = ['#DC2626', '#C2410C', '#A16207', '#15803D', '#0F766E', '#0369A1', '#1D4ED8', '#4F46E5', '#7C3AED', '#BE185D'];

/** Hash estável (djb2 sem operadores bit a bit) → cor da paleta. */
export function colorFor(name: string): string {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = (h * 33 + name.charCodeAt(i)) % 2147483647;
  return AvatarPalette[Math.abs(h) % AvatarPalette.length];
}
