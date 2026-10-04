// Pesquisa avançada com operadores booleanos e filtros
//
// Sintaxe suportada:
//   gmail AND trabalho        → ambos os termos
//   gmail OR outlook          → qualquer termo
//   NOT banco  /  -banco      → exclusão
//   (a OR b) AND c            → agrupamento
//   "frase exata"             → frase
//   campo:valor               → titulo:, usuario:, url:, notas:, campo: (personalizado), categoria:, pasta:
//   Espaço entre termos = AND implícito. Operadores aceitos também em português: E, OU, NAO/NÃO.
// Filtros: categoria, força da senha, pasta, favoritas e data de criação.

import { CategoryLabels, Credential, CredentialCategory, Folder, PasswordStrength } from '../types/models';
import { stripAccents } from '../utils';
import { strengthOf } from './AnalysisService';

type Node =
  | { t: 'term'; field: string | null; value: string }
  | { t: 'and'; a: Node; b: Node }
  | { t: 'or'; a: Node; b: Node }
  | { t: 'not'; a: Node };

export interface SearchFilters {
  categories?: CredentialCategory[];
  strengths?: PasswordStrength[];
  createdFrom?: string | null;
  createdTo?: string | null;
  folderIds?: string[] | null;
  onlyFavorites?: boolean;
}

const norm = (s: string) => stripAccents(String(s || '')).toLowerCase();

function tokenize(q: string): string[] {
  const tokens: string[] = [];
  const re = /\s*("([^"]*)"|\(|\)|[^\s()"]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    if (m[1] === '(' || m[1] === ')') tokens.push(m[1]);
    else if (m[2] !== undefined) tokens.push('"' + m[2]);
    else tokens.push(m[1]);
  }
  return tokens;
}

const isAnd = (t: string) => ['and', 'e', '&&'].includes(t.toLowerCase());
const isOr = (t: string) => ['or', 'ou', '||'].includes(t.toLowerCase());
const isNot = (t: string) => ['not', 'nao', 'não', '!'].includes(t.toLowerCase());

/** Limites contra consultas abusivas (pilha de parênteses/NOT, tokenização lenta em textos enormes). */
export const MAX_QUERY_LENGTH = 256;
const MAX_TOKENS = 64;
const MAX_DEPTH = 16;

export function parseQuery(q: string): Node | null {
  const tokens = tokenize(String(q || '').slice(0, MAX_QUERY_LENGTH).trim()).slice(0, MAX_TOKENS);
  let pos = 0;
  let depth = 0;

  const parseOr = (): Node | null => {
    let left = parseAnd();
    while (pos < tokens.length && isOr(tokens[pos])) {
      pos++;
      const right = parseAnd();
      if (left && right) left = { t: 'or', a: left, b: right };
      else left = left || right;
    }
    return left;
  };

  const parseAnd = (): Node | null => {
    let left = parseUnary();
    while (pos < tokens.length && tokens[pos] !== ')' && !isOr(tokens[pos])) {
      if (isAnd(tokens[pos])) pos++;
      const right = parseUnary();
      if (left && right) left = { t: 'and', a: left, b: right };
      else left = left || right;
    }
    return left;
  };

  const parseUnary = (): Node | null => {
    if (pos >= tokens.length) return null;
    const tok = tokens[pos];
    if ((isNot(tok) || tok === '(') && depth >= MAX_DEPTH) {
      // Aninhamento exagerado: o operador é ignorado e tratado como texto comum
      pos++;
      return null;
    }
    if (isNot(tok)) {
      pos++;
      depth++;
      const a = parseUnary();
      depth--;
      return a ? { t: 'not', a } : null;
    }
    if (tok === '(') {
      pos++;
      depth++;
      const inner = parseOr();
      depth--;
      if (tokens[pos] === ')') pos++;
      return inner;
    }
    if (tok === ')') {
      pos++;
      return null;
    }
    pos++;
    if (tok.startsWith('-') && tok.length > 1) return { t: 'not', a: term(tok.slice(1)) };
    return term(tok);
  };

  const term = (tok: string): Node => {
    if (tok.startsWith('"')) return { t: 'term', field: null, value: norm(tok.slice(1)) };
    const idx = tok.indexOf(':');
    if (idx > 0) {
      let value = tok.slice(idx + 1);
      if (value.startsWith('"')) value = value.slice(1);
      return { t: 'term', field: norm(tok.slice(0, idx)), value: norm(value) };
    }
    return { t: 'term', field: null, value: norm(tok) };
  };

  if (!tokens.length) return null;
  return parseOr();
}

