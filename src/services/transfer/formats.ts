// Detecção automática do formato do arquivo importado e conversão para itens do Custódia
// Formatos: Chrome/Edge, Firefox, Bitwarden (CSV e JSON), LastPass, 1Password (CSV), KeePass/KeePassXC (CSV),
// Custódia (CSV e JSON) e um CSV genérico com as colunas título, usuário, senha e URL.
// Esta camada só interpreta o texto; validação de limites, duplicadas e gravação ficam no ImportService.

import { uuid } from '../../crypto';
import {
  CategoryLabels,
  CredentialCategory,
  Credential,
  CustomField,
  FormItem,
  NoteCategory,
  NoteCategoryLabels,
  SecureNote,
} from '../../types/models';
import { hostnameOf } from '../../utils';
import { CsvError, parseCsv, restoreFormula, rowsToRecords } from './csv';

export type ImportFormat =
  | 'custodia_json'
  | 'custodia_csv'
  | 'bitwarden_json'
  | 'bitwarden_csv'
  | 'chrome_csv'
  | 'firefox_csv'
  | 'lastpass_csv'
  | 'onepassword_csv'
  | 'keepass_csv'
  | 'generic_csv';

export const ImportFormatLabels: Record<ImportFormat, string> = {
  custodia_json: 'Custódia (JSON)',
  custodia_csv: 'Custódia (CSV)',
  bitwarden_json: 'Bitwarden (JSON)',
  bitwarden_csv: 'Bitwarden (CSV)',
  chrome_csv: 'Chrome / Edge (CSV)',
  firefox_csv: 'Firefox (CSV)',
  lastpass_csv: 'LastPass (CSV)',
  onepassword_csv: '1Password (CSV)',
  keepass_csv: 'KeePass (CSV)',
  generic_csv: 'CSV (título, usuário, senha, URL)',
};

/** Mensagem do cenário BDD "Erro de formatação no CSV". */
export const FORMAT_ERROR = 'Erro de formatação';

export class ImportFormatError extends Error {
  constructor(public readonly detail: string) {
    super(`${FORMAT_ERROR}: ${detail}`);
  }
}

export type ImportKind = 'credential' | 'note' | 'form';

export interface RawItem {
  kind: ImportKind;
  /** Linha do CSV (contando o cabeçalho como 1) ou posição no JSON, para as mensagens de erro. */
  line: number;
  /** Caminho de pastas (do topo para baixo); vazio = raiz. */
  folderPath: string[];
  credential?: Partial<Credential>;
  note?: Partial<SecureNote>;
  form?: Partial<FormItem>;
  /** Id de origem (só no JSON do Custódia), usado para reconhecer o mesmo registro. */
  sourceId?: string;
  /** Erro de leitura da linha (vai para a contagem "com erro" da prévia). */
  error?: string;
}

export interface ParsedFile {
  format: ImportFormat;
  items: RawItem[];
}

const LOGIN_NAME = 'login name';
const NOTE_TITLE = 'Nota importada';
const str = (v: unknown): string => (v == null ? '' : String(v));
const truthy = (v: unknown) => ['1', 'true', 'yes', 'sim', 'x'].includes(str(v).trim().toLowerCase());

function isoOrUndefined(v: unknown): string | undefined {
  const s = str(v).trim();
  if (!s) return undefined;
  // Firefox grava milissegundos desde 1970
  const n = /^\d{10,13}$/.test(s) ? Number(s.length === 10 ? Number(s) * 1000 : s) : Date.parse(s);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : undefined;
}

function hiddenField(label: string, value: string): CustomField {
  return { id: uuid(), label, value, type: 'hidden' };
}

function titleFrom(title: string, url: string, username: string): string {
  const t = title.trim();
  if (t) return t;
  const host = hostnameOf(url);
  if (host) return host;
  return username.trim();
}

/** Credencial a partir dos campos mais comuns. */
function cred(fields: { title?: unknown; username?: unknown; password?: unknown; url?: unknown; notes?: unknown; favorite?: unknown; totp?: unknown }): Partial<Credential> {
  const url = str(fields.url).trim();
  const username = str(fields.username);
  const totp = str(fields.totp).trim();
  return {
    title: titleFrom(str(fields.title), url, username),
    username,
    password: str(fields.password),
    url,
    notes: str(fields.notes),
    favorite: truthy(fields.favorite),
    customFields: totp ? [hiddenField('TOTP', totp)] : [],
  };
}

const splitPath = (path: string, sep: RegExp) =>
  path
    .split(sep)
    .map(p => p.trim())
    .filter(Boolean);

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
const has = (header: string[], ...cols: string[]) => cols.every(c => header.includes(c));

