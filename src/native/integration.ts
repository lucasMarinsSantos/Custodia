// Ponte JS para os módulos nativos de integração
//  • CustodiaAutofill: serviço de acessibilidade (preenchimento em outros apps e navegadores)
//  • CustodiaDrag:     arrastar usuário/senha para outro app em tela dividida
//  • CustodiaBrowser:  ponte local cifrada com a extensão de navegador
// Cada função tem um fallback em memória para os testes (Jest), no mesmo estilo de `src/native/index.ts`.
// Nenhuma senha atravessa esta ponte, exceto o par usuário/senha escolhido pelo usuário em `Autofill.deliver`
// e a resposta aprovada no celular em `BrowserBridge.respond` (já cifrada com a chave da sessão).

import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { fromB64, toB64 } from '../crypto';

const M: any = NativeModules || {};

// ---------------------------------------------------------------------------
// Preenchimento automático (AccessibilityService)
// ---------------------------------------------------------------------------

/** Tipo de preenchimento pedido pelo serviço: login ou um formulário (cartão, endereço, identidade). */
export type AutofillKind = 'login' | 'card' | 'address' | 'identity';

/** Pedido criado pelo serviço quando o usuário toca no balão do Custódia em outro app. Não contém segredos. */
export interface AutofillRequest {
  id: string;
  kind: AutofillKind;
  /** Pacote do app em foco (ex.: com.twitter.android). */
  packageName: string;
  /** Endereço lido da barra do navegador, quando o app em foco é um navegador conhecido. */
  url: string | null;
  /** Credencial sugerida no balão (escolhida no índice), quando houver. */
  credentialId: string | null;
  /** O app em foco tem um campo de "nova senha" (troca de senha). */
  newPassword: boolean;
  createdAt: number;
}

/** Entrada do índice de sugestões: só metadados, sem usuário nem senha. Vive apenas na memória do processo. */
export interface AutofillIndexEntry {
  id: string;
  title: string;
  hosts: string[];
  associated: string[];
  packages: string[];
}

/**
 * Login ou troca de senha percebidos pelo serviço (requisito 36), sem preenchimento do Custódia.
 * Nunca traz a senha digitada: o app só oferece salvar/atualizar e o usuário digita ou gera a senha no cofre.
 *  • change: a tela tinha campo de "nova senha" e o usuário digitou nele;
 *  • login:  o usuário digitou uma senha e enviou o formulário (os campos sumiram).
 */
export interface PasswordChangeSignal {
  kind?: 'change' | 'login';
  packageName: string;
  url: string | null;
  at: number;
}

export interface AutofillFillPayload {
  requestId: string;
  username?: string;
  password?: string;
  /** Campos de formulário (cartão, endereço, identidade), pelo nome padrão do campo. */
  fields?: { key: string; value: string }[];
}

interface MemAutofill {
  enabled: boolean;
  serviceEnabled: boolean;
  index: AutofillIndexEntry[];
  requests: AutofillRequest[];
  delivered: AutofillFillPayload | null;
  changes: PasswordChangeSignal[];
  returned: number;
}

const memAutofill: MemAutofill = { enabled: true, serviceEnabled: false, index: [], requests: [], delivered: null, changes: [], returned: 0 };

