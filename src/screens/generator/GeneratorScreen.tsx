// Gerador de senhas: comprimento ajustável, classes de caracteres, sem ambíguos,
// pronunciáveis. Usa o gerador aleatório criptográfico; as preferências ficam no banco cifrado.
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Button, Card, Icon, ListCard, Screen, Section, ToggleRow } from '../../components/ui';
import { Slider, StrengthMeter } from '../../components/widgets';
import { Colors, Touch, Type } from '../../theme';
import { DefaultPasswordOptions, PasswordOptions } from '../../services/PasswordService';
import { ClipboardService } from '../../services/ClipboardService';
import { vaultDb } from '../../db/Database';
import { toast } from '../../services/events';
import { DictionaryService } from '../../services/DictionaryService';
import { DictionaryWarning } from '../../components/DictionaryWarning';

const Colored = memo(function ColoredPassword({ pw }: { pw: string }) {
  return (
    <Text
      style={[styles.pw, pw.length > 28 && styles.pwLong]}
      selectable
      accessibilityLabel={pw ? `Senha gerada: ${pw.split('').join(' ')}` : 'Gerando senha'}
    >
      {pw.split('').map((ch, i) => (
        <Text key={i} style={/[0-9]/.test(ch) ? styles.pwDigit : /[^A-Za-z0-9]/.test(ch) ? styles.pwSymbol : undefined}>
          {ch}
        </Text>
      ))}
    </Text>
  );
});

