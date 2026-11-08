// Botões "Escanear texto com a câmera" e "Ler captura de tela" do cadastro de credencial
// O texto reconhecido vira sugestão: os campos são preenchidos na tela e o usuário revisa antes de salvar.
// Nada é gravado aqui, e o texto bruto do OCR não fica guardado no estado da tela.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Banner, Button, ListCard, Row, Sheet } from './ui';
import { OcrCandidate, OcrOutcome, OcrService, toPrefill } from '../services/OcrService';
import { toast } from '../services/events';
import { Credential } from '../types/models';

export type OcrSource = 'camera' | 'gallery';

export const OCR_FILLED = 'Campos preenchidos com o texto reconhecido. Revise antes de salvar.';

/** Junta a sugestão ao formulário sem apagar o que o usuário já digitou com valores vazios. */
export function mergePrefill<T extends Partial<Credential>>(prev: T, p: Partial<Credential>): T {
  const out: any = { ...prev };
  for (const [k, v] of Object.entries(p)) if (typeof v === 'string' && v) out[k] = v;
  return out;
}

const mask = (s: string) => (s ? '•'.repeat(Math.min(12, s.length)) : 'sem senha');

export function OcrScan({ onApply, autoStart }: { onApply: (p: Partial<Credential>) => void; autoStart?: OcrSource }) {
  const [busy, setBusy] = useState<OcrSource | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [choices, setChoices] = useState<OcrCandidate[]>([]);
  const started = useRef(false);

  const apply = useCallback(
    (c: OcrCandidate) => {
      setChoices([]);
      onApply(toPrefill(c));
      toast(OCR_FILLED, 'success');
    },
    [onApply],
  );

  const handle = useCallback(
    (out: OcrOutcome | null) => {
      if (!out) return; // cancelado
      if (out.problem) {
        setProblem(out.problem);
        toast(out.problem, 'error');
        return;
      }
      setProblem(null);
      if (out.candidates.length === 1) apply(out.candidates[0]);
      else setChoices(out.candidates);
    },
    [apply],
  );

  const scan = useCallback(
    async (source: OcrSource) => {
      setBusy(source);
      try {
        handle(source === 'camera' ? await OcrService.fromCamera() : await OcrService.fromGallery());
      } catch (e: any) {
        toast(e?.message || 'Não foi possível reconhecer o texto da imagem', 'error');
      } finally {
        setBusy(null);
      }
    },
    [handle],
  );

  useEffect(() => {
    if (autoStart && !started.current) {
      started.current = true;
      scan(autoStart);
    }
  }, [autoStart, scan]);

  return (
    <View style={styles.box}>
      <View style={styles.row}>
        <Button title="Escanear texto com a câmera" icon="camera" variant="outline" small loading={busy === 'camera'} disabled={!!busy} onPress={() => scan('camera')} style={styles.flex} />
        <Button title="Ler captura de tela" icon="image" variant="outline" small loading={busy === 'gallery'} disabled={!!busy} onPress={() => scan('gallery')} style={styles.flex} />
      </View>
      {problem ? <Banner tone="warning" icon="sun" text={problem} /> : null}
      <Sheet visible={choices.length > 1} onClose={() => setChoices([])} title={`${choices.length} contas reconhecidas`}>
        <Banner tone="info" text="Escolha qual conta usar para preencher o cadastro. O reconhecimento acontece no aparelho e a imagem não é salva." />
        <ListCard>
          {choices.map((c, i) => (
            <Row key={`${c.username}-${i}`} icon={c.wifi ? 'wifi' : 'key'} title={c.title} subtitle={`${c.username || 'sem usuário'} • ${mask(c.password)}`} onPress={() => apply(c)} chevron last={i === choices.length - 1} />
          ))}
        </ListCard>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { marginBottom: 12 },
  row: { flexDirection: 'row', gap: 8 },
  flex: { flex: 1 },
});