export const Autofill = {
  /** O serviço de acessibilidade do Custódia está ativo nas configurações do Android? */
  async isServiceEnabled(): Promise<boolean> {
    if (M.CustodiaAutofill) return M.CustodiaAutofill.isServiceEnabled();
    return memAutofill.serviceEnabled;
  },
  /** Abre Configurações › Acessibilidade do Android. */
  async openAccessibilitySettings(): Promise<void> {
    if (M.CustodiaAutofill) return M.CustodiaAutofill.openAccessibilitySettings();
  },
  /** Abre "Informações do app" (Android 13+: menu ⋮ › Permitir configurações restritas). */
  async openAppInfo(): Promise<void> {
    if (M.CustodiaAutofill) return M.CustodiaAutofill.openAppInfo();
  },
  /** Liga/desliga o balão em outros apps (vale mesmo com o app fechado; guarda só este booleano). */
  async setEnabled(enabled: boolean): Promise<void> {
    if (M.CustodiaAutofill) return M.CustodiaAutofill.setEnabled(enabled);
    memAutofill.enabled = enabled;
  },
  /** Índice de sugestões (sem segredos), enviado só com o cofre aberto. */
  async setIndex(entries: AutofillIndexEntry[]): Promise<void> {
    if (M.CustodiaAutofill) return M.CustodiaAutofill.setIndex(JSON.stringify(entries));
    memAutofill.index = entries;
  },
  /** Apaga o índice e os pedidos abertos (chamado ao bloquear o cofre). */
  async clearIndex(): Promise<void> {
    if (M.CustodiaAutofill) return M.CustodiaAutofill.clearIndex();
    memAutofill.index = [];
    memAutofill.requests = [];
  },
  /** Retira o pedido de preenchimento mais recente (o serviço guarda no máximo um, por 2 minutos). */
  async takeRequest(): Promise<AutofillRequest | null> {
    if (M.CustodiaAutofill) {
      const raw: string | null = await M.CustodiaAutofill.takeRequest();
      return raw ? JSON.parse(raw) : null;
    }
    return memAutofill.requests.shift() || null;
  },
  /**
   * Entrega ao serviço o par escolhido pelo usuário. O serviço guarda só na memória, por no máximo `ttlMs`,
   * e só preenche no mesmo app (e no mesmo host, nos navegadores) do pedido.
   */
  async deliver(payload: AutofillFillPayload, ttlMs: number): Promise<boolean> {
    if (M.CustodiaAutofill) return M.CustodiaAutofill.deliver(JSON.stringify(payload), ttlMs);
    memAutofill.delivered = payload;
    return true;
  },
  /** Descarta um pedido sem preencher. */
  async cancel(requestId: string): Promise<void> {
    if (M.CustodiaAutofill) return M.CustodiaAutofill.cancel(requestId);
    if (memAutofill.delivered?.requestId === requestId) memAutofill.delivered = null;
  },
  /** Leva o usuário de volta ao app que pediu o preenchimento (move a tarefa do Custódia para trás). */
  async returnToTarget(): Promise<void> {
    if (M.CustodiaAutofill) return M.CustodiaAutofill.returnToTarget();
    memAutofill.returned++;
  },
  /** Trocas de senha percebidas desde a última leitura (mantidas só na memória do processo). */
  async takePasswordChanges(): Promise<PasswordChangeSignal[]> {
    if (M.CustodiaAutofill) return JSON.parse((await M.CustodiaAutofill.takePasswordChanges()) || '[]');
    const out = memAutofill.changes;
    memAutofill.changes = [];
    return out;
  },
};

// ---------------------------------------------------------------------------
// Arrastar e soltar (tela dividida)
// ---------------------------------------------------------------------------
export interface DragResult {
  started: boolean;
  multiWindow: boolean;
}

const memDrag = { multiWindow: false, last: null as null | { text: string; label: string; sensitive: boolean } };

export const Drag = {
  async isInMultiWindow(): Promise<boolean> {
    if (M.CustodiaDrag) return M.CustodiaDrag.isInMultiWindow();
    return memDrag.multiWindow;
  },
  /** Inicia o arrastar global (DRAG_FLAG_GLOBAL), com EXTRA_IS_SENSITIVE para senhas. */
  async startDrag(text: string, label: string, sensitive: boolean): Promise<DragResult> {
    if (M.CustodiaDrag) return M.CustodiaDrag.startDrag(text, label, sensitive);
    if (!memDrag.multiWindow) return { started: false, multiWindow: false };
    memDrag.last = { text, label, sensitive };
    return { started: true, multiWindow: true };
  },
};

// ---------------------------------------------------------------------------
// Ponte com a extensão de navegador
// ---------------------------------------------------------------------------
/**
 * Pedido HTTP recebido pelo servidor local do Kotlin (`BrowserBridgeModule.kt`). O Kotlin só confere o
 * básico (método, caminho conhecido, Origin de extensão, tamanho ≤ 64 KiB) e repassa o corpo, ainda cifrado,
 * para o JS, que decifra, valida e responde com `BrowserBridge.respond`.
 */
export interface BridgeHttpEvent {
  type: 'http';
  requestId: string;
  method: 'GET' | 'POST';
  path: string;
  body: string;
}

const memBridge = {
  running: false,
  port: 0,
  lan: false,
  failStart: false,
  responses: new Map<string, { status: number; body: string }>(),
  keys: new Map<string, { publicKey: CryptoKey; privateKey: CryptoKey }>(),
  seq: 0,
};

/** Web Crypto (só no Jest, em que o Node expõe `crypto.subtle`): ECDH P-256 de verdade para os testes. */
function subtle(): SubtleCrypto {
  const s = (globalThis as any).crypto?.subtle;
  if (!s) throw new Error('ECDH indisponível neste ambiente');
  return s;
}