/** Apelidos aceitos no CSV genérico (pt-BR e inglês). */
const GENERIC_ALIASES: Record<'title' | 'username' | 'password' | 'url' | 'notes' | 'folder' | 'category' | 'favorite' | 'totp', string[]> = {
  title: ['title', 'name', 'título', 'titulo', 'nome', 'serviço', 'servico', 'account', 'conta'],
  username: ['username', 'user', 'usuário', 'usuario', 'login', LOGIN_NAME, 'email', 'e-mail'],
  password: ['password', 'senha', 'pass', 'pwd'],
  url: ['url', 'site', 'website', 'web site', 'endereço', 'endereco', 'link', 'uri', 'login_uri'],
  notes: ['notes', 'note', 'notas', 'nota', 'observações', 'observacoes', 'comments', 'extra'],
  folder: ['folder', 'pasta', 'group', 'grupo'],
  category: ['category', 'categoria'],
  favorite: ['favorite', 'favorito', 'fav'],
  totp: ['totp', 'otp', 'otpauth'],
};

function detectCsvFormat(header: string[]): ImportFormat | null {
  if (has(header, 'login_username', 'login_password', 'name')) return 'bitwarden_csv';
  if (has(header, 'url', 'username', 'password', 'extra', 'name', 'grouping')) return 'lastpass_csv';
  if (has(header, 'url', 'username', 'password') && (header.includes('httprealm') || header.includes('formactionorigin') || header.includes('guid'))) {
    return 'firefox_csv';
  }
  if (has(header, 'name', 'url', 'username', 'password', 'folder', 'category')) return 'custodia_csv';
  if (has(header, 'name', 'url', 'username', 'password')) return 'chrome_csv';
  if (has(header, 'group', 'title', 'username', 'password')) return 'keepass_csv';
  if (has(header, 'account', LOGIN_NAME, 'password')) return 'keepass_csv';
  if (has(header, 'title', 'username', 'password') && (header.includes('url') || header.includes('website') || header.includes('urls'))) {
    return 'onepassword_csv';
  }
  return null;
}

/** Valida o CSV genérico: precisa da coluna de senha e não aceita colunas desconhecidas (BDD). */
function genericColumns(header: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  const unknown: string[] = [];
  for (const h of header) {
    const key = (Object.keys(GENERIC_ALIASES) as (keyof typeof GENERIC_ALIASES)[]).find(k => GENERIC_ALIASES[k].includes(h));
    if (key && !map[key]) map[key] = h;
    else if (h) unknown.push(h);
  }
  if (!map.password || !(map.title || map.url || map.username)) {
    throw new ImportFormatError('não encontramos as colunas título, usuário, senha e URL (verifique o separador)');
  }
  if (unknown.length) throw new ImportFormatError(`colunas desconhecidas: ${unknown.slice(0, 5).join(', ')}`);
  return map;
}

type Rec = Record<string, string>;

