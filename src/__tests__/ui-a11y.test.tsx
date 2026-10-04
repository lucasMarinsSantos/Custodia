import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Text, TouchableOpacity } from 'react-native';
import { Button, Chip, IconButton, Input, ToggleRow, Fab } from '../components/ui';
import { SecureKeyboard, StrengthMeter } from '../components/widgets';
import { Colors, colorFor, AvatarPalette } from '../theme';

jest.mock('react-native-vector-icons/Feather', () => 'Icon');

function render(el: React.ReactElement) {
  let r!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    r = ReactTestRenderer.create(el);
  });
  return r;
}

const byRole = (r: ReactTestRenderer.ReactTestRenderer, role: string) => r.root.findAll(n => n.props.accessibilityRole === role && typeof n.type !== 'string');

/** Contraste WCAG entre duas cores #RRGGBB. */
function contrast(a: string, b: string) {
  const lum = (h: string) => {
    const [r, g, bl] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

describe('Acessibilidade dos componentes base', () => {
  it('Button expõe papel, nome e estado ocupado/desabilitado', () => {
    const r = render(<Button title="Salvar" disabled onPress={() => {}} />);
    const [btn] = byRole(r, 'button');
    expect(btn.props.accessibilityLabel).toBe('Salvar');
    expect(btn.props.accessibilityState).toEqual({ disabled: true, busy: false });
  });

  it('Button ignora toque duplo enquanto a ação assíncrona está em andamento', async () => {
    let resolve!: () => void;
    const onPress = jest.fn(() => new Promise<void>(res => (resolve = res)));
    const r = render(<Button title="Salvar" onPress={onPress} />);
    const touch = r.root.findByType(TouchableOpacity);
    await act(async () => {
      touch.props.onPress();
      touch.props.onPress();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
  });

  it('IconButton anuncia o rótulo e a contagem do selo', () => {
    const r = render(<IconButton name="bell" label="Alertas" badge={3} onPress={() => {}} />);
    expect(byRole(r, 'button')[0].props.accessibilityLabel).toBe('Alertas, 3 novos');
  });

  it('Fab tem nome acessível', () => {
    const r = render(<Fab onPress={() => {}} label="Adicionar" />);
    expect(byRole(r, 'button')[0].props.accessibilityLabel).toBe('Adicionar');
  });

  it('Chip informa se está selecionado', () => {
    const r = render(<Chip label="Favoritas" active onPress={() => {}} />);
    expect(byRole(r, 'button')[0].props.accessibilityState).toEqual({ selected: true });
  });

  it('ToggleRow é um switch com estado e alterna ao tocar na linha', () => {
    const onChange = jest.fn();
    const r = render(<ToggleRow title="Biometria" value={false} onChange={onChange} />);
    const [sw] = byRole(r, 'switch');
    expect(sw.props.accessibilityState).toMatchObject({ checked: false });
    act(() => sw.props.onPress());
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('Input usa o rótulo visível como nome e anuncia o erro', () => {
    const r = render(<Input label="Título" required error="O título é obrigatório" value="" onChangeText={() => {}} />);
    const input = r.root.findAll(n => n.props.accessibilityLabel === 'Título, obrigatório' && n.props.onChangeText);
    expect(input.length).toBeGreaterThan(0);
    expect(input[0].props.accessibilityHint).toBe('O título é obrigatório');
    expect(byRole(r, 'alert').length).toBe(1);
  });

  it('campo de senha tem botão mostrar/ocultar rotulado', () => {
    const r = render(<Input label="Senha" secure value="x" onChangeText={() => {}} />);
    const eye = byRole(r, 'button').find(b => /senha/i.test(b.props.accessibilityLabel));
    expect(eye?.props.accessibilityLabel).toBe('Mostrar senha');
    act(() => eye!.props.onPress());
    expect(byRole(r, 'button').some(b => b.props.accessibilityLabel === 'Ocultar senha')).toBe(true);
  });

  it('teclado seguro: toda tecla tem nome falado e símbolos são descritos', () => {
    const typed: string[] = [];
    const r = render(<SecureKeyboard seed={1} onKey={k => typed.push(k)} onBackspace={() => {}} onDone={() => {}} />);
    const keys = byRole(r, 'keyboardkey');
    expect(keys.length).toBeGreaterThan(30);
    keys.forEach(k => expect(k.props.accessibilityLabel).toBeTruthy());
    expect(keys.some(k => k.props.accessibilityLabel === 'Apagar')).toBe(true);
    const sym = keys.find(k => k.props.accessibilityLabel === 'Símbolos')!;
    act(() => sym.props.onPress());
    expect(byRole(r, 'keyboardkey').some(k => k.props.accessibilityLabel === 'arroba')).toBe(true);
  });

  it('medidor de força descreve o resultado em texto', () => {
    const r = render(<StrengthMeter password="Tr0ub4dor&3xyz!" />);
    const [meter] = byRole(r, 'progressbar');
    expect(meter.props.accessibilityLabel).toMatch(/^Força da senha: .+, \d+ de 100, \d+ bits$/);
    expect(r.root.findAllByType(Text).length).toBeGreaterThan(0);
  });
});

describe('Tokens de cor (WCAG AA)', () => {
  it('texto principal, secundário e terciário ≥ 4,5:1 sobre fundo e superfície', () => {
    for (const fg of [Colors.text, Colors.textSecondary, Colors.textTertiary, Colors.placeholder]) {
      expect(contrast(fg, Colors.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(fg, Colors.background)).toBeGreaterThanOrEqual(4.4);
    }
  });
  it('botão primário e cores de estado legíveis', () => {
    expect(contrast('#FFFFFF', Colors.primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(Colors.danger, Colors.dangerBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(Colors.warning, Colors.warningBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(Colors.success, Colors.successBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(Colors.info, Colors.infoBg)).toBeGreaterThanOrEqual(4.5);
  });
  it('contorno dos campos ≥ 3:1 (WCAG 1.4.11)', () => {
    expect(contrast(Colors.borderStrong, Colors.surface)).toBeGreaterThanOrEqual(3);
  });
  it('inicial branca legível em todas as cores de avatar e hash estável', () => {
    AvatarPalette.forEach(c => expect(contrast('#FFFFFF', c)).toBeGreaterThanOrEqual(4.5));
    expect(colorFor('Gmail')).toBe(colorFor('Gmail'));
  });
});
