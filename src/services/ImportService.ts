// Importação de senhas de outros gerenciadores
// Fluxo: ler o arquivo → detectar o formato → (abrir o envelope cifrado, se houver) → prévia com quantas
// entradas são novas, duplicadas ou com erro → aplicar com a escolha para duplicadas (ignorar / substituir /
// manter as duas). Nada é gravado antes da confirmação na prévia.
// Defesas: limite de tamanho do arquivo e de itens, parser CSV com limites, campos validados um a um
// (sanitize.ts), pastas com nome e profundidade limitados.

import { fromB64, fromUtf8, uuid } from '../crypto';
import { vaultDb } from '../db/Database';
import { Credential, Folder, FormItem, SecureNote } from '../types/models';
import { hostnameOf } from '../utils';
import { bus, Events } from './events';
import { Vault } from './VaultService';
import { LIMITS, MAX_FOLDER_DEPTH, newCredential, newFolder, Repo } from './Repository';
import { decryptEnvelope, EncryptedEnvelope, isEncryptedEnvelope } from './transfer/envelope';
import { ImportFormat, ImportFormatError, ImportFormatLabels, ImportKind, parseCsvFile, parseJsonFile, ParsedFile, RawItem } from './transfer/formats';
import { sanitizeCredential, sanitizeForm, sanitizeNote } from './transfer/sanitize';

/** Maior arquivo aceito para importar (CSV/JSON). */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
/** Máximo de itens por importação. */
export const MAX_IMPORT_ITEMS = 5000;
/** Mensagem do cenário BDD "Importação de CSV válida". */
export const IMPORT_SUCCESS = 'Importação concluída com sucesso';

export type DuplicateStrategy = 'skip' | 'replace' | 'keep_both';
export const DuplicateStrategyLabels: Record<DuplicateStrategy, string> = { skip: 'Ignorar', replace: 'Substituir', keep_both: 'Manter as duas' };

export type ItemStatus = 'new' | 'duplicate' | 'error';

export interface PreviewItem {
  raw: RawItem;
  status: ItemStatus;
  /** Dados já validados (ausente quando status = error). */
  data?: Partial<Credential> | Partial<SecureNote> | Partial<FormItem>;
  /** Id do registro existente igual (status = duplicate). */
  duplicateOf?: string;
  error?: string;
  /** Rótulo curto para a lista da prévia (título, sem senha). */
  label: string;
}

export interface ImportPreview {
  fileName: string;
  /** Perfil cujo cofre gerou a prévia: a gravação só vale nele (um bloqueio no meio invalida a prévia). */
  profileId?: string | null;
  format: ImportFormat;
  formatLabel: string;
  items: PreviewItem[];
  counts: { total: number; new: number; duplicate: number; error: number; credentials: number; notes: number; forms: number };
}

export interface ImportResult {
  added: number;
  replaced: number;
  skipped: number;
  failed: number;
  errors: string[];
}

export type ReadResult = { kind: 'parsed'; parsed: ParsedFile } | { kind: 'encrypted'; envelope: EncryptedEnvelope };

/** Arquivo devolvido pelo seletor nativo (CustodiaTransfer.pickFile). */
export interface ImportFile {
  name: string;
  mime: string;
  size: number;
  base64: string;
}

function parseText(text: string): ReadResult {
  const trimmed = text.replace(/^﻿/, '').trimStart();
  if (!trimmed) throw new ImportFormatError('o arquivo está vazio');
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let json: any;
    try {
      json = JSON.parse(trimmed);
    } catch {
      throw new ImportFormatError('JSON inválido');
    }
    if (isEncryptedEnvelope(json)) return { kind: 'encrypted', envelope: json };
    return { kind: 'parsed', parsed: limitItems(parseJsonFile(json)) };
  }
  return { kind: 'parsed', parsed: parseCsvFile(trimmed, MAX_IMPORT_ITEMS) };
}

function limitItems(p: ParsedFile): ParsedFile {
  if (p.items.length > MAX_IMPORT_ITEMS) throw new ImportFormatError(`o arquivo passa do limite de ${MAX_IMPORT_ITEMS} itens`);
  return p;
}

// ---------------------------------------------------------------------------
// Duplicadas
// ---------------------------------------------------------------------------
const credKey = (c: Partial<Credential>) => {
  const host = hostnameOf(c.url || '');
  return `${host || (c.title || '').trim().toLowerCase()}|${(c.username || '').trim().toLowerCase()}`;
};
const noteKey = (n: Partial<SecureNote>) => `${(n.title || '').trim().toLowerCase()}|${(n.content || '').length}|${(n.content || '').slice(0, 64)}`;
const formKey = (f: any) => `${f.kind}|${String(f.label || '').trim().toLowerCase()}|${String(f.number || f.cpf || f.zipCode || '').replace(/\D/g, '')}`;

interface Existing {
  byKey: Map<string, string>;
  ids: Set<string>;
}

