// Ponte com a extensão de navegador "Custódia Connect"
//
// Canal: servidor HTTP do módulo nativo (`BrowserBridgeModule.kt`) na porta 17865, aberto só com a ponte ligada
// nos Ajustes e o cofre aberto. Por padrão escuta apenas em 127.0.0.1 (no computador: `adb forward tcp:17865
// tcp:17865`, com o celular no USB); com "Rede Wi-Fi" ligado, escuta também no endereço do aparelho na rede local.
// O Kotlin não conhece chaves nem senhas: repassa o corpo cifrado para cá e devolve a resposta já cifrada.
//
// Protocolo (pareamento com código de 6 dígitos comparado no celular, AES-256-GCM, anti-replay): ver
// `BridgeProtocol.ts`. Regras deste serviço:
//  • pareamento só na janela de 2 minutos aberta por "Parear nova extensão" no celular, com no máximo 5 tentativas;
//  • cada senha pedida pela extensão exige "Permitir" no celular; a lista de logins não traz senhas;
//  • antes de responder, as mesmas verificações do preenchimento automático: correspondência do site, anti-phishing,
//    credencial inativa e regra da pasta (`blockAutofill`, `requireReauth`);
//  • sessões vencem em 7 dias, ficam só no banco SQLCipher e podem ser revogadas no celular ou pela extensão.

import { BridgeHttpEvent, BrowserBridge } from '../native/integration';
import { vaultDb } from '../db/Database';
import { equalBytes, fromB64, randomBytes, toB64, wipe } from '../crypto';
import { Credential, Folder } from '../types/models';
import { hostnameOf } from '../utils';
import { analyzeDomain, credentialsFor, verifyBeforeFill } from './DomainService';
import { PolicyService } from './PolicyService';
import { Repo } from './Repository';
import { Vault } from './VaultService';
import { confirmIdentity, MSG, trustedDomains } from './AutofillService';
import { bus } from './events';
import {
  b64Exact,
  commitment,
  open,
  pairingCode,
  pairingProof,
  ProtocolError,
  PROTOCOL_VERSION,
  publicKeyFrom,
  ReplayGuard,
  CLOCK_SKEW_MS,
  seal,
  sessionKey,
} from './BridgeProtocol';

export const BRIDGE_PORT = 17865;
export const PAIRING_WINDOW_MS = 2 * 60_000;
export const MAX_PAIR_ATTEMPTS = 5;
export const SESSION_TTL_DAYS = 7;
export const MAX_SESSIONS = 10;
export const APPROVAL_TIMEOUT_MS = 60_000;
export const MAX_LIST_ITEMS = 10;
export const MAX_BODY = 64 * 1024;

/** Evento do barramento: sessões, pareamento ou estado da ponte mudaram. */
export const BRIDGE_EVENT = 'browserBridge';
/** Evento do barramento: a fila de confirmações no celular mudou. */
export const APPROVAL_EVENT = 'bridgeApproval';

const SESSIONS_KEY = 'bridge.sessions';
const LAN_KEY = 'bridge.lan';
const ID_RE = /^[\w-]{8,64}$/;
const DAY = 86_400_000;

export interface BridgeSession {
  id: string;
  name: string;
  /** Chave AES-256 da sessão (base64), só no banco SQLCipher. */
  key: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
}

export type PublicSession = Omit<BridgeSession, 'key'>;

export const BRIDGE_MSG = {
  disabled: 'A ponte com a extensão está desligada. Ligue em Ajustes › Extensão de navegador.',
  locked: 'Cofre bloqueado. Desbloqueie o Custódia no celular.',
  portBusy: `Não foi possível abrir a ponte local: a porta ${BRIDGE_PORT} está em uso por outro app.`,
  session: 'Sessão expirada ou revogada. Pareie a extensão de novo.',
  auth: 'Mensagem não autenticada. Pareie a extensão de novo.',
  clock: 'O relógio do computador e o do celular diferem em mais de 1 minuto. Acerte a hora e tente de novo.',
  replay: 'Pedido repetido recusado.',
  notPairing: 'Toque em "Parear nova extensão" no celular (Ajustes › Extensão de navegador) e tente de novo.',
  pairingExpired: 'O pareamento expirou. Toque em "Parear nova extensão" no celular e tente de novo.',
  pairingDenied: 'Pareamento recusado no celular.',
  badCommit: 'A chave da extensão não confere com a enviada no início do pareamento.',
  denied: 'Pedido negado no celular.',
  busy: 'Já há um pedido desta extensão aguardando confirmação no celular.',
  badUrl: 'Endereço inválido. A extensão só funciona em páginas http(s).',
  unknown: 'Operação desconhecida.',
  notFound: 'Rota não encontrada.',
  internal: 'Erro interno no app.',
};

