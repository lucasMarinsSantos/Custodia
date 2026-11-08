// Cliente HTTP do servidor de sincronização (contrato em backend/README.md).
//  • HTTPS obrigatório, exceto 10.0.2.2 (emulador), localhost e IPs da rede local (servidor no PC durante a aula)
//  • fetch com timeout e mensagens de erro claras em pt-BR
//  • JWT de vida curta só em memória: quando expira, o cliente entra de novo com o segredo derivado da chave
//  • respostas validadas (tamanho e formato) antes de chegar ao CRDT

export const REQUEST_TIMEOUT_MS = 20000;
/** Resposta maior que isso é descartada (o servidor limita a página do pull a ~4 MB). */
export const MAX_RESPONSE_CHARS = 16 * 1024 * 1024;

export const MSG_HTTPS =
  'Use HTTPS. HTTP só é aceito para 10.0.2.2 (emulador), localhost e IPs da rede local (10.x, 172.16–31.x, 192.168.x), para o servidor rodar no PC durante a aula.';

const MSG_BAD_RESPONSE = 'Resposta inválida do servidor de sincronização.';

export class SyncHttpError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'SyncHttpError';
  }
}

// ---------------------------------------------------------------------------
// Endereço do servidor
// ---------------------------------------------------------------------------
const URL_RE = /^(https?):\/\/([a-z0-9.-]+|\[[0-9a-f:.]+\])(?::(\d{1,5}))?(\/[A-Za-z0-9._~/-]*)?$/i;

function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some(o => Number(o) > 255)) return false;
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** HTTP sem TLS só para o emulador, a própria máquina e a rede local. */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h === '[::1]' || h === '10.0.2.2' || isPrivateIPv4(h);
}

/** Valida e normaliza o endereço (sem barra final). Lança Error com a mensagem para a tela. */
export function validateServerUrl(raw: string): string {
  const url = String(raw || '')
    .trim()
    .replace(/\/+$/, '');
  if (!url) throw new Error('Informe o endereço do servidor de sincronização.');
  if (url.length > 300) throw new Error('Endereço do servidor longo demais.');
  const m = URL_RE.exec(url);
  if (!m) throw new Error('Endereço inválido. Exemplo: https://sync.exemplo.com ou http://10.0.2.2:3000');
  const [, scheme, host, port] = m;
  if (port && (Number(port) < 1 || Number(port) > 65535)) throw new Error('Porta inválida no endereço do servidor.');
  if (scheme.toLowerCase() === 'http' && !isLocalHost(host)) throw new Error(MSG_HTTPS);
  return url.replace(/^https?/i, scheme.toLowerCase());
}

/** Aviso para a tela quando o endereço é HTTP (aceito só na rede local): null se for HTTPS ou inválido. */
export function plainHttpWarning(raw: string): string | null {
  try {
    if (!validateServerUrl(raw).startsWith('http:')) return null;
  } catch {
    return null;
  }
  return 'Conexão sem HTTPS: aceita só no emulador, neste PC ou na rede local. Os documentos continuam cifrados, mas use HTTPS fora da aula.';
}

// ---------------------------------------------------------------------------
// Tipos do contrato
// ---------------------------------------------------------------------------
export interface RemoteChange {
  collection: string;
  id: string;
  hlc: string;
  ciphertext: string;
  seq: number;
}

export interface PullResponse {
  changes: RemoteChange[];
  cursor: number;
  hasMore: boolean;
  latest: number;
  /** Identidade do banco do servidor para a conta (muda se a conta for recriada no servidor). */
  epoch?: string;
}

export interface PushChange {
  collection: string;
  id: string;
  hlc: string;
  ciphertext: string;
  baseSeq: number;
}

export interface DocRef {
  collection: string;
  id: string;
}

export interface PushResponse {
  accepted: (DocRef & { seq: number })[];
  conflicts: (DocRef & { seq: number })[];
  rejected: (DocRef & { reason: string })[];
}