async function existingIndex(): Promise<Record<ImportKind, Existing>> {
  const build = (docs: any[], key: (d: any) => string): Existing => ({ byKey: new Map(docs.map(d => [key(d), d.id])), ids: new Set(docs.map(d => d.id)) });
  return {
    credential: build(await Repo.credentials(), credKey),
    note: build(await vaultDb.all<SecureNote>('notes'), noteKey),
    form: build(await vaultDb.all<FormItem>('forms'), formKey),
  };
}

const KEYS: Record<ImportKind, (d: any) => string> = { credential: credKey, note: noteKey, form: formKey };
const SANITIZERS: Record<ImportKind, (d: any) => any> = { credential: sanitizeCredential, note: sanitizeNote, form: sanitizeForm };
const RAW_DATA = (r: RawItem) => (r.kind === 'credential' ? r.credential : r.kind === 'note' ? r.note : r.form);

function classify(raw: RawItem, existing: Record<ImportKind, Existing>, seen: Set<string>): PreviewItem {
  const fallbackLabel = `Item ${raw.line}`;
  if (raw.error) return { raw, status: 'error', error: raw.error, label: fallbackLabel };
  let data: any;
  try {
    data = SANITIZERS[raw.kind](RAW_DATA(raw));
  } catch (e: any) {
    return { raw, status: 'error', error: `Linha ${raw.line}: ${e?.message || 'dados inválidos'}`, label: fallbackLabel };
  }
  const label = String(data.title || data.label || fallbackLabel);
  const key = `${raw.kind}:${KEYS[raw.kind](data)}`;
  const ex = existing[raw.kind];
  // O mesmo registro (mesmo id do Custódia) ou um igual (mesmo site + usuário) já está no cofre
  const dupId = (raw.sourceId && ex.ids.has(raw.sourceId) ? raw.sourceId : undefined) || ex.byKey.get(KEYS[raw.kind](data));
  if (dupId) return { raw, status: 'duplicate', data, duplicateOf: dupId, label };
  // Repetido dentro do próprio arquivo: a segunda ocorrência conta como duplicada
  if (seen.has(key)) return { raw, status: 'duplicate', data, label };
  seen.add(key);
  return { raw, status: 'new', data, label };
}

// ---------------------------------------------------------------------------
// Pastas
// ---------------------------------------------------------------------------
class FolderResolver {
  private cache = new Map<string, string>();
  constructor(private folders: Folder[]) {}

  async resolve(path: string[]): Promise<string | null> {
    let parent: string | null = null;
    for (const rawName of path.slice(0, MAX_FOLDER_DEPTH)) {
      const name = rawName.slice(0, LIMITS.folderName).trim();
      if (!name) continue;
      const cacheKey = `${parent}|${name.toLowerCase()}`;
      let id = this.cache.get(cacheKey);
      if (!id) {
        const found = this.folders.find(f => f.parentId === parent && f.name.trim().toLowerCase() === name.toLowerCase());
        if (found) id = found.id;
        else {
          const folder = newFolder(name, parent);
          await Repo.saveFolder(folder);
          this.folders.push(folder);
          id = folder.id;
        }
        this.cache.set(cacheKey, id);
      }
      parent = id;
    }
    return parent;
  }
}

// ---------------------------------------------------------------------------
// Gravação
// ---------------------------------------------------------------------------
const now = () => new Date().toISOString();

async function writeCredential(item: PreviewItem, folderId: string | null, replaceId: string | undefined) {
  const data = item.data as Partial<Credential>;
  const existing = replaceId ? await Repo.credential(replaceId) : null;
  if (existing) {
    await Repo.saveCredential({ ...existing, ...data, id: existing.id, folderId: item.raw.folderPath.length ? folderId : existing.folderId, createdAt: existing.createdAt }, 'import');
    return;
  }
  await Repo.saveCredential(newCredential({ ...data, folderId }), 'import');
}

async function writeNote(item: PreviewItem, folderId: string | null, replaceId: string | undefined) {
  const data = item.data as Partial<SecureNote>;
  const existing = replaceId ? await vaultDb.get<SecureNote>('notes', replaceId) : null;
  const ts = now();
  const note: SecureNote = {
    title: '',
    content: '',
    category: 'other',
    favorite: false,
    attachments: [],
    createdAt: ts,
    ...existing,
    ...data,
    id: existing?.id || uuid(),
    folderId: item.raw.folderPath.length || !existing ? folderId : existing.folderId,
    updatedAt: ts,
  } as SecureNote;
  await vaultDb.put('notes', note);
}

async function writeForm(item: PreviewItem, replaceId: string | undefined) {
  const existing = replaceId ? await vaultDb.get<FormItem>('forms', replaceId) : null;
  const ts = now();
  const form = { createdAt: ts, ...existing, ...(item.data as any), id: existing?.id || uuid(), updatedAt: ts } as FormItem;
  await vaultDb.put('forms', form);
}

