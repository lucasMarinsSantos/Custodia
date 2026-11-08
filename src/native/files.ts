// Ponte JS do módulo nativo CustodiaFiles (FilesModule.kt): escolher qualquer tipo de arquivo para anexar às
// notas seguras. O nativo só lê conteúdo entregue por um provedor (content://) e para de ler ao passar
// do limite pedido, então um arquivo gigante não chega a ocupar a memória do app.
// Também faz a exclusão segura dos arquivos temporários do app: sobrescreve com bytes aleatórios do
// mesmo tamanho antes de apagar, só dentro das pastas privadas do app.
// No Jest (sem o módulo nativo) existe uma fila simulada, controlada por `__queueMockFile`, e um "disco" em memória
// para os temporários (`__mockTempFiles`).

import { NativeModules } from 'react-native';
import { ExternalActivity, PickedFile } from './index';

const M: any = NativeModules || {};

let mockQueue: (PickedFile | Error | null)[] = [];

/** Apenas para testes: o próximo `pickFile` devolve este arquivo (ou lança o erro). */
export function __queueMockFile(file: PickedFile | Error | null) {
  mockQueue.push(file);
}

/** Apenas para testes: temporários simulados (caminho → conteúdo). */
export const __mockTempFiles = new Map<string, string>();
const MOCK_TEMP_DIR = '/data/user/0/com.custodia.sprint2/cache/custodia-tmp';

export function __resetMockFiles() {
  mockQueue = [];
  __mockTempFiles.clear();
}

export const Files = {
  /** Abre o seletor de documentos do Android. Devolve null se o usuário cancelar. */
  async pickFile(maxBytes: number): Promise<PickedFile | null> {
    if (M.CustodiaFiles) {
      // O seletor leva o app para segundo plano: não deve disparar o bloqueio por "app minimizado"
      ExternalActivity.count++;
      try {
        return await M.CustodiaFiles.pickFile(maxBytes);
      } finally {
        ExternalActivity.count = Math.max(0, ExternalActivity.count - 1);
        ExternalActivity.lastEnded = Date.now();
      }
    }
    const next = mockQueue.shift() ?? null;
    if (next instanceof Error) throw next;
    return next;
  },

  /** Pasta privada dos temporários do app (cache/custodia-tmp). */
  async tempPath(): Promise<string> {
    if (M.CustodiaFiles) return M.CustodiaFiles.tempPath();
    return MOCK_TEMP_DIR;
  },

  /** Exclusão segura de um arquivo do app; recusa caminhos fora das pastas privadas. */
  async secureDelete(path: string): Promise<boolean> {
    if (M.CustodiaFiles) return M.CustodiaFiles.secureDelete(path);
    if (!String(path).startsWith(`${MOCK_TEMP_DIR}/`) || String(path).includes('..')) throw new Error('Caminho fora da área do aplicativo');
    return __mockTempFiles.delete(path);
  },

  /** Apaga com segurança todos os temporários; devolve quantos arquivos foram apagados. */
  async wipeTemp(): Promise<number> {
    if (M.CustodiaFiles) return M.CustodiaFiles.wipeTemp();
    const n = __mockTempFiles.size;
    __mockTempFiles.clear();
    return n;
  },

  get available(): boolean {
    return !!M.CustodiaFiles;
  },
};