export interface RemoteDevice {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

/** O que o motor de sincronização precisa do servidor (o teste pode trocar por um servidor em memória). */
export interface SyncTransport {
  pull(since: number, limit: number): Promise<PullResponse>;
  push(changes: PushChange[]): Promise<PushResponse>;
}

export interface Credentials {
  accountId: string;
  authSecret: string;
  device: { id: string; name: string };
}

type FetchFn = typeof fetch;

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isStr = (v: unknown): v is string => typeof v === 'string';

function checkPull(j: any): PullResponse {
  const ok =
    j &&
    Array.isArray(j.changes) &&
    isInt(j.cursor) &&
    isInt(j.latest) &&
    typeof j.hasMore === 'boolean' &&
    (j.epoch === undefined || (isStr(j.epoch) && /^[0-9a-f]{16,64}$/.test(j.epoch))) &&
    j.changes.every((c: any) => c && isStr(c.collection) && isStr(c.id) && isStr(c.hlc) && isStr(c.ciphertext) && isInt(c.seq));
  if (!ok) throw new SyncHttpError(MSG_BAD_RESPONSE, 502);
  return j;
}

function checkPush(j: any): PushResponse {
  const refs = (list: unknown) => Array.isArray(list) && list.every((r: any) => r && isStr(r.collection) && isStr(r.id));
  if (!j || !refs(j.accepted) || !refs(j.conflicts) || !refs(j.rejected) || !j.accepted.every((a: any) => isInt(a.seq))) {
    throw new SyncHttpError(MSG_BAD_RESPONSE, 502);
  }
  return j;
}

function httpMessage(status: number, serverMsg: unknown): string {
  if (status === 429) return 'Muitas tentativas no servidor de sincronização. Aguarde alguns minutos.';
  if (status === 413) return 'Os dados enviados passam do limite do servidor.';
  if (status >= 500) return `O servidor de sincronização falhou (erro ${status}). Tente mais tarde.`;
  return typeof serverMsg === 'string' && serverMsg.length < 300 ? serverMsg : `Erro ${status} no servidor de sincronização.`;
}

export class SyncHttpClient implements SyncTransport {
  private token: string | null = null;
  /** Já tentou recriar a conta nesta sessão (no máximo uma vez). */
  private recreated = false;
  private tokenExp = 0;
  readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, private readonly creds: Credentials, opts: { fetch?: FetchFn; timeoutMs?: number } = {}) {
    this.baseUrl = validateServerUrl(baseUrl);
    this.fetchFn = opts.fetch || ((...args) => fetch(...args));
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /** Requisição crua com timeout. Devolve o JSON (ou {}) e lança SyncHttpError em qualquer falha. */
  private async raw(method: string, path: string, body?: unknown, token?: string): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    let res: Response;
    let text: string;
    try {
      res = await this.fetchFn(this.baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
      text = await res.text();
    } catch {
      if (controller.signal.aborted) {
        throw new SyncHttpError(`O servidor não respondeu em ${Math.round(this.timeoutMs / 1000)} s. Confira o endereço e a rede.`, 0, 'timeout');
      }
      throw new SyncHttpError(
        `Não foi possível conectar a ${this.baseUrl}. Confira se o servidor está rodando e se o aparelho está na mesma rede.`,
        0,
        'network',
      );
    } finally {
      clearTimeout(timer);
    }
    if (text.length > MAX_RESPONSE_CHARS) throw new SyncHttpError('Resposta do servidor grande demais.', 502);
    let json: any = {};
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new SyncHttpError('O endereço respondeu, mas não é um servidor de sincronização do Custódia.', res.status || 502);
      }
    }
    if (!res.ok) throw new SyncHttpError(httpMessage(res.status, json?.error), res.status, typeof json?.code === 'string' ? json.code : undefined);
    return json;
  }

  async health(): Promise<boolean> {
    const j = await this.raw('GET', '/api/health');
    if (j?.status !== 'ok') throw new SyncHttpError('O endereço respondeu, mas não é um servidor de sincronização do Custódia.', 502);
    return true;
  }

  async register(): Promise<void> {
    try {
      await this.raw('POST', '/api/auth/register', { accountId: this.creds.accountId, authSecret: this.creds.authSecret });
    } catch (e) {
      if (e instanceof SyncHttpError && e.status === 409) throw new SyncHttpError('Esta conta já existe no servidor.', 409, 'exists');
      throw e;
    }
  }

  private loginRequest(): Promise<any> {
    return this.raw('POST', '/api/auth/login', { accountId: this.creds.accountId, authSecret: this.creds.authSecret, device: this.creds.device });
  }

  async login(): Promise<void> {
    let j: any;
    try {
      j = await this.loginRequest();
    } catch (e) {
      // 401 no login: a conta sumiu do servidor (banco recriado) ou o segredo não confere. Quem tem a chave
      // pode recriar a conta; se ela existir (409), o problema é o segredo e o erro original vale.
      if (!(e instanceof SyncHttpError) || e.status !== 401 || this.recreated) throw e;
      this.recreated = true;
      try {
        await this.register();
      } catch {
        throw e;
      }
      j = await this.loginRequest();
    }
    if (!isStr(j?.token) || !isInt(j?.expiresIn)) throw new SyncHttpError(MSG_BAD_RESPONSE, 502);
    this.token = j.token;
    // Renova um pouco antes de expirar
    this.tokenExp = Date.now() + Math.max(0, j.expiresIn - 30) * 1000;
  }

  /** Requisição autenticada; entra de novo uma vez se o token expirou. */
  private async authed(method: string, path: string, body?: unknown): Promise<any> {
    if (!this.token || Date.now() >= this.tokenExp) await this.login();
    try {
      return await this.raw(method, path, body, this.token!);
    } catch (e) {
      if (!(e instanceof SyncHttpError) || e.status !== 401 || e.code === 'device_revoked') throw e;
      await this.login();
      return this.raw(method, path, body, this.token!);
    }
  }

  async pull(since: number, limit: number): Promise<PullResponse> {
    return checkPull(await this.authed('GET', `/api/sync/pull?since=${since}&limit=${limit}`));
  }

  async push(changes: PushChange[]): Promise<PushResponse> {
    return checkPush(await this.authed('POST', '/api/sync/push', { changes }));
  }

  async devices(): Promise<RemoteDevice[]> {
    const j = await this.authed('GET', '/api/devices');
    if (!Array.isArray(j?.devices)) throw new SyncHttpError(MSG_BAD_RESPONSE, 502);
    return j.devices
      .filter((d: any) => d && isStr(d.id) && isStr(d.name))
      .map((d: any) => ({ id: d.id, name: d.name.slice(0, 60), createdAt: String(d.createdAt || ''), lastSeenAt: String(d.lastSeenAt || ''), current: !!d.current }));
  }

  async revokeDevice(id: string): Promise<void> {
    if (!/^[a-z0-9]{8,32}$/.test(id)) throw new Error('Id de aparelho inválido');
    await this.authed('DELETE', `/api/devices/${id}`);
  }

  async deleteAccount(): Promise<void> {
    await this.authed('DELETE', '/api/auth/account');
  }

  /** Esquece o token (ao bloquear o cofre). */
  forget(): void {
    this.token = null;
    this.tokenExp = 0;
  }
}