/** Nome da extensão vindo da rede: só texto simples e curto. */
export function sanitizeName(name: unknown): string {
  const s = String(name ?? '')
    .slice(0, 200)
    .replace(/[^\w À-ÿ.()-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return s || 'Navegador';
}

function validPageUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 2048 || !/^https?:\/\//i.test(url)) return null;
  return hostnameOf(url) ? url : null;
}

/** "123456" → "123 456" (como aparece nos dois lados). */
export const formatCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

// -----------------------------------------------------------------------------
// Confirmação no celular
// -----------------------------------------------------------------------------
export interface Approval {
  id: string;
  kind: 'pair' | 'password';
  title: string;
  message: string;
  /** Código de pareamento a comparar com o da extensão. */
  code?: string;
  /** Sessão que fez o pedido (no máximo um pedido de senha aberto por sessão). */
  sessionId?: string;
  createdAt: number;
}

const approvals = new Map<string, { approval: Approval; resolve: (allow: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
let approvalSeq = 0;

export const BridgeApprovals = {
  /** Pergunta ao usuário. Sem resposta em 60 s, ou com o cofre bloqueado, vale como "Negar". */
  request(input: Omit<Approval, 'id' | 'createdAt'>): Promise<boolean> {
    const approval: Approval = { ...input, id: `ap${++approvalSeq}`, createdAt: Date.now() };
    return new Promise(resolve => {
      const timer = setTimeout(() => this.answer(approval.id, false), APPROVAL_TIMEOUT_MS);
      approvals.set(approval.id, { approval, resolve, timer });
      bus.emit(APPROVAL_EVENT);
    });
  },
  pending(): Approval[] {
    return [...approvals.values()].map(a => a.approval);
  },
  answer(id: string, allow: boolean) {
    const entry = approvals.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    approvals.delete(id);
    entry.resolve(allow && Vault.isUnlocked);
    bus.emit(APPROVAL_EVENT);
  },
  clear() {
    for (const id of [...approvals.keys()]) this.answer(id, false);
  },
};

// -----------------------------------------------------------------------------
// Estado do pareamento
// -----------------------------------------------------------------------------
interface PendingPair {
  name: string;
  commit: Uint8Array;
  handle: string;
  pk: Uint8Array;
  nonce: Uint8Array;
  expiresAt: number;
}

let pairingWindow: { expiresAt: number; attempts: number } | null = null;
const pendingPairs = new Map<string, PendingPair>();
const replay = new ReplayGuard();

interface HttpResult {
  status: number;
  body: object;
}

const ok = (body: object): HttpResult => ({ status: 200, body });
const fail = (status: number, code: string, error: string): HttpResult => ({ status, body: { code, error } });

function discardPending(id?: string) {
  for (const [pid, p] of pendingPairs) {
    if (id && pid !== id) continue;
    pendingPairs.delete(pid);
    BrowserBridge.ecdhDiscard(p.handle).catch(() => {});
  }
}

function parseBody(raw: unknown): any {
  if (typeof raw !== 'string' || raw.length > MAX_BODY) throw new ProtocolError('Pedido grande demais');
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch {
    // tratado abaixo
  }
  throw new ProtocolError('JSON inválido');
}

function usableCredential(cred: Credential | null, folders: Folder[]): string | null {
  if (!cred) return MSG.notFound;
  if (cred.inactive) return MSG.inactive;
  if (PolicyService.forCredential(folders, cred).blockAutofill) return MSG.blockedFolder;
  return null;
}

const toPublic = ({ key: _key, ...rest }: BridgeSession): PublicSession => rest;

// -----------------------------------------------------------------------------
// Serviço
// -----------------------------------------------------------------------------
export const BrowserBridgeService = {
  /** Janela de pareamento aberta no celular (null quando fechada ou vencida). */
  get pairingWindow(): { expiresAt: number; attempts: number } | null {
    if (pairingWindow && pairingWindow.expiresAt <= Date.now()) pairingWindow = null;
    return pairingWindow;
  },

  get enabled(): boolean {
    return !!Vault.settings.browserBridge && Vault.isUnlocked;
  },

  // ---------------------------------------------------------------------------
  // Sessões
  // ---------------------------------------------------------------------------
  async sessions(): Promise<BridgeSession[]> {
    if (!Vault.isUnlocked) return [];
    let list: BridgeSession[] = [];
    try {
      const raw = JSON.parse((await vaultDb.getKv(SESSIONS_KEY)) || '[]');
      list = Array.isArray(raw) ? raw : [];
    } catch {
      list = [];
    }
    const now = Date.now();
    const valid = list.filter(s => s && typeof s.id === 'string' && typeof s.key === 'string' && Date.parse(s.expiresAt) > now);
    if (valid.length !== list.length) await vaultDb.setKv(SESSIONS_KEY, JSON.stringify(valid));
    return valid;
  },

  async publicSessions(): Promise<PublicSession[]> {
    return (await this.sessions()).map(toPublic);
  },

  async saveSessions(list: BridgeSession[]) {
    await vaultDb.setKv(SESSIONS_KEY, JSON.stringify(list));
    bus.emit(BRIDGE_EVENT);
  },

  /** Marca o último uso relendo a lista (não sobrescreve um pareamento ou revogação feitos em paralelo). */
  async touch(id: string) {
    const list = await this.sessions();
    const s = list.find(x => x.id === id);
    if (!s) return;
    s.lastUsedAt = new Date().toISOString();
    await vaultDb.setKv(SESSIONS_KEY, JSON.stringify(list));
  },

  async revoke(id: string) {
    await this.saveSessions((await this.sessions()).filter(s => s.id !== id));
  },

  async revokeAll() {
    await this.saveSessions([]);
  },

  // ---------------------------------------------------------------------------
  // Liga/desliga
  // ---------------------------------------------------------------------------
  async lanEnabled(): Promise<boolean> {
    return Vault.isUnlocked && (await vaultDb.getKv(LAN_KEY)) === '1';
  },

  async setLan(on: boolean): Promise<void> {
    if (!Vault.isUnlocked) throw new Error(BRIDGE_MSG.locked);
    await vaultDb.setKv(LAN_KEY, on ? '1' : '0');
    await this.stop();
    await this.sync();
  },

  /** Abre a ponte se estiver ligada e o cofre aberto; senão, fecha. */
  async sync(): Promise<void> {
    if (!this.enabled) {
      await this.stop();
      return;
    }
    if (await BrowserBridge.isRunning()) return;
    try {
      await BrowserBridge.start(BRIDGE_PORT, await this.lanEnabled());
    } catch (e: any) {
      throw new Error(/in use|EADDRINUSE|bind/i.test(String(e?.message)) ? BRIDGE_MSG.portBusy : `Não foi possível abrir a ponte local (${e?.message || e}).`);
    } finally {
      bus.emit(BRIDGE_EVENT);
    }
  },

  async stop(): Promise<void> {
    pairingWindow = null;
    discardPending();
    replay.clear();
    BridgeApprovals.clear();
    await BrowserBridge.stop();
    bus.emit(BRIDGE_EVENT);
  },

  async setEnabled(on: boolean): Promise<void> {
    if (!Vault.isUnlocked) throw new Error(BRIDGE_MSG.locked);
    await Vault.updateSettings({ browserBridge: on });
    await this.sync();
  },

  async isRunning(): Promise<boolean> {
    return BrowserBridge.isRunning().catch(() => false);
  },

  async addresses(): Promise<string[]> {
    return BrowserBridge.localAddresses().catch(() => []);
  },

  // ---------------------------------------------------------------------------
  // Pareamento
  // ---------------------------------------------------------------------------
  /** Abre a janela de 2 minutos em que uma extensão pode pedir pareamento. */
  async startPairing(): Promise<{ expiresAt: number }> {
    if (!Vault.isUnlocked) throw new Error(BRIDGE_MSG.locked);
    if (!Vault.settings.browserBridge) throw new Error(BRIDGE_MSG.disabled);
    await this.sync();
    pairingWindow = { expiresAt: Date.now() + PAIRING_WINDOW_MS, attempts: 0 };
    bus.emit(BRIDGE_EVENT);
    return { expiresAt: pairingWindow.expiresAt };
  },

  cancelPairing() {
    pairingWindow = null;
    discardPending();
    bus.emit(BRIDGE_EVENT);
  },

  // ---------------------------------------------------------------------------
  // Pedidos HTTP vindos do módulo nativo
  // ---------------------------------------------------------------------------
  async handleEvent(ev: BridgeHttpEvent): Promise<void> {
    if (!ev || ev.type !== 'http' || typeof ev.requestId !== 'string') return;
    let result: HttpResult;
    try {
      result = await this.route(ev);
    } catch (e: any) {
      if (e instanceof ProtocolError) result = fail(400, 'protocol', e.message);
      else {
        console.warn('[Extensão] erro ao atender pedido', e?.message);
        result = fail(500, 'error', BRIDGE_MSG.internal);
      }
    }
    await BrowserBridge.respond(ev.requestId, result.status, result.body);
  },

  async route(ev: BridgeHttpEvent): Promise<HttpResult> {
    if (ev.method === 'GET' && ev.path === '/v1/status') return ok({ app: 'Custódia', v: PROTOCOL_VERSION, pairing: !!this.pairingWindow });
    if (ev.method !== 'POST') return fail(404, 'route', BRIDGE_MSG.notFound);
    if (!this.enabled) return fail(423, 'locked', Vault.isUnlocked ? BRIDGE_MSG.disabled : BRIDGE_MSG.locked);
    if (ev.path === '/v1/pair/start') return this.pairStart(parseBody(ev.body));
    if (ev.path === '/v1/pair/finish') return this.pairFinish(parseBody(ev.body));
    if (ev.path === '/v1/rpc') return this.rpc(parseBody(ev.body));
    return fail(404, 'route', BRIDGE_MSG.notFound);
  },

  /** Passo 1: a extensão manda o compromisso; o app manda a sua chave pública e o seu nonce. */
  async pairStart(body: any): Promise<HttpResult> {
    const win = this.pairingWindow;
    if (!win) return fail(403, 'not-pairing', BRIDGE_MSG.notPairing);
    if (body.v !== PROTOCOL_VERSION) throw new ProtocolError('Versão do protocolo não suportada. Atualize a extensão.');
    const commit = b64Exact(body.commit, 32, 'Compromisso');
    win.attempts++;
    if (win.attempts > MAX_PAIR_ATTEMPTS) {
      this.cancelPairing();
      return fail(429, 'attempts', 'Tentativas demais. Toque em "Parear nova extensão" no celular de novo.');
    }
    // Um pareamento por vez: o mais recente substitui o anterior
    discardPending();
    const { handle, publicKey } = await BrowserBridge.ecdhGenerate();
    const pairId = toB64(randomBytes(12)).replace(/[+/=]/g, '_');
    const nonce = randomBytes(16);
    pendingPairs.set(pairId, { name: sanitizeName(body.name), commit, handle, pk: publicKeyFrom(publicKey), nonce, expiresAt: win.expiresAt });
    return ok({ v: PROTOCOL_VERSION, pairId, pk: publicKey, nonce: toB64(nonce) });
  },

  /** Passo 2: confere o compromisso, mostra o código no celular e, se o usuário permitir, cria a sessão. */
  async pairFinish(body: any): Promise<HttpResult> {
    const pending = typeof body.pairId === 'string' ? pendingPairs.get(body.pairId) : undefined;
    if (!pending || pending.expiresAt <= Date.now() || !this.pairingWindow) return fail(403, 'pairing-expired', BRIDGE_MSG.pairingExpired);
    pendingPairs.delete(body.pairId);
    const pkE = publicKeyFrom(body.pk);
    const nE = b64Exact(body.nonce, 16, 'Nonce');
    if (!equalBytes(commitment(pkE, nE), pending.commit)) {
      await BrowserBridge.ecdhDiscard(pending.handle);
      return fail(403, 'commit', BRIDGE_MSG.badCommit);
    }
    const code = pairingCode(pkE, pending.pk, nE, pending.nonce);
    const shared = fromB64(await BrowserBridge.ecdhAgree(pending.handle, body.pk));
    const key = sessionKey(shared, nE, pending.nonce);
    wipe(shared);
    const allow = await BridgeApprovals.request({
      kind: 'pair',
      title: 'Parear extensão de navegador?',
      message: `"${pending.name}" quer se conectar ao seu cofre. Permita só se a extensão mostra este mesmo código:`,
      code: formatCode(code),
    });
    // Código usado (aceito ou não): é preciso abrir uma nova janela de pareamento
    pairingWindow = null;
    bus.emit(BRIDGE_EVENT);
    if (!allow) {
      wipe(key);
      return fail(403, 'denied', BRIDGE_MSG.pairingDenied);
    }
    const now = Date.now();
    const sid = toB64(randomBytes(18)).replace(/\+/g, '-').replace(/\//g, '_');
    const expiresAt = now + SESSION_TTL_DAYS * DAY;
    const session: BridgeSession = { id: sid, name: pending.name, key: toB64(key), createdAt: new Date(now).toISOString(), expiresAt: new Date(expiresAt).toISOString(), lastUsedAt: null };
    await this.saveSessions([session, ...(await this.sessions())].slice(0, MAX_SESSIONS));
    const proof = pairingProof(key, sid, expiresAt);
    wipe(key);
    return ok({ sid, expiresAt, proof });
  },

  /** Pedido cifrado de uma extensão pareada. */
  async rpc(body: any): Promise<HttpResult> {
    const sid = typeof body.sid === 'string' && ID_RE.test(body.sid) ? body.sid : '';
    const session = (await this.sessions()).find(s => s.id === sid);
    if (!session) return fail(401, 'session', BRIDGE_MSG.session);
    const key = fromB64(session.key);
    try {
      let msg: any;
      try {
        msg = open(key, sid, 'req', body);
      } catch {
        return fail(401, 'auth', BRIDGE_MSG.auth);
      }
      if (typeof msg.ts !== 'number' || Math.abs(Date.now() - msg.ts) > CLOCK_SKEW_MS) return fail(401, 'clock', BRIDGE_MSG.clock);
      if (!replay.accept(sid, msg.nonce, msg.ts)) return fail(401, 'replay', BRIDGE_MSG.replay);
      await this.touch(sid);
      const result = await this.dispatch(msg, session);
      return ok(seal(key, sid, 'res', { ...result, re: msg.nonce }));
    } finally {
      wipe(key);
    }
  },

  async dispatch(msg: any, session: BridgeSession): Promise<object> {
    if (msg.op === 'ping') return { ok: true, name: session.name, expiresAt: Date.parse(session.expiresAt) };
    if (msg.op === 'revoke') {
      await this.revoke(session.id);
      return { ok: true };
    }
    const url = validPageUrl(msg.url);
    if (!url) return { error: BRIDGE_MSG.badUrl, code: 'url' };
    if (msg.op === 'list') return this.list(url);
    if (msg.op === 'get') return this.get(url, String(msg.credentialId || '').slice(0, 64), session);
    return { error: BRIDGE_MSG.unknown, code: 'op' };
  },

  /** Logins do site (sem senhas). Um site com cara de phishing não recebe nem a lista. */
  async list(url: string): Promise<object> {
    const creds = await Repo.credentials();
    const folders = await Repo.folders();
    const verdict = analyzeDomain(url, trustedDomains(creds));
    if (verdict.level === 'danger') return { error: MSG.phishing(verdict.similarTo || verdict.domain), code: 'phishing' };
    const items = credentialsFor(creds, { url })
      .filter(({ cred }) => !usableCredential(cred, folders))
      .slice(0, MAX_LIST_ITEMS)
      .map(({ cred }) => ({ id: cred.id, title: cred.title, username: cred.username }));
    return { domain: hostnameOf(url), items, warning: verdict.level === 'warning' ? verdict.reasons.join('. ') : undefined };
  },

  /** Senha de uma credencial: correspondência + anti-phishing + regra da pasta + "Permitir" no celular. */
  async get(url: string, credentialId: string, session: BridgeSession): Promise<object> {
    const creds = await Repo.credentials();
    const folders = await Repo.folders();
    const cred = creds.find(c => c.id === credentialId) || null;
    const problem = usableCredential(cred, folders);
    if (problem || !cred) return { error: problem, code: 'credential' };
    const check = verifyBeforeFill(cred, { url }, trustedDomains(creds));
    if (check.verdict?.level === 'danger') return { error: MSG.phishing(check.verdict.similarTo || check.verdict.domain), code: 'phishing' };
    if (!check.match) return { error: MSG.noMatch, code: 'nomatch' };
    // Contra "cansaço de confirmação": uma extensão não enfileira vários pedidos de senha no celular
    if (BridgeApprovals.pending().some(a => a.sessionId === session.id)) return { error: BRIDGE_MSG.busy, code: 'busy' };
    const allow = await BridgeApprovals.request({
      kind: 'password',
      sessionId: session.id,
      title: 'Permitir preenchimento?',
      message: `A extensão "${session.name}" pede o login de ${cred.title} para ${hostnameOf(url)}.`,
    });
    if (!allow) return { error: BRIDGE_MSG.denied, code: 'denied' };
    if (PolicyService.forCredential(folders, cred).requireReauth) {
      try {
        await confirmIdentity();
      } catch (e: any) {
        return { error: String(e?.message || MSG.reauth), code: 'reauth' };
      }
    }
    if (!Vault.isUnlocked) return { error: BRIDGE_MSG.locked, code: 'locked' };
    await Repo.recordUsage(cred.id);
    return { id: cred.id, username: cred.username, password: cred.password };
  },
};