function fieldValues(c: Credential, field: string | null, folders: Folder[]): string[] {
  const folderName = folders.find(f => f.id === c.folderId)?.name || '';
  const custom = c.customFields.map(f => `${f.label} ${f.type === 'hidden' ? '' : f.value}`);
  switch (field) {
    case 'titulo':
    case 'título':
    case 'nome':
    case 'servico':
    case 'serviço':
    case 'title':
      return [c.title];
    case 'usuario':
    case 'usuário':
    case 'user':
    case 'email':
      return [c.username];
    case 'url':
    case 'site':
    case 'dominio':
    case 'domínio':
      return [c.url];
    case 'notas':
    case 'nota':
    case 'notes':
      return [c.notes];
    case 'campo':
    case 'custom':
      return custom;
    case 'categoria':
    case 'cat':
      return [c.category, CategoryLabels[c.category] || ''];
    case 'pasta':
    case 'folder':
      return [folderName];
    default:
      return [c.title, c.username, c.url, c.notes, folderName, CategoryLabels[c.category] || '', ...custom];
  }
}

function evaluate(node: Node, c: Credential, folders: Folder[]): boolean {
  switch (node.t) {
    case 'term':
      return fieldValues(c, node.field, folders).some(v => norm(v).includes(node.value));
    case 'and':
      return evaluate(node.a, c, folders) && evaluate(node.b, c, folders);
    case 'or':
      return evaluate(node.a, c, folders) || evaluate(node.b, c, folders);
    case 'not':
      return !evaluate(node.a, c, folders);
  }
}

/** 'AAAA-MM-DD' (fuso local) → início ou fim do dia em ms. Valores incompletos/inválidos são ignorados. */
export function localDayBound(day: string | null | undefined, endOfDay: boolean): number | null {
  const m = day ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim()) : null;
  if (!m) return null;
  const d = endOfDay ? new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999) : new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0);
  // Rejeita datas que o Date "corrige" sozinho (ex.: 2026-02-31 → 03 de março)
  if (isNaN(d.getTime()) || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
  return d.getTime();
}

/** Filtros avançados (categoria, força, datas, pasta, favoritos), sem a consulta de texto. */
function matchesFilters(c: Credential, filters: SearchFilters, from: number | null, to: number | null): boolean {
  if (filters.categories?.length && !filters.categories.includes(c.category)) return false;
  if (filters.strengths?.length && !filters.strengths.includes(strengthOf(c.password))) return false;
  const t = Date.parse(c.createdAt);
  if (from !== null && t < from) return false;
  if (to !== null && t > to) return false;
  if (filters.folderIds?.length && !filters.folderIds.includes(c.folderId || '')) return false;
  return !(filters.onlyFavorites && !c.favorite);
}

export const SearchService = {
  search(creds: Credential[], query: string, filters: SearchFilters, folders: Folder[]): Credential[] {
    const ast = query.trim() ? parseQuery(query) : null;
    // Datas do filtro são dias no fuso local; createdAt é ISO em UTC → compara por instante.
    const from = localDayBound(filters.createdFrom, false);
    const to = localDayBound(filters.createdTo, true);
    return creds.filter(c => matchesFilters(c, filters, from, to) && (ast ? evaluate(ast, c, folders) : true));
  },
  parseQuery,
};