/** Grava um item da prévia, contando o resultado (adicionado, substituído ou com falha). */
async function writeItem(item: PreviewItem, strategy: DuplicateStrategy, folders: FolderResolver, result: ImportResult) {
  const replaceId = item.status === 'duplicate' && strategy === 'replace' ? item.duplicateOf : undefined;
  try {
    const folderId = item.raw.kind === 'form' ? null : await folders.resolve(item.raw.folderPath);
    if (item.raw.kind === 'credential') await writeCredential(item, folderId, replaceId);
    else if (item.raw.kind === 'note') await writeNote(item, folderId, replaceId);
    else await writeForm(item, replaceId);
    if (replaceId) result.replaced++;
    else result.added++;
  } catch (e: any) {
    result.failed++;
    result.errors.push(`${item.label}: ${e?.message || 'falha ao gravar'}`);
  }
}

export const ImportService = {
  /** Converte o arquivo escolhido em texto, aplicando o limite de tamanho. */
  decodeFile(file: ImportFile): string {
    if (!file || typeof file.base64 !== 'string') throw new ImportFormatError('arquivo ilegível');
    const size = Math.max(file.size || 0, Math.floor((file.base64.length * 3) / 4));
    if (size > MAX_IMPORT_BYTES) throw new ImportFormatError(`o arquivo passa de ${MAX_IMPORT_BYTES / 1024 / 1024} MB`);
    return fromUtf8(fromB64(file.base64));
  },

  /** Detecta o formato. Um JSON cifrado do Custódia volta como `encrypted` e precisa da senha do arquivo. */
  read(text: string): ReadResult {
    if (text.length > MAX_IMPORT_BYTES) throw new ImportFormatError(`o arquivo passa de ${MAX_IMPORT_BYTES / 1024 / 1024} MB`);
    return parseText(text);
  },

  /** Abre a exportação cifrada com a senha temporária. Senha errada: "Falha na descriptografia. Senha inválida." */
  async unlock(envelope: EncryptedEnvelope, password: string, opts?: { minIterations?: number }): Promise<ParsedFile> {
    if (envelope.kind === 'inventory') throw new ImportFormatError('o inventário de contas não contém senhas e não pode ser importado');
    const text = await decryptEnvelope(envelope, password, opts);
    const r = parseText(text);
    if (r.kind !== 'parsed') throw new ImportFormatError('arquivo cifrado dentro de arquivo cifrado');
    return r.parsed;
  },

  /** Prévia: nada é gravado. Conta novas, duplicadas e com erro. */
  async preview(parsed: ParsedFile, fileName = 'arquivo'): Promise<ImportPreview> {
    const existing = await existingIndex();
    const seen = new Set<string>();
    const items = parsed.items.map(raw => classify(raw, existing, seen));
    const count = (s: ItemStatus) => items.filter(i => i.status === s).length;
    const kind = (k: ImportKind) => items.filter(i => i.raw.kind === k && i.status !== 'error').length;
    return {
      fileName,
      profileId: vaultDb.profileId,
      format: parsed.format,
      formatLabel: ImportFormatLabels[parsed.format],
      items,
      counts: { total: items.length, new: count('new'), duplicate: count('duplicate'), error: count('error'), credentials: kind('credential'), notes: kind('note'), forms: kind('form') },
    };
  },

  /** Grava a prévia confirmada. Itens com erro nunca são gravados. */
  async apply(preview: ImportPreview, strategy: DuplicateStrategy): Promise<ImportResult> {
    const result: ImportResult = { added: 0, replaced: 0, skipped: 0, failed: preview.counts.error, errors: preview.items.filter(i => i.error).map(i => i.error!) };
    const guard = () => {
      // Cofre bloqueado (ou trocado por outro perfil) no meio da importação: nada mais é gravado
      if (!Vault.isUnlocked || (preview.profileId && preview.profileId !== vaultDb.profileId)) throw new Error('O cofre foi bloqueado durante a importação. Desbloqueie e tente de novo.');
    };
    guard();
    const folders = new FolderResolver(await Repo.folders());
    for (const item of preview.items) {
      guard();
      if (item.status === 'error') continue;
      if (item.status === 'duplicate' && strategy === 'skip') {
        result.skipped++;
        continue;
      }
      await writeItem(item, strategy, folders, result);
    }
    bus.emit(Events.DATA_CHANGED);
    return result;
  },

  /** Resumo para a mensagem final da interface. */
  summary(r: ImportResult): string {
    const parts = [`${r.added} ${r.added === 1 ? 'item adicionado' : 'itens adicionados'}`];
    if (r.replaced) parts.push(`${r.replaced} ${r.replaced === 1 ? 'substituído' : 'substituídos'}`);
    if (r.skipped) parts.push(`${r.skipped} ${r.skipped === 1 ? 'duplicado ignorado' : 'duplicados ignorados'}`);
    if (r.failed) parts.push(`${r.failed} com erro`);
    return parts.join(', ');
  },
};
