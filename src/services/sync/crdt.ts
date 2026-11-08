// CRDT da sincronização: LWW-Map por documento, com granularidade por campo, relógio lógico
// híbrido (HLC) e lápides (tombstones).
//
// Estado de um documento:
//   fields: { campo → { v: valor, t: HLC da última escrita } }
//   del:    lápide { t: HLC da exclusão, seen: { campo → HLC que o aparelho conhecia ao excluir } } | null
//
// Fusão (merge), campo a campo: vence o maior HLC. HLCs iguais (só acontece com o mesmo evento) desempatam pelo
// valor serializado, de forma determinística. As lápides se fundem pelo maior HLC e pelo máximo ponto a ponto
// de `seen`. Cada parte é um semirreticulado (máximo numa ordem total), então a fusão é comutativa, associativa
// e idempotente: aparelhos que receberam as mesmas mudanças, em qualquer ordem, chegam ao mesmo estado.
//
// Regra de exclusão × edição concorrente ("a edição vence"):
//   o documento está excluído somente se a lápide cobre TODOS os campos, isto é, nenhum campo foi escrito depois
//   do que o aparelho que excluiu conhecia (fields[c].t ≤ del.seen[c]). Se outro aparelho editou qualquer campo
//   sem ter visto a exclusão, o documento volta com todos os campos (os valores ficam na lápide) e nada se perde.
//   Uma exclusão feita depois de ver a edição cobre essa edição e vence.

/** HLC: tempo físico em ms (15 dígitos) : contador (6 dígitos) : id do nó. A ordem do texto é a ordem do relógio. */
export const HLC_RE = /^\d{15}:\d{6}:[a-z0-9]{1,32}$/;
export const NODE_RE = /^[a-z0-9]{1,32}$/;
/** Um relógio remoto mais de 24 h no futuro não arrasta o relógio local (proteção contra relógio errado). */
export const MAX_DRIFT_MS = 24 * 60 * 60 * 1000;
const MAX_COUNTER = 999999;
/** Campos por documento (limite contra estados remotos absurdos). */
export const MAX_FIELDS = 200;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface FieldEntry {
  v: unknown;
  t: string;
}

export interface Tombstone {
  t: string;
  seen: Record<string, string>;
}

export interface DocState {
  fields: Record<string, FieldEntry>;
  del: Tombstone | null;
}

export const isHlc = (v: unknown): v is string => typeof v === 'string' && HLC_RE.test(v);

export function formatHlc(wall: number, counter: number, node: string): string {
  return `${String(wall).padStart(15, '0')}:${String(counter).padStart(6, '0')}:${node}`;
}

export function parseHlc(s: string): { wall: number; counter: number; node: string } | null {
  if (!isHlc(s)) return null;
  const [wall, counter, node] = s.split(':');
  return { wall: Number(wall), counter: Number(counter), node };
}

const maxHlc = (a: string, b: string) => (a >= b ? a : b);

/** Relógio lógico híbrido (Kulkarni et al.): monotônico mesmo com o relógio do aparelho voltando no tempo. */
export class HybridClock {
  private wall = 0;
  private counter = 0;

  constructor(readonly node: string, private readonly now: () => number = Date.now) {
    if (!NODE_RE.test(node)) throw new Error('Id de nó inválido para o relógio');
  }

  /** Novo carimbo para um evento local. */
  tick(): string {
    const pt = this.now();
    if (pt > this.wall) {
      this.wall = pt;
      this.counter = 0;
    } else {
      this.bump();
    }
    return formatHlc(this.wall, this.counter, this.node);
  }

  /** Incorpora um carimbo recebido (regra de recebimento do HLC). */
  observe(remote: string): void {
    const r = parseHlc(remote);
    const pt = this.now();
    if (!r || r.wall > pt + MAX_DRIFT_MS) return;
    const wall = Math.max(this.wall, r.wall, pt);
    if (wall === this.wall && wall === r.wall) this.counter = Math.max(this.counter, r.counter);
    else if (wall === r.wall) this.counter = r.counter;
    else if (wall !== this.wall) this.counter = -1;
    this.wall = wall;
    this.bump();
  }