const b64 = (buf: ArrayBuffer) => toB64(new Uint8Array(buf));

export const BrowserBridge = {
  /** Abre o servidor HTTP local: só em 127.0.0.1 ou, com `lan`, também na rede Wi-Fi. */
  async start(port: number, lan: boolean): Promise<void> {
    if (M.CustodiaBrowser) return M.CustodiaBrowser.start(port, lan);
    if (memBridge.failStart) throw new Error('Address already in use');
    Object.assign(memBridge, { running: true, port, lan });
  },
  async stop(): Promise<void> {
    if (M.CustodiaBrowser) return M.CustodiaBrowser.stop();
    memBridge.running = false;
    memBridge.keys.clear();
  },
  async isRunning(): Promise<boolean> {
    if (M.CustodiaBrowser) return M.CustodiaBrowser.isRunning();
    return memBridge.running;
  },
  /** Endereços IPv4 do aparelho na rede Wi-Fi (para digitar na extensão no modo rede local). */
  async localAddresses(): Promise<string[]> {
    if (M.CustodiaBrowser) return JSON.parse((await M.CustodiaBrowser.localAddresses()) || '[]');
    return memBridge.lan ? ['192.168.0.10'] : [];
  },
  /** Responde a um pedido HTTP pendente (o Kotlin fecha a conexão depois). */
  async respond(requestId: string, status: number, body: object): Promise<void> {
    const json = JSON.stringify(body);
    if (M.CustodiaBrowser) return M.CustodiaBrowser.respond(requestId, status, json);
    memBridge.responses.set(requestId, { status, body: json });
  },
  /**
   * Gera um par ECDH P-256. A chave privada não sai do Kotlin (fica num mapa em memória até `ecdhAgree` ou
   * `ecdhDiscard`); o JS recebe só um identificador e a chave pública sem compressão (65 bytes, base64).
   */
  async ecdhGenerate(): Promise<{ handle: string; publicKey: string }> {
    if (M.CustodiaBrowser) return JSON.parse(await M.CustodiaBrowser.ecdhGenerate());
    const pair = (await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])) as { publicKey: CryptoKey; privateKey: CryptoKey };
    const handle = `k${++memBridge.seq}`;
    memBridge.keys.set(handle, pair);
    return { handle, publicKey: b64(await subtle().exportKey('raw', pair.publicKey)) };
  },
  /** Segredo ECDH com a chave pública da extensão (32 bytes, base64). Apaga a chave privada. */
  async ecdhAgree(handle: string, peerPublicKey: string): Promise<string> {
    if (M.CustodiaBrowser) return M.CustodiaBrowser.ecdhAgree(handle, peerPublicKey);
    const pair = memBridge.keys.get(handle);
    memBridge.keys.delete(handle);
    if (!pair) throw new Error('Chave de pareamento expirada');
    const peer = await subtle().importKey('raw', fromB64(peerPublicKey) as Uint8Array<ArrayBuffer>, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    return b64(await subtle().deriveBits({ name: 'ECDH', public: peer }, pair.privateKey, 256));
  },
  async ecdhDiscard(handle: string): Promise<void> {
    if (M.CustodiaBrowser) return M.CustodiaBrowser.ecdhDiscard(handle);
    memBridge.keys.delete(handle);
  },
};

/** Apenas para testes: estado dos fallbacks em memória. */
export const __integrationMocks = { autofill: memAutofill, drag: memDrag, bridge: memBridge };

// ---------------------------------------------------------------------------
// Eventos nativos dos módulos de integração
// ---------------------------------------------------------------------------
type Listener = (payload: any) => void;
const testListeners = new Map<string, Set<Listener>>();

export function onIntegrationEvent(moduleName: 'CustodiaAutofill' | 'CustodiaBrowser', listener: Listener): () => void {
  if (Platform.OS === 'android' && M[moduleName]) {
    const sub = new NativeEventEmitter(M[moduleName]).addListener(moduleName, listener);
    return () => sub.remove();
  }
  if (!testListeners.has(moduleName)) testListeners.set(moduleName, new Set());
  testListeners.get(moduleName)!.add(listener);
  return () => testListeners.get(moduleName)?.delete(listener);
}

/** Apenas para testes: simula um evento vindo do Kotlin. */
export function __emitIntegrationEvent(moduleName: 'CustodiaAutofill' | 'CustodiaBrowser', payload: any) {
  testListeners.get(moduleName)?.forEach(l => l(payload));
}