const CSV_MAPPERS: Record<Exclude<ImportFormat, 'custodia_json' | 'bitwarden_json' | 'generic_csv'>, (r: Rec, line: number) => RawItem> = {
  chrome_csv: (r, line) => ({ kind: 'credential', line, folderPath: [], credential: cred({ title: r.name, url: r.url, username: r.username, password: r.password, notes: r.note }) }),

  custodia_csv: (r, line) => {
    // O CSV do Custódia neutraliza fórmulas com um apóstrofo; aqui ele é removido para recuperar o valor original
    const v = (k: string) => restoreFormula(r[k] ?? '');
    const c = cred({ title: v('name'), url: v('url'), username: v('username'), password: v('password'), notes: v('note'), favorite: v('favorite'), totp: v('totp') });
    const category = Object.entries(CategoryLabels).find(([key, label]) => key === v('category') || label === v('category'))?.[0];
    if (category) c.category = category as CredentialCategory;
    return { kind: 'credential', line, folderPath: splitPath(v('folder'), /\s*›\s*/), credential: c };
  },

  firefox_csv: (r, line) => {
    const c = cred({ url: r.url, username: r.username, password: r.password });
    c.createdAt = isoOrUndefined(r.timecreated);
    c.passwordChangedAt = isoOrUndefined(r.timepasswordchanged);
    return { kind: 'credential', line, folderPath: [], credential: c };
  },

  bitwarden_csv: (r, line) => {
    const folderPath = splitPath(r.folder || '', /\//);
    if (r.type === 'note') {
      return { kind: 'note', line, folderPath, note: { title: r.name || NOTE_TITLE, content: r.notes || '', favorite: truthy(r.favorite) } };
    }
    const c = cred({ title: r.name, url: (r.login_uri || '').split(',')[0], username: r.login_username, password: r.login_password, notes: r.notes, favorite: r.favorite, totp: r.login_totp });
    c.customFields = [...(c.customFields || []), ...bitwardenCsvFields(r.fields || '')];
    return { kind: 'credential', line, folderPath, credential: c };
  },

  lastpass_csv: (r, line) => {
    const folderPath = splitPath(r.grouping || '', /\\/);
    // "http://sn" marca uma nota segura no LastPass
    if (r.url === 'http://sn') return { kind: 'note', line, folderPath, note: { title: r.name || NOTE_TITLE, content: r.extra || '', favorite: truthy(r.fav) } };
    return { kind: 'credential', line, folderPath, credential: cred({ title: r.name, url: r.url, username: r.username, password: r.password, notes: r.extra, favorite: r.fav, totp: r.totp }) };
  },

  onepassword_csv: (r, line) => ({
    kind: 'credential',
    line,
    folderPath: [],
    credential: cred({ title: r.title, url: r.url || r.website || r.urls, username: r.username, password: r.password, notes: r.notes || r.notesplain, favorite: r.favorite, totp: r.otpauth }),
  }),

  keepass_csv: (r, line) => {
    // KeePassXC: "Root/Pasta/Subpasta" (o primeiro nível é o grupo raiz do banco). KeePass 2: Account, Login Name…
    const folderPath = splitPath(r.group || '', /\//).slice(1);
    const c = cred({
      title: r.title ?? r.account,
      url: r.url ?? r['web site'],
      username: r.username ?? r[LOGIN_NAME],
      password: r.password,
      notes: r.notes ?? r.comments,
      totp: r.totp,
    });
    c.createdAt = isoOrUndefined(r.created);
    return { kind: 'credential', line, folderPath, credential: c };
  },
};

/** Campos extras do Bitwarden CSV: "nome: valor" por linha. */
function bitwardenCsvFields(text: string): CustomField[] {
  return text
    .split(/\r?\n/)
    .map(l => l.match(/^([^:]{1,60}):\s?(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map(m => ({ id: uuid(), label: m[1].trim(), value: m[2], type: 'text' as const }));
}

function genericMapper(cols: Record<string, string>) {
  return (r: Rec, line: number): RawItem => {
    const g = (k: string) => (cols[k] ? r[cols[k]] ?? '' : '');
    return {
      kind: 'credential',
      line,
      folderPath: splitPath(g('folder'), /\s*[/›\\]\s*/),
      credential: cred({ title: g('title'), url: g('url'), username: g('username'), password: g('password'), notes: g('notes'), favorite: g('favorite'), totp: g('totp') }),
    };
  };
}

export function parseCsvFile(text: string, maxRows: number): ParsedFile {
  let rows: string[][];
  try {
    rows = parseCsv(text, { limits: { maxRows } });
  } catch (e: any) {
    throw new ImportFormatError(e instanceof CsvError ? e.message : 'arquivo CSV ilegível');
  }
  if (rows.length < 2) throw new ImportFormatError('o arquivo não tem linhas de dados');
  const { header, records } = rowsToRecords(rows);
  const detected = detectCsvFormat(header);
  const format: ImportFormat = detected || 'generic_csv';
  const mapper = detected && detected !== 'generic_csv' ? CSV_MAPPERS[detected as keyof typeof CSV_MAPPERS] : genericMapper(genericColumns(header));
  let mismatched = 0;
  const items = records.map((rec, idx) => {
    const line = idx + 2;
    if (rows[idx + 1].length !== header.length) {
      mismatched++;
      return { kind: 'credential' as const, line, folderPath: [], error: `Linha ${line}: número de colunas diferente do cabeçalho` };
    }
    return mapper(rec, line);
  });
  // Mais da metade das linhas com colunas erradas: o separador ou o arquivo estão errados, a importação é abortada
  if (mismatched * 2 > records.length) throw new ImportFormatError('as linhas não seguem o cabeçalho (delimitador incorreto?)');
  return { format, items };
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------
const NOTE_CATEGORIES = Object.keys(NoteCategoryLabels) as NoteCategory[];

function bitwardenItem(it: any, idx: number, folders: Map<string, string>): RawItem {
  const folderPath = splitPath(folders.get(it?.folderId) || '', /\//);
  const base = { line: idx + 1, folderPath };
  const name = str(it?.name);
  switch (it?.type) {
    case 1: {
      const login = it.login || {};
      const c = cred({ title: name, url: login.uris?.[0]?.uri, username: login.username, password: login.password, notes: it.notes, favorite: it.favorite, totp: login.totp });
      const fields: CustomField[] = (Array.isArray(it.fields) ? it.fields : []).map((f: any) => ({
        id: uuid(),
        label: str(f?.name),
        value: str(f?.value),
        type: f?.type === 1 ? ('hidden' as const) : ('text' as const),
      }));
      c.customFields = [...(c.customFields || []), ...fields];
      return { ...base, kind: 'credential', credential: c };
    }
    case 2:
      return { ...base, kind: 'note', note: { title: name || NOTE_TITLE, content: str(it.notes), favorite: !!it.favorite } };
    case 3:
      return { ...base, kind: 'form', form: bitwardenCard(name, it.card || {}) };
    case 4:
      return { ...base, kind: 'form', form: bitwardenIdentity(name, it.identity || {}) };
    default:
      return { ...base, kind: 'credential', error: `Item ${idx + 1}: tipo do Bitwarden não suportado` };
  }
}

function bitwardenCard(label: string, c: any): Partial<FormItem> {
  return { kind: 'card', label: label || 'Cartão', holder: str(c.cardholderName), number: str(c.number).replace(/\s/g, ''), expMonth: str(c.expMonth), expYear: str(c.expYear), cvv: str(c.code), brand: 'other' };
}

function bitwardenIdentity(label: string, i: any): Partial<FormItem> {
  const fullName = [i.firstName, i.middleName, i.lastName].map(str).filter(Boolean).join(' ');
  return { kind: 'identity', label: label || 'Identidade', fullName, email: str(i.email), phone: str(i.phone), cpf: str(i.ssn), rg: str(i.licenseNumber), birthDate: '', company: str(i.company) };
}

function parseBitwarden(json: any): ParsedFile {
  if (json.encrypted) {
    throw new ImportFormatError('a exportação cifrada do Bitwarden não pode ser lida; exporte em "JSON" sem senha e apague o arquivo depois');
  }
  const folders = new Map<string, string>((Array.isArray(json.folders) ? json.folders : []).map((f: any) => [str(f?.id), str(f?.name)]));
  const items = (json.items as any[]).map((it, idx) => bitwardenItem(it, idx, folders));
  return { format: 'bitwarden_json', items };
}

function custodiaFolderPath(folders: any[], id: unknown): string[] {
  const byId = new Map(folders.map(f => [str(f?.id), f]));
  const out: string[] = [];
  let cur = byId.get(str(id));
  for (let guard = 0; cur && guard < 20; guard++) {
    out.unshift(str(cur.name));
    cur = cur.parentId ? byId.get(str(cur.parentId)) : undefined;
  }
  return out.filter(Boolean);
}

function parseCustodia(json: any): ParsedFile {
  const folders: any[] = Array.isArray(json.folders) ? json.folders : [];
  const items: RawItem[] = [];
  const list = (k: string): any[] => (Array.isArray(json[k]) ? json[k] : []);
  list('credentials').forEach((c, idx) =>
    items.push({ kind: 'credential', line: idx + 1, sourceId: str(c?.id), folderPath: custodiaFolderPath(folders, c?.folderId), credential: c && typeof c === 'object' ? c : {} }),
  );
  list('notes').forEach((n, idx) => {
    const category = NOTE_CATEGORIES.includes(n?.category) ? n.category : 'other';
    items.push({ kind: 'note', line: idx + 1, sourceId: str(n?.id), folderPath: custodiaFolderPath(folders, n?.folderId), note: { ...n, category } });
  });
  list('forms').forEach((f, idx) => items.push({ kind: 'form', line: idx + 1, sourceId: str(f?.id), folderPath: [], form: f && typeof f === 'object' ? f : {} }));
  return { format: 'custodia_json', items };
}

export function parseJsonFile(json: any): ParsedFile {
  if (!json || typeof json !== 'object') throw new ImportFormatError('JSON vazio ou inválido');
  if (json.format === 'custodia-export') {
    if (json.version !== 1) throw new ImportFormatError('versão do arquivo do Custódia não suportada');
    return parseCustodia(json);
  }
  if (json.format === 'custodia-inventory') throw new ImportFormatError('o inventário de contas não contém senhas e não pode ser importado');
  // Bitwarden: { encrypted, folders, items }. A exportação protegida por senha não tem "items" (só "data")
  if (json.encrypted === true && 'encKeyValidation_DO_NOT_EDIT' in json) return parseBitwarden(json);
  if (Array.isArray(json.items) && ('encrypted' in json || Array.isArray(json.folders))) return parseBitwarden(json);
  throw new ImportFormatError('formato JSON desconhecido');
}