  /** Último carimbo emitido (persistido entre sessões). */
  last(): string {
    return formatHlc(this.wall, Math.max(0, this.counter), this.node);
  }

  private bump() {
    this.counter += 1;
    if (this.counter > MAX_COUNTER) {
      this.wall += 1;
      this.counter = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Serialização estável (comparação de valores independente da ordem das chaves)
// ---------------------------------------------------------------------------
export function stableStringify(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter(k => obj[k] !== undefined)
    .sort();
  const parts = keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k]));
  return '{' + parts.join(',') + '}';
}

const sameValue = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

// ---------------------------------------------------------------------------
// Fusão
// ---------------------------------------------------------------------------
function pickEntry(a: FieldEntry | undefined, b: FieldEntry | undefined): FieldEntry | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.t !== b.t) return a.t > b.t ? a : b;
  // Empate com um lado já apagado (lápide sem valores, ver scrubDead): o valor real não pode perder para o null
  if ((a.v === null) !== (b.v === null)) return a.v === null ? b : a;
  return stableStringify(a.v) >= stableStringify(b.v) ? a : b;
}

function mergeTombstones(a: Tombstone | null, b: Tombstone | null): Tombstone | null {
  if (!a || !b) return a || b ? { t: (a || b)!.t, seen: { ...(a || b)!.seen } } : null;
  const seen: Record<string, string> = {};
  for (const k of [...new Set([...Object.keys(a.seen), ...Object.keys(b.seen)])].sort()) {
    seen[k] = maxHlc(a.seen[k] || '', b.seen[k] || '');
  }
  return { t: maxHlc(a.t, b.t), seen };
}

/** Fusão pura de dois estados (comutativa, associativa e idempotente). */
export function mergeStates(a: DocState | null, b: DocState | null): DocState | null {
  if (!a && !b) return null;
  const fa = a?.fields || {};
  const fb = b?.fields || {};
  const fields: Record<string, FieldEntry> = {};
  for (const k of [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort()) {
    const e = pickEntry(fa[k], fb[k])!;
    fields[k] = { v: e.v, t: e.t };
  }
  return { fields, del: mergeTombstones(a?.del ?? null, b?.del ?? null) };
}

/** O documento existe? (veja a regra de exclusão × edição no topo do arquivo) */
export function isAlive(state: DocState | null): boolean {
  if (!state) return false;
  const entries = Object.entries(state.fields);
  if (!entries.length) return false;
  if (!state.del) return true;
  const seen = state.del.seen;
  return entries.some(([k, f]) => !Object.prototype.hasOwnProperty.call(seen, k) || f.t > seen[k]);
}

/**
 * Exclusão segura: a lápide só precisa dos carimbos (HLC) para decidir exclusão × edição, não dos valores.
 * Um estado excluído perde os valores dos campos (senha, notas…), senão ficariam para sempre no kv local e no
 * bloco enviado ao servidor mesmo depois de o documento ser sobrescrito e apagado do banco.
 */
export function scrubDead(state: DocState): DocState {
  if (!state.del || isAlive(state)) return state;
  const fields: Record<string, FieldEntry> = {};
  for (const [k, f] of Object.entries(state.fields)) fields[k] = { v: null, t: f.t };
  return { fields, del: state.del };
}

/** Documento visível a partir do estado (ou null se excluído). */
export function materialize(state: DocState | null, id: string): Record<string, unknown> | null {
  if (!state || !isAlive(state)) return null;
  const doc: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(state.fields)) doc[k] = f.v;
  doc.id = id;
  return doc;
}

/** Maior HLC do estado (enviado ao servidor como metadado de ordenação). */
export function stateClock(state: DocState): string {
  let max = state.del?.t || '';
  for (const f of Object.values(state.fields)) max = maxHlc(max, f.t);
  return max;
}

