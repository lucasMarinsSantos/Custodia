// Ponte para os módulos nativos Android (Kotlin)
//  • CustodiaSecurity: Android Keystore, preferências cifradas, biometria, PBKDF2, SecureRandom, SHA-256 de arquivo
//  • CustodiaSystem:   área de transferência segura, sensores de bloqueio, arquivos, ícone do launcher
// Cada função tem um fallback em memória para os testes (Jest) e ambientes sem o módulo nativo.

import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

const M: any = NativeModules || {};

export const hasNative = (name: string): boolean => !!M[name];

// ---------------------------------------------------------------------------
// Fallbacks (somente para testes / desenvolvimento)
// ---------------------------------------------------------------------------
const memPrefs = new Map<string, string>();

function fallbackRandom(size: number): string {
  const arr = new Uint8Array(size);
  const g: any = globalThis as any;
  if (g.crypto?.getRandomValues) g.crypto.getRandomValues(arr);
  else throw new Error('Gerador aleatório seguro indisponível');
  // @ts-ignore Buffer existe no Jest (Node)
  return Buffer.from(arr).toString('base64');
}

/** Apenas para testes: limpa o armazenamento simulado do Keystore. */
export function __resetNativeMocks() {
  memPrefs.clear();
}

// ---------------------------------------------------------------------------
// Segurança: Keystore, biometria, PBKDF2, SecureRandom
// ---------------------------------------------------------------------------
export const Security = {
  /** Grava um valor cifrado com AES-256-GCM por uma chave do Android Keystore. */
  async secureSet(key: string, value: string): Promise<void> {
    if (M.CustodiaSecurity) return M.CustodiaSecurity.secureSet(key, value);
    memPrefs.set(key, value);
  },
  async secureGet(key: string): Promise<string | null> {
    if (M.CustodiaSecurity) return M.CustodiaSecurity.secureGet(key);
    return memPrefs.has(key) ? (memPrefs.get(key) as string) : null;
  },
  async secureRemove(key: string): Promise<void> {
    if (M.CustodiaSecurity) return M.CustodiaSecurity.secureRemove(key);
    memPrefs.delete(key);
  },
  async secureKeys(prefix: string): Promise<string[]> {
    if (M.CustodiaSecurity) return M.CustodiaSecurity.secureKeys(prefix);
    return [...memPrefs.keys()].filter(k => k.startsWith(prefix));
  },
  /** PBKDF2-HMAC-SHA256 nativo (javax.crypto). Entradas/saídas em base64. */
  async pbkdf2(passwordB64: string, saltB64: string, iterations: number, keyLen: number): Promise<string | null> {
    if (M.CustodiaSecurity) return M.CustodiaSecurity.pbkdf2(passwordB64, saltB64, iterations, keyLen);
    return null;
  },
  /** Bytes aleatórios do SecureRandom do Android. */
  async randomBytes(size: number): Promise<string> {
    if (M.CustodiaSecurity) return M.CustodiaSecurity.randomBytes(size);
    return fallbackRandom(size);
  },
  /** true quando a chave do Keystore está em hardware seguro (TEE/StrongBox). */
  async isHardwareBacked(): Promise<boolean> {
    if (M.CustodiaSecurity) return M.CustodiaSecurity.isHardwareBacked();
    return false;
  },
  async biometricAvailable(): Promise<{ available: boolean; reason?: string }> {
    if (M.CustodiaSecurity) return M.CustodiaSecurity.biometricAvailable();
    return { available: false, reason: 'Módulo nativo indisponível' };
  },
  /** Cifra um segredo com chave do Keystore vinculada à biometria (exige digital/rosto). */
  async biometricEnroll(alias: string, secretB64: string, title: string, subtitle: string): Promise<void> {
    if (M.CustodiaSecurity) return M.CustodiaSecurity.biometricEnroll(alias, secretB64, title, subtitle);
    memPrefs.set('bio:' + alias, secretB64);
  },
  async biometricUnlock(alias: string, title: string, subtitle: string): Promise<string> {
    if (M.CustodiaSecurity) return M.CustodiaSecurity.biometricUnlock(alias, title, subtitle);
    const v = memPrefs.get('bio:' + alias);
    if (!v) throw new Error('Biometria não configurada');
    return v;
  },
  async biometricRemove(alias: string): Promise<void> {
    if (M.CustodiaSecurity) return M.CustodiaSecurity.biometricRemove(alias);
    memPrefs.delete('bio:' + alias);
  },
  async hasBiometricKey(alias: string): Promise<boolean> {
    if (M.CustodiaSecurity) return M.CustodiaSecurity.hasBiometricKey(alias);
    return memPrefs.has('bio:' + alias);
  },
  /** SHA-256 do arquivo do banco cifrado (verificação de integridade). */
  async sha256File(path: string): Promise<string | null> {
    if (M.CustodiaSecurity) return M.CustodiaSecurity.sha256File(path);
    return null;
  },
};

