// Notas seguras
// Texto livre (chaves de recuperação, Wi-Fi, dados bancários…) com categoria, pasta opcional, favorito e anexos.
// Tudo fica no banco SQLCipher: os anexos vão em base64 dentro do próprio documento da nota, nunca em arquivo solto.
// A exclusão é segura: o documento é sobrescrito com dados aleatórios antes do DELETE.

import { vaultDb } from '../db/Database';
import { fromB64, uuid } from '../crypto';
import { PickedFile } from '../native';
import { Folder, NoteAttachment, NoteCategory, NoteCategoryLabels, SecureNote } from '../types/models';
import { stripAccents } from '../utils';
import { ValidationError } from './Repository';
import { bus, Events } from './events';

const MB = 1024 * 1024;

/** Limites contra registros gigantes (entrada maliciosa ou arquivo escolhido por engano). */
export const NOTE_LIMITS = {
  title: 120,
  content: 50000,
  /** Quantidade máxima de anexos por nota. */
  attachments: 5,
  /** Tamanho máximo de cada anexo (bytes, antes do base64). */
  attachmentBytes: 5 * MB,
  /** Soma dos anexos de uma nota. */
  totalBytes: 15 * MB,
  attachmentName: 120,
  /** Quantidade máxima de notas no cofre (registros gigantes ou em massa vindos de importação/sincronização). */
  notes: 2000,
};

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const GENERIC_MIME = 'application/octet-stream';

/**
 * Tipos aceitos nos anexos. Os que têm assinatura conhecida ("magic bytes") são conferidos pelo conteúdo: um
 * arquivo que diz ser PNG mas não é (ex.: um executável renomeado) é recusado, e um tipo fora da lista é
 * guardado como binário genérico (nunca é pré-visualizado, só exportado).
 */
export const ALLOWED_MIMES = new Set([
  ...IMAGE_MIMES,
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/json',
  'application/zip',
  'application/x-pem-file',
  GENERIC_MIME,
]);

