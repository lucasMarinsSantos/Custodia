// Vazamentos de senhas: Have I Been Pwned "Pwned Passwords" com k-anonimato
//
// Privacidade: o SHA-1 da senha é calculado no aparelho e só os 5 primeiros caracteres do hash (o "prefixo") vão
// para https://api.pwnedpasswords.com/range/XXXXX. A API devolve centenas de sufixos com esse prefixo e a
// comparação com o resto do hash é feita aqui. O cabeçalho Add-Padding faz a API completar a resposta com sufixos
// falsos (contagem 0), para o tamanho da resposta não revelar nada. Nenhum dado do cofre vai na URL além do prefixo.
//
// Cache: por credencial, guardado no banco cifrado (kv), com o prefixo, a data da verificação e a data de troca
// da senha, nunca a senha nem o hash completo. Enquanto a senha não muda e o resultado tem menos de 7 dias, a API
// não é consultada de novo. Os intervalos baixados ficam só na memória e são descartados ao bloquear.

import { sha1 } from '@noble/hashes/sha1';
import { vaultDb } from '../db/Database';
import { toHex, utf8 } from '../crypto';
import { Credential } from '../types/models';
import { AlertService } from './AlertService';
import { Net } from '../native/net';

export const HIBP_RANGE_URL = 'https://api.pwnedpasswords.com/range/';
export const HIBP_TIMEOUT_MS = 10000;
/** Resultado guardado vale por 7 dias (a base do HIBP muda devagar). */
export const BREACH_CACHE_DAYS = 7;
/** Verificação automática de todo o cofre no máximo a cada 7 dias. */
export const BREACH_PERIOD_DAYS = 7;
/** Uma resposta normal tem ~30 KB (com preenchimento, ~40 KB); acima disso é tratada como inválida. */
export const MAX_RESPONSE_CHARS = 1024 * 1024;
const MAX_LINES = 20000;
const DAY = 86400000;
const KV_CACHE = 'breachCache';
const KV_LAST_RUN = 'breachLastRun';

export const OFFLINE_MESSAGE = 'Sem conexão com a internet. A verificação de vazamentos não foi feita; tente de novo quando houver rede.';
export const BREACH_MESSAGE = 'Esta senha já apareceu em vazamentos de dados';

const UNEXPECTED_RESPONSE = 'Resposta inesperada do serviço de vazamentos';

export class BreachOfflineError extends Error {
  constructor(message = OFFLINE_MESSAGE) {
    super(message);
    this.name = 'BreachOfflineError';
  }
}

/** Registro do cache: nada que permita recuperar a senha (o prefixo tem só 20 bits do hash). */
export interface BreachEntry {
  prefix: string;
  checkedAt: string;
  /** passwordChangedAt da credencial quando foi verificada: se a senha mudar, o cache deixa de valer. */
  pwChangedAt: string;
  count: number;
}

export type BreachState = 'pwned' | 'safe' | 'unknown';

export interface BreachStatus {
  state: BreachState;
  count: number;
  checkedAt: string | null;
}

export interface BreachResult {
  id: string;
  title: string;
  count: number;
  cached: boolean;
}

export interface BreachRun {
  results: BreachResult[];
  checked: number;
  pwned: number;
  /** Parou por falta de rede: `results` tem só o que deu tempo de verificar (ou o que estava no cache). */
  offline: boolean;
  error?: string;
}

/** SHA-1 em hexadecimal maiúsculo (formato da API). */
export function sha1Hex(password: string): string {
  return toHex(sha1(utf8(password))).toUpperCase();
}

/** Lê "SUFIXO:CONTAGEM" por linha; ignora linhas malformadas e o preenchimento (contagem 0). */
export function parseRange(text: string): Map<string, number> {
  if (text.length > MAX_RESPONSE_CHARS) throw new Error(UNEXPECTED_RESPONSE);
  const out = new Map<string, number>();
  const lines = text.split('\n');
  if (lines.length > MAX_LINES) throw new Error(UNEXPECTED_RESPONSE);
  for (const raw of lines) {
    const m = /^([0-9A-F]{35}):(\d{1,10})$/i.exec(raw.trim());
    if (!m) continue;
    const n = Number(m[2]);
    if (n > 0) out.set(m[1].toUpperCase(), n);
  }
  return out;
}

