// Ponte JS do módulo nativo CustodiaOcr (OcrModule.kt): câmera/galeria + Tesseract local (por+eng).
// A imagem não passa pela ponte: o Kotlin captura, reconhece, apaga o arquivo temporário e devolve só o texto.

import { NativeModules } from 'react-native';
import { withExternal } from './transfer';

const M: any = NativeModules || {};

export interface OcrRawResult {
  text: string;
  /** Confiança média do Tesseract (0–100); -1 se indisponível. */
  confidence: number;
  /** Luminância média da imagem (0–255); -1 se indisponível. Usada para o aviso de foto escura. */
  brightness: number;
}

const queue: (OcrRawResult | null)[] = [];

/** Apenas para testes: o próximo recognize devolve este resultado (null = usuário cancelou). */
export function __queueOcrResult(r: OcrRawResult | null) {
  queue.push(r);
}

export const Ocr = {
  isAvailable(): boolean {
    return !!M.CustodiaOcr;
  },

  /** Captura pela câmera do sistema ou escolhe uma imagem da galeria e reconhece o texto. null = cancelado. */
  async recognize(source: 'camera' | 'gallery'): Promise<OcrRawResult | null> {
    if (M.CustodiaOcr) {
      return withExternal(() => (source === 'camera' ? M.CustodiaOcr.recognizeCamera('por+eng') : M.CustodiaOcr.recognizeGallery('por+eng')));
    }
    if (queue.length) return queue.shift() ?? null;
    throw new Error('OCR indisponível neste ambiente');
  },
};