// ---------------------------------------------------------------------------
// Atividades externas (seletor de arquivos/imagens): o app vai para segundo plano
// temporariamente e o bloqueio por "app minimizado" não deve ser disparado.
// ---------------------------------------------------------------------------
export const ExternalActivity = {
  count: 0,
  lastEnded: 0,
};

async function external<T>(fn: () => Promise<T>): Promise<T> {
  ExternalActivity.count++;
  try {
    return await fn();
  } finally {
    ExternalActivity.count = Math.max(0, ExternalActivity.count - 1);
    ExternalActivity.lastEnded = Date.now();
  }
}

// ---------------------------------------------------------------------------
// Sistema: área de transferência, sensores, arquivos, ícone do launcher
// ---------------------------------------------------------------------------
export interface PickedFile {
  name: string;
  mime: string;
  size: number;
  base64: string;
}

export const System = {
  /** Copia marcando o conteúdo como sensível (oculta a pré-visualização no Android 13+). */
  async setClipboard(text: string, sensitive: boolean): Promise<void> {
    if (M.CustodiaSystem) return M.CustodiaSystem.setClipboard(text, sensitive);
  },
  /** Limpa a área de transferência somente se ainda contém o texto copiado pelo app. */
  async clearClipboardIf(text: string): Promise<void> {
    if (M.CustodiaSystem) return M.CustodiaSystem.clearClipboardIf(text);
  },
  /** Sensores de proximidade (bolso) e acelerômetro (virado para baixo). */
  async startSensors(): Promise<void> {
    if (M.CustodiaSystem) return M.CustodiaSystem.startSensors();
  },
  async stopSensors(): Promise<void> {
    if (M.CustodiaSystem) return M.CustodiaSystem.stopSensors();
  },
  async pickImage(): Promise<PickedFile | null> {
    if (M.CustodiaSystem) return external(() => M.CustodiaSystem.pickImage());
    return null;
  },
  async saveFile(name: string, mime: string, base64: string): Promise<boolean> {
    if (M.CustodiaSystem) return external(() => M.CustodiaSystem.saveFile(name, mime, base64));
    return false;
  },
  /** Baixa um arquivo pequeno (logos/favicons dos serviços). */
  async download(url: string): Promise<{ base64: string; mime: string } | null> {
    if (M.CustodiaSystem) return M.CustodiaSystem.download(url);
    return null;
  },
};

// ---------------------------------------------------------------------------
// Eventos nativos
// ---------------------------------------------------------------------------
type Listener = (payload: any) => void;

export function onNativeEvent(moduleName: string, eventName: string, listener: Listener): () => void {
  if (Platform.OS !== 'android' || !M[moduleName]) return () => {};
  const emitter = new NativeEventEmitter(M[moduleName]);
  const sub = emitter.addListener(eventName, listener);
  return () => sub.remove();
}