/** Assinaturas (primeiros bytes) dos tipos que podem ser conferidos pelo conteúdo. */
const SIGNATURES: { mime: string; test: (b: number[]) => boolean }[] = [
  { mime: 'image/png', test: b => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x) },
  { mime: 'image/jpeg', test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', test: b => String.fromCharCode(...b.slice(0, 4)) === 'GIF8' },
  { mime: 'image/webp', test: b => String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP' },
  { mime: 'application/pdf', test: b => String.fromCharCode(...b.slice(0, 5)) === '%PDF-' },
  { mime: 'application/zip', test: b => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 },
];

/** Decodifica só os primeiros bytes do base64 (o suficiente para as assinaturas), sem decodificar o arquivo todo. */
export function headBytes(b64: string, count = 16): number[] {
  const chunk = b64.slice(0, Math.ceil(count / 3) * 4);
  try {
    return Array.from(fromB64(chunk)).slice(0, count);
  } catch {
    return [];
  }
}

/** Tipo detectado pelo conteúdo, ou null se não tiver assinatura conhecida. */
export function sniffMime(b64: string): string | null {
  const head = headBytes(b64);
  return SIGNATURES.find(s => s.test(head))?.mime ?? null;
}

/**
 * MIME final do anexo: o declarado (pelo seletor do Android ou pelo arquivo importado) precisa bater com o
 * conteúdo quando o tipo tem assinatura; o detectado pelo conteúdo prevalece sobre um declarado genérico.
 */
export function resolveMime(declared: string, b64: string, name: string): string {
  const d = String(declared || '').toLowerCase().split(';')[0].trim();
  const sniffed = sniffMime(b64);
  const hasSignature = SIGNATURES.some(s => s.mime === d);
  if (hasSignature && sniffed !== d) throw new ValidationError(`O conteúdo de "${safeFileName(name)}" não corresponde ao tipo do arquivo`);
  if (sniffed) return sniffed;
  return ALLOWED_MIMES.has(d) ? d : GENERIC_MIME;
}
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
// Caracteres de controle e separadores de caminho não entram no nome (o nome vira sugestão ao salvar o arquivo)
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_RE = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;

const now = () => new Date().toISOString();

export function newNote(partial: Partial<SecureNote> = {}): SecureNote {
  const ts = now();
  return { id: uuid(), title: '', content: '', category: 'other', folderId: null, favorite: false, attachments: [], createdAt: ts, updatedAt: ts, ...partial };
}

/** Tamanho real (bytes) de um conteúdo base64; -1 se não for base64 válido. */
export function base64Size(b64: string): number {
  if (typeof b64 !== 'string' || b64.length % 4 !== 0 || !B64_RE.test(b64)) return -1;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

/** Nome de arquivo seguro: sem caminho, sem caracteres de controle e com tamanho limitado. */
export function safeFileName(name: string): string {
  const clean = String(name || '')
    .replace(UNSAFE_NAME_RE, '_')
    .replace(/^\.+/, '')
    .trim();
  return (clean || 'anexo').slice(0, NOTE_LIMITS.attachmentName);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${Math.round(n / 1024)} KB`;
  return `${(n / MB).toFixed(1).replace('.', ',')} MB`;
}

export const isPreviewableImage = (a: Pick<NoteAttachment, 'mime'>) => IMAGE_MIMES.has(a.mime);

function checkAttachment(a: NoteAttachment): NoteAttachment {
  const size = base64Size(a.data);
  if (size < 0) throw new ValidationError(`O anexo "${safeFileName(a.name)}" está corrompido`);
  if (size > NOTE_LIMITS.attachmentBytes) throw new ValidationError(`Cada anexo pode ter até ${formatBytes(NOTE_LIMITS.attachmentBytes)}`);
  const mime = resolveMime(a.mime, a.data, a.name);
  return { id: typeof a.id === 'string' && a.id ? a.id : uuid(), name: safeFileName(a.name), mime, size, data: a.data };
}

function checkAttachments(list: NoteAttachment[]): NoteAttachment[] {
  if (!Array.isArray(list)) return [];
  if (list.length > NOTE_LIMITS.attachments) throw new ValidationError(`Use no máximo ${NOTE_LIMITS.attachments} anexos por nota`);
  const out = list.map(checkAttachment);
  if (out.reduce((acc, a) => acc + a.size, 0) > NOTE_LIMITS.totalBytes) {
    throw new ValidationError(`Os anexos de uma nota podem somar até ${formatBytes(NOTE_LIMITS.totalBytes)}`);
  }
  return out;
}

function validate(note: SecureNote): void {
  if (typeof note.title !== 'string' || !note.title.trim()) throw new ValidationError('O título é obrigatório');
  if (note.title.trim().length > NOTE_LIMITS.title) throw new ValidationError(`O título pode ter até ${NOTE_LIMITS.title} caracteres`);
  if (typeof note.content !== 'string' && note.content != null) throw new ValidationError('O texto da nota é inválido');
  if (String(note.content ?? '').length > NOTE_LIMITS.content) throw new ValidationError(`O texto da nota pode ter até ${NOTE_LIMITS.content} caracteres`);
}

const norm = (s: string) => stripAccents(String(s || '').toLowerCase());

/** Só os campos conhecidos, com os tipos certos (registros vindos de importação ou sincronização). */
function normalizeNote(n: SecureNote): SecureNote {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    id: str(n.id) || uuid(),
    title: str(n.title),
    content: str(n.content),
    category: Object.prototype.hasOwnProperty.call(NoteCategoryLabels, n.category) ? n.category : 'other',
    folderId: typeof n.folderId === 'string' && n.folderId ? n.folderId : null,
    favorite: n.favorite === true,
    attachments: Array.isArray(n.attachments) ? n.attachments.filter(a => a && typeof a === 'object' && typeof a.data === 'string') : [],
    createdAt: str(n.createdAt),
    updatedAt: str(n.updatedAt) || str(n.createdAt),
  };
}

const changed = () => bus.emit(Events.DATA_CHANGED);

export const NoteService = {
  /** Favoritas primeiro, depois as alteradas mais recentemente. */
  async list(): Promise<SecureNote[]> {
    const all = (await vaultDb.all<SecureNote>('notes')).map(normalizeNote);
    return all.sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.updatedAt.localeCompare(a.updatedAt));
  },

  async get(id: string): Promise<SecureNote | null> {
    const n = await vaultDb.get<SecureNote>('notes', id);
    return n ? normalizeNote(n) : null;
  },

  async save(input: SecureNote): Promise<SecureNote> {
    validate(input);
    const prev = await vaultDb.get<SecureNote>('notes', input.id);
    if (!prev && (await vaultDb.all<SecureNote>('notes')).length >= NOTE_LIMITS.notes) throw new ValidationError(`Use no máximo ${NOTE_LIMITS.notes} notas`);
    let folderId = input.folderId ?? null;
    if (folderId && !(await vaultDb.get<Folder>('folders', folderId))) folderId = null;
    const note: SecureNote = {
      ...normalizeNote(input),
      title: input.title.trim(),
      folderId,
      attachments: checkAttachments(input.attachments),
      createdAt: prev?.createdAt || input.createdAt || now(),
      updatedAt: now(),
    };
    // Com `secure_delete`, o espaço do conteúdo antigo (ex.: anexo removido) é zerado pelo próprio SQLite
    await vaultDb.put('notes', note);
    changed();
    return note;
  },

  /** Exclusão segura e irrecuperável (a nota e os anexos são sobrescritos antes do DELETE). */
  async remove(id: string): Promise<void> {
    await vaultDb.remove('notes', id);
    changed();
  },

  async setFavorite(id: string, favorite: boolean): Promise<void> {
    const n = await this.get(id);
    if (!n || n.favorite === favorite) return;
    await vaultDb.put('notes', { ...n, favorite, updatedAt: now() });
    changed();
  },

  /** Acrescenta um arquivo escolhido no aparelho à nota (ainda não salva), com as validações de tamanho e quantidade. */
  addAttachment(note: SecureNote, file: PickedFile): SecureNote {
    if (note.attachments.length >= NOTE_LIMITS.attachments) throw new ValidationError(`Use no máximo ${NOTE_LIMITS.attachments} anexos por nota`);
    const attachment = checkAttachment({ id: uuid(), name: file.name, mime: file.mime, size: 0, data: file.base64 });
    const attachments = checkAttachments([...note.attachments, attachment]);
    return { ...note, attachments };
  },

  removeAttachment(note: SecureNote, attachmentId: string): SecureNote {
    return { ...note, attachments: note.attachments.filter(a => a.id !== attachmentId) };
  },

  /** Busca sem acentos: todas as palavras precisam aparecer no título, texto, categoria ou nome de anexo. */
  search(notes: SecureNote[], query: string): SecureNote[] {
    const terms = norm(query).split(/\s+/).filter(Boolean);
    if (!terms.length) return notes;
    return notes.filter(n => {
      const hay = norm([n.title, n.content, NoteCategoryLabels[n.category] || '', ...n.attachments.map(a => a.name)].join(' '));
      return terms.every(t => hay.includes(t));
    });
  },

  /** Prévia de duas linhas para a lista. */
  preview(content: string, max = 140): string {
    const flat = String(content || '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  },

  categories(): NoteCategory[] {
    return Object.keys(NoteCategoryLabels) as NoteCategory[];
  },
};