/** Todos os carimbos do estado (para o relógio local observar). */
export function stateClocks(state: DocState): string[] {
  const out = Object.values(state.fields).map(f => f.t);
  if (state.del) out.push(state.del.t);
  return out;
}

// ---------------------------------------------------------------------------
// Captura de mudanças locais
// ---------------------------------------------------------------------------
/** Exclusão local: a lápide registra o HLC de cada campo que este aparelho conhecia ao excluir. */
function captureDelete(state: DocState | null, clock: HybridClock): { state: DocState | null; changed: boolean } {
  if (!state || !isAlive(state)) return { state, changed: false };
  const seen: Record<string, string> = { ...(state.del?.seen || {}) };
  for (const [k, f] of Object.entries(state.fields)) seen[k] = maxHlc(seen[k] || '', f.t);
  return { state: { fields: { ...state.fields }, del: { t: clock.tick(), seen } }, changed: true };
}

const ignoredField = (k: string, v: unknown) => k === 'id' || FORBIDDEN_KEYS.has(k) || v === undefined;

/**
 * Compara o documento atual do banco com o estado CRDT e carimba os campos que mudaram.
 * `doc` null significa que o documento foi excluído localmente (gera a lápide).
 */
export function captureLocal(state: DocState | null, doc: Record<string, unknown> | null, clock: HybridClock): { state: DocState | null; changed: boolean } {
  if (!doc) return captureDelete(state, clock);
  const fields: Record<string, FieldEntry> = { ...(state?.fields || {}) };
  // Recriado com o mesmo id depois de excluído (ex.: restauração): todos os campos ganham carimbo novo.
  const revive = !!state && !isAlive(state);
  let changed = false;
  for (const [k, v] of Object.entries(doc)) {
    if (ignoredField(k, v)) continue;
    if (revive || !fields[k] || !sameValue(fields[k].v, v)) {
      fields[k] = { v: JSON.parse(JSON.stringify(v)), t: clock.tick() };
      changed = true;
    }
  }
  // Campo removido do documento: vira null (a remoção também é uma escrita LWW).
  const removed = Object.keys(fields).filter(k => !Object.prototype.hasOwnProperty.call(doc, k) && fields[k].v !== null);
  for (const k of removed) fields[k] = { v: null, t: clock.tick() };
  return { state: { fields, del: state?.del ?? null }, changed: changed || removed.length > 0 };
}

// ---------------------------------------------------------------------------
// Validação do estado recebido (já decifrado) de outro aparelho
// ---------------------------------------------------------------------------
function validHlcMap(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const entries = Object.entries(v as Record<string, unknown>);
  return entries.length <= MAX_FIELDS && entries.every(([k, t]) => !FORBIDDEN_KEYS.has(k) && isHlc(t));
}

function parseFields(fields: unknown): Record<string, FieldEntry> | null {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null;
  const entries = Object.entries(fields as Record<string, unknown>);
  if (entries.length > MAX_FIELDS) return null;
  const out: Record<string, FieldEntry> = {};
  for (const [k, e] of entries) {
    const entry = e as FieldEntry;
    const valid = !FORBIDDEN_KEYS.has(k) && k !== 'id' && !!entry && typeof entry === 'object' && isHlc(entry.t) && Object.prototype.hasOwnProperty.call(entry, 'v');
    if (!valid) return null;
    out[k] = { v: entry.v, t: entry.t };
  }
  return out;
}

/** Valida a estrutura e devolve um estado limpo (sem chaves perigosas), ou null se inválido. */
export function parseState(raw: unknown): DocState | null {
  if (!raw || typeof raw !== 'object') return null;
  const { fields, del } = raw as { fields?: unknown; del?: unknown };
  const out = parseFields(fields);
  if (!out) return null;
  if (del === null || del === undefined) return { fields: out, del: null };
  const d = del as Tombstone;
  if (!isHlc(d.t) || !validHlcMap(d.seen)) return null;
  return { fields: out, del: { t: d.t, seen: { ...d.seen } } };
}