/** 1234567 → "1.234.567" (sem depender de Intl). */
export function formatCount(n: number): string {
  return String(Math.max(0, Math.floor(n))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

export function breachText(count: number): string {
  return count === 1 ? 'encontrada 1 vez' : `encontrada ${formatCount(count)} vezes`;
}

// Intervalos já baixados nesta sessão (vários registros podem cair no mesmo prefixo)
const ranges = new Map<string, Map<string, number>>();
// Cópia em memória do cache, para leituras síncronas (ordenação "Maior risco")
let snapshot: Record<string, BreachEntry> = {};
let writeChain: Promise<unknown> = Promise.resolve();

async function fetchRange(prefix: string): Promise<Map<string, number>> {
  if (!/^[0-9A-F]{5}$/.test(prefix)) throw new Error('Prefixo inválido');
  const cached = ranges.get(prefix);
  if (cached) return cached;
  const net = await Net.networkInfo().catch(() => null);
  if (net && !net.connected) throw new BreachOfflineError();
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl?.abort(), HIBP_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(HIBP_RANGE_URL + prefix, {
      method: 'GET',
      headers: { 'Add-Padding': 'true', Accept: 'text/plain' },
      signal: ctrl?.signal,
    });
  } catch {
    // Sem rede, DNS falhou ou tempo esgotado: o app segue funcionando
    throw new BreachOfflineError();
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`O serviço de vazamentos respondeu com erro (${res.status}). Tente mais tarde.`);
  const len = Number(res.headers?.get?.('content-length') || 0);
  if (len > MAX_RESPONSE_CHARS) throw new Error(UNEXPECTED_RESPONSE);
  const map = parseRange(await res.text());
  ranges.set(prefix, map);
  return map;
}

async function readCache(): Promise<Record<string, BreachEntry>> {
  if (!vaultDb.isOpen) return {};
  try {
    const raw = await vaultDb.getKv(KV_CACHE);
    const parsed = raw ? JSON.parse(raw) : {};
    snapshot = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    snapshot = {};
  }
  return snapshot;
}

/** Leitura-alteração-gravação do cache em fila (verificação automática e manual podem coincidir). */
function updateCache(change: (cache: Record<string, BreachEntry>) => void): Promise<void> {
  const run = writeChain.then(async () => {
    const cache = await readCache();
    change(cache);
    snapshot = cache;
    await vaultDb.setKv(KV_CACHE, JSON.stringify(cache));
  });
  writeChain = run.catch(() => {});
  return run;
}

/** O resultado guardado ainda vale para a senha atual da credencial? */
export function isFresh(entry: BreachEntry | undefined, cred: Pick<Credential, 'password' | 'passwordChangedAt'>, now = Date.now()): entry is BreachEntry {
  if (!entry || !cred.password) return false;
  if (entry.pwChangedAt !== cred.passwordChangedAt) return false;
  if (entry.prefix !== sha1Hex(cred.password).slice(0, 5)) return false;
  return now - Date.parse(entry.checkedAt) < BREACH_CACHE_DAYS * DAY;
}

interface CheckStep {
  result: BreachResult | null;
  offline?: boolean;
  error?: string;
}

/** Resultado do cache da sessão para a senha atual, ou null se não houver ou estiver vencido. */
function cachedResult(c: Credential): BreachResult | null {
  const entry = snapshot[c.id];
  return isFresh(entry, c) ? { id: c.id, title: c.title, count: entry.count, cached: true } : null;
}

export const BreachService = {
  /** Consulta uma senha (sem cache por credencial). Devolve quantas vezes ela aparece em vazamentos. */
  async pwnedCount(password: string): Promise<number> {
    const hash = sha1Hex(password);
    const map = await fetchRange(hash.slice(0, 5));
    return map.get(hash.slice(5)) || 0;
  },

  /** Verifica uma credencial, usando o cache quando ainda vale. Gera um alerta quando a senha vazou. */
  async checkCredential(cred: Credential, opts: { force?: boolean; alert?: boolean } = {}): Promise<BreachResult> {
    if (!cred.password) return { id: cred.id, title: cred.title, count: 0, cached: true };
    const cache = await readCache();
    const entry = cache[cred.id];
    if (!opts.force && isFresh(entry, cred)) return { id: cred.id, title: cred.title, count: entry.count, cached: true };
    const count = await this.pwnedCount(cred.password);
    const fresh: BreachEntry = { prefix: sha1Hex(cred.password).slice(0, 5), checkedAt: new Date().toISOString(), pwChangedAt: cred.passwordChangedAt, count };
    await updateCache(c => {
      c[cred.id] = fresh;
    });
    if (count > 0 && opts.alert !== false) {
      await AlertService.raise({
        type: 'breach',
        severity: 'danger',
        title: `Senha vazada: ${cred.title}`,
        message: `${BREACH_MESSAGE} (${breachText(count)}). Troque-a o quanto antes.`,
        ref: cred.id,
      });
    }
    return { id: cred.id, title: cred.title, count, cached: false };
  },

  /**
   * Verifica todo o cofre, uma credencial por vez (as que caem no mesmo prefixo usam o mesmo download).
   * Sem rede, para na primeira falha e devolve o que já tinha (inclusive o cache), sem travar a tela.
   */
  async checkAll(creds: Credential[], onProgress?: (done: number, total: number) => void, opts: { force?: boolean } = {}): Promise<BreachRun> {
    const list = creds.filter(c => !!c.password);
    const results: BreachResult[] = [];
    let offline = false;
    let error: string | undefined;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const step: CheckStep = offline ? { result: cachedResult(c) } : await this.tryCheck(c, !!opts.force);
      if (step.error) {
        error = step.error;
        break;
      }
      offline = offline || !!step.offline;
      if (step.result) results.push(step.result);
      onProgress?.(i + 1, list.length);
    }
    if (!offline && !error && vaultDb.isOpen) await vaultDb.setKv(KV_LAST_RUN, new Date().toISOString());
    await this.prune(creds.map(c => c.id));
    return { results, checked: results.length, pwned: results.filter(r => r.count > 0).length, offline, error: offline ? OFFLINE_MESSAGE : error };
  },

  /** Uma etapa de checkAll: o resultado, ou "sem rede" (com o que houver no cache), ou o erro que interrompe. */
  async tryCheck(c: Credential, force: boolean): Promise<CheckStep> {
    try {
      return { result: await this.checkCredential(c, { force }) };
    } catch (e: any) {
      if (e instanceof BreachOfflineError) return { result: cachedResult(c), offline: true };
      return { result: null, error: e?.message || 'Falha ao verificar vazamentos' };
    }
  },

  /** Situação de uma credencial a partir do cache (sem rede): vazada, segura ou ainda não verificada. */
  async status(cred: Credential): Promise<BreachStatus> {
    const entry: BreachEntry | undefined = (await readCache())[cred.id];
    const checkedAt = entry ? entry.checkedAt : null;
    if (!isFresh(entry, cred)) return { state: 'unknown', count: 0, checkedAt };
    return { state: entry.count > 0 ? 'pwned' : 'safe', count: entry.count, checkedAt: entry.checkedAt };
  },

  /** Cópia síncrona do cache (última leitura), para a ordenação por risco. */
  cachedEntries(): Record<string, BreachEntry> {
    return snapshot;
  },

  async load(): Promise<Record<string, BreachEntry>> {
    return readCache();
  },

  async lastRun(): Promise<string | null> {
    return vaultDb.isOpen ? vaultDb.getKv(KV_LAST_RUN) : null;
  },

  /** A verificação periódica está vencida? */
  async isDue(now = Date.now()): Promise<boolean> {
    const last = await this.lastRun();
    return !last || now - Date.parse(last) >= BREACH_PERIOD_DAYS * DAY;
  },

  /** Remove do cache registros de credenciais que não existem mais. */
  async prune(existingIds: string[]): Promise<void> {
    if (!vaultDb.isOpen) return;
    const keep = new Set(existingIds);
    const cache = await readCache();
    if (Object.keys(cache).every(id => keep.has(id))) return;
    await updateCache(c => {
      for (const id of Object.keys(c)) if (!keep.has(id)) delete c[id];
    });
  },

  async forget(id: string): Promise<void> {
    if (!vaultDb.isOpen) return;
    await updateCache(c => {
      delete c[id];
    });
  },

  /** Ao bloquear: descarta os intervalos baixados e a cópia do cache da memória. */
  clearMemory() {
    ranges.clear();
    snapshot = {};
  },
};
