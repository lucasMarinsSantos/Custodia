// Ponte JS do módulo nativo CustodiaTransfer (TransferModule.kt): seletor de arquivo para importar e restaurar.
// No Jest (sem módulo nativo) usa uma fila em memória preenchida pelos testes.

import { NativeModules } from 'react-native';
import { ExternalActivity, PickedFile } from './index';

const M: any = NativeModules || {};

/**
 * Marca uma atividade externa (seletor, câmera, conta Google): o app vai para segundo plano por um momento e o
 * bloqueio por "app minimizado" não deve disparar. Mesmo contador usado por System.pickImage/saveFile.
 */
export async function withExternal<T>(fn: () => Promise<T>): Promise<T> {
  ExternalActivity.count++;
  try {
    return await fn();
  } finally {
    ExternalActivity.count = Math.max(0, ExternalActivity.count - 1);
    ExternalActivity.lastEnded = Date.now();
  }
}

const queue: (PickedFile | null)[] = [];

/** Apenas para testes: o próximo pickFile devolve este arquivo (null = usuário cancelou). */
export function __queuePickedFile(file: PickedFile | null) {
  queue.push(file);
}

export const Transfer = {
  /**
   * Abre o seletor de documentos (SAF, ACTION_OPEN_DOCUMENT) e lê o arquivo escolhido.
   * Só aceita content:// e recusa arquivos acima de `maxBytes`. null = cancelado.
   */
  async pickFile(mimeTypes: string[], maxBytes: number): Promise<PickedFile | null> {
    if (M.CustodiaTransfer) return withExternal(() => M.CustodiaTransfer.pickFile(mimeTypes, maxBytes));
    const f = queue.shift() ?? null;
    if (f && f.size > maxBytes) throw new Error(`Arquivo maior que ${Math.round(maxBytes / 1024 / 1024)} MB`);
    return f;
  },
};
