// QR Code desenhado com Views (sem SVG nem biblioteca nativa).
// Cada sequência de módulos escuros de uma linha vira um único retângulo, o que reduz o número de Views
// (uma versão 7 tem 45×45 módulos, mas só algumas centenas de sequências).
import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { encodeQr } from '../utils/qrcode';

/** Zona de silêncio exigida pela norma: 4 módulos claros em volta. */
const QUIET = 4;

export function QrCode({ value, size = 220, accessibilityLabel }: { value: string; size?: number; accessibilityLabel?: string }) {
  const runs = useMemo(() => {
    const qr = encodeQr(value);
    const cell = size / (qr.size + QUIET * 2);
    const out: { key: string; left: number; top: number; width: number; height: number }[] = [];
    qr.modules.forEach((row, r) => {
      let start = -1;
      for (let c = 0; c <= row.length; c++) {
        const dark = c < row.length && row[c];
        if (dark && start < 0) start = c;
        if (!dark && start >= 0) {
          out.push({ key: `${r}-${start}`, left: (start + QUIET) * cell, top: (r + QUIET) * cell, width: (c - start) * cell, height: cell });
          start = -1;
        }
      }
    });
    return out;
  }, [value, size]);

  return (
    <View style={[styles.box, { width: size, height: size }]} accessible accessibilityRole="image" accessibilityLabel={accessibilityLabel || 'QR Code'}>
      {runs.map(({ key, ...rect }) => (
        // A altura arredondada para cima evita frestas claras entre as linhas em telas de densidade fracionária
        <View key={key} style={[styles.dark, { left: rect.left, top: rect.top, width: rect.width + 0.5, height: rect.height + 0.5 }]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // O QR fica sempre preto no branco (também no tema escuro): os leitores esperam esse contraste
  box: { backgroundColor: '#FFFFFF', borderRadius: 8, overflow: 'hidden', alignSelf: 'center' },
  dark: { position: 'absolute', backgroundColor: '#000000' },
});