export default function GeneratorScreen({ navigation, route }: any) {
  const returnTo: string | undefined = route?.params?.returnTo;
  const [opts, setOpts] = useState<PasswordOptions>({ ...DefaultPasswordOptions });
  const [pw, setPw] = useState('');
  const [history, setHistory] = useState<string[]>([]);

  const regenerate = useCallback((o: PasswordOptions = opts) => {
    // a senha gerada é testada contra o dicionário e sorteada de novo se cair nele
    const p = DictionaryService.generate(o);
    setPw(p);
    setHistory(h => [p, ...h.filter(x => x !== p)].slice(0, 5));
  }, [opts]);

  useEffect(() => {
    (async () => {
      let o = { ...DefaultPasswordOptions };
      try {
        const raw = vaultDb.isOpen ? await vaultDb.getKv('generatorPrefs') : null;
        if (raw) o = { ...o, ...JSON.parse(raw) };
      } catch {
        // padrão
      }
      setOpts(o);
      regenerate(o);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persistência com debounce: arrastar o controle deslizante dispara dezenas de mudanças por segundo.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPrefs = useRef<PasswordOptions | null>(null);
  const persist = (o: PasswordOptions) => {
    pendingPrefs.current = null;
    if (vaultDb.isOpen) vaultDb.setKv('generatorPrefs', JSON.stringify(o)).catch(e => console.warn('[Gerador] falha ao salvar preferências', e));
  };
  // Ao sair da tela antes do debounce, grava imediatamente a última alteração (não descarta).
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (pendingPrefs.current) persist(pendingPrefs.current);
    },
    [],
  );
  const update = (patch: Partial<PasswordOptions>) => {
    const o = { ...opts, ...patch };
    if (!o.uppercase && !o.lowercase && !o.numbers && !o.symbols) {
      o.lowercase = true;
      toast('Pelo menos um tipo de caractere precisa ficar ativo', 'info');
    }
    setOpts(o);
    regenerate(o);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    pendingPrefs.current = o;
    saveTimer.current = setTimeout(() => persist(o), 400);
  };

  return (
    <Screen
      title={returnTo ? 'Gerar senha' : 'Gerador de Senhas'}
      large={!returnTo}
      onBack={returnTo ? () => navigation.goBack() : undefined}
      footer={
        returnTo ? (
          <Button
            title="Usar esta senha"
            icon="check"
            onPress={() => navigation.popTo(returnTo, { generated: pw }, { merge: true })}
          />
        ) : undefined
      }
    >
      <Card style={styles.pwCard}>
        <View style={styles.pwBox}>
          <Colored pw={pw} />
        </View>
        <View style={styles.meter}>
          <StrengthMeter password={pw} showFeedback={false} />
        </View>
        <DictionaryWarning password={pw} />
        <View style={styles.actions}>
          <Button small variant="outline" icon="refresh-cw" title="Nova senha" onPress={() => regenerate()} />
          <Button small icon="copy" title="Copiar" onPress={() => ClipboardService.copy(pw, 'Senha')} />
        </View>
      </Card>

      <Section title={`Comprimento: ${opts.length} caracteres`}>
        <Card style={styles.lengthCard}>
          <TouchableOpacity
            onPress={() => update({ length: Math.max(8, opts.length - 1) })}
            disabled={opts.length <= 8}
            style={[styles.stepBtn, opts.length <= 8 && styles.disabled]}
            hitSlop={Touch.hitSlop}
            accessibilityRole="button"
            accessibilityLabel="Diminuir comprimento"
            accessibilityState={{ disabled: opts.length <= 8 }}
          >
            <Icon name="minus" size={18} color={Colors.text} />
          </TouchableOpacity>
          <View style={styles.sliderBox}>
            <Slider value={opts.length} min={8} max={64} label="Comprimento da senha" onChange={v => v !== opts.length && update({ length: v })} />
          </View>
          <TouchableOpacity
            onPress={() => update({ length: Math.min(64, opts.length + 1) })}
            disabled={opts.length >= 64}
            style={[styles.stepBtn, opts.length >= 64 && styles.disabled]}
            hitSlop={Touch.hitSlop}
            accessibilityRole="button"
            accessibilityLabel="Aumentar comprimento"
            accessibilityState={{ disabled: opts.length >= 64 }}
          >
            <Icon name="plus" size={18} color={Colors.text} />
          </TouchableOpacity>
        </Card>
      </Section>

      <ListCard style={styles.toggles}>
        <ToggleRow icon="type" title="Maiúsculas (A–Z)" value={opts.uppercase} onChange={v => update({ uppercase: v })} />
        <ToggleRow icon="type" title="Minúsculas (a–z)" value={opts.lowercase} onChange={v => update({ lowercase: v })} />
        <ToggleRow icon="hash" title="Números (0–9)" value={opts.numbers} onChange={v => update({ numbers: v })} />
        <ToggleRow icon="at-sign" title="Símbolos especiais (!@#)" value={opts.symbols} onChange={v => update({ symbols: v })} />
        <ToggleRow icon="eye-off" title="Evitar ambíguos" subtitle="Remove O/0, l/1/I e similares" value={opts.avoidAmbiguous} onChange={v => update({ avoidAmbiguous: v })} />
        <ToggleRow icon="mic" title="Pronunciável" subtitle="Sílabas fáceis de digitar manualmente" value={opts.pronounceable} onChange={v => update({ pronounceable: v })} last />
      </ListCard>

      {history.length > 1 ? (
        <Section title="Geradas nesta sessão">
          <ListCard>
            {history.slice(1).map((h, i) => (
              <TouchableOpacity
                key={h + i}
                onPress={() => ClipboardService.copy(h, 'Senha')}
                style={[styles.histRow, i < history.length - 2 && styles.histBorder]}
                accessibilityRole="button"
                accessibilityLabel={`Copiar senha anterior ${i + 1}`}
              >
                <Text style={[Type.mono, styles.histText]} numberOfLines={1}>
                  {h}
                </Text>
                <Icon name="copy" size={16} color={Colors.primary} />
              </TouchableOpacity>
            ))}
          </ListCard>
        </Section>
      ) : null}

    </Screen>
  );
}

const styles = StyleSheet.create({
  pwCard: { alignItems: 'center', paddingVertical: 22, marginBottom: 14 },
  pwBox: { minHeight: 64, justifyContent: 'center' },
  meter: { alignSelf: 'stretch', marginTop: 14 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 16 },
  lengthCard: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  sliderBox: { flex: 1, marginHorizontal: 8 },
  toggles: { marginBottom: 20 },
  histText: { flex: 1, fontSize: 13 },
  pw: { fontFamily: 'monospace', fontSize: 22, fontWeight: '700', textAlign: 'center', letterSpacing: 1, lineHeight: 32, color: Colors.text },
  pwLong: { fontSize: 17 },
  pwDigit: { color: Colors.info },
  pwSymbol: { color: Colors.orange },
  stepBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.surfaceAlt },
  disabled: { opacity: 0.4 },
  histRow: { flexDirection: 'row', alignItems: 'center', padding: 14, minHeight: 48 },
  histBorder: { borderBottomWidth: 1, borderBottomColor: Colors.divider },
});
