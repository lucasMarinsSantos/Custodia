// Importação por foto ou captura de tela com OCR local
// O reconhecimento roda no aparelho (Tesseract, idiomas por+eng, módulo CustodiaOcr). A imagem nunca chega ao JS
// e não é salva: o módulo nativo apaga o arquivo temporário da câmera assim que termina. O texto reconhecido fica
// só na memória da tela, que o descarta ao sair.
// Aqui ficam as heurísticas (testáveis) que transformam o texto em campos candidatos: usuário/e-mail, senha, URL,
// rede Wi-Fi (SSID) e nome do serviço. O usuário sempre revisa no cadastro antes de salvar.

import { Ocr, OcrRawResult } from '../native/ocr';
import { LIMITS } from './Repository';
import { CategoryService } from './CategoryService';
import { Credential } from '../types/models';
import { hostnameOf } from '../utils';

/** Mensagem do cenário BDD "Foto em ambiente sem luz". */
export const OCR_DARK_MESSAGE = 'Ative o flash ou melhore a iluminação para reconhecer os caracteres';
export const OCR_NOTHING_FOUND = 'Nenhum usuário ou senha reconhecido. Tente uma foto mais nítida, de frente e bem iluminada.';
/** Texto máximo processado (o restante é descartado). */
export const MAX_OCR_TEXT = 20000;
const MAX_LINES = 400;
const MAX_CANDIDATES = 50;
/** Luminância média (0–255) abaixo da qual a foto é considerada escura demais. */
export const DARK_LUMINANCE = 45;
/** Confiança média do Tesseract (0–100) abaixo da qual o texto é considerado ilegível. */
export const LOW_CONFIDENCE = 35;

export interface OcrCandidate {
  title: string;
  username: string;
  password: string;
  url: string;
  /** Rede Wi-Fi reconhecida (SSID); o usuário vira o nome da rede. */
  wifi: boolean;
}

type Field = 'title' | 'username' | 'password' | 'url' | 'ssid';

/** Rótulos reconhecidos (pt-BR e inglês). A ordem importa: rótulos mais longos primeiro. */
const LABELS: { field: Field; re: string }[] = [
  { field: 'ssid', re: 'ssid|nome da rede|rede wi-?fi|wi-?fi|network name|network|rede' },
  { field: 'password', re: 'senha do wi-?fi|senha|password|passwd|pass|pwd|psk|wpa2?(?: key)?|chave de seguran[cç]a|chave|pin' },
  { field: 'username', re: 'nome de usu[aá]rio|usu[aá]rio|username|user ?name|user|login|e-?mail|conta|account|cpf' },
  { field: 'url', re: 'endere[cç]o|website|site|url|link' },
  { field: 'title', re: 'servi[cç]o|service|t[ií]tulo|title|app|sistema' },
];

// Separador: dois-pontos ou igual ("Senha: x"), ou travessão entre espaços ("Senha - x"; "site-novo.com" não é rótulo)
const LABEL_RE = new RegExp(`(?:^|[\\s/|;,(])(${LABELS.map(l => l.re).join('|')})(?:\\s*[:=：]\\s*|\\s+[-–]\\s+)`, 'gi');
const URL_RE = /\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?)/i;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/;

function fieldOf(label: string): Field {
  const l = label.toLowerCase();
  return LABELS.find(x => new RegExp(`^(?:${x.re})$`, 'i').test(l))?.field || 'title';
}

/** Limpa confusões típicas do OCR: aspas tipográficas, separadores e espaços nas pontas. */
function clean(v: string, field: Field): string {
  let s = v.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim();
  s = s.replace(/\s*[/|;,]\s*$/, '').trim();
  // Senha, usuário e URL não têm espaços: o OCR costuma inserir espaços falsos
  if (field === 'password' || field === 'url' || field === 'username') s = s.replace(/\s+/g, '');
  return s;
}

/** Encontra todos os pares "rótulo: valor" de uma linha (ex.: "Usuário: admin / Senha: 123"). */
export function labeledPairs(line: string): { field: Field; value: string }[] {
  const out: { field: Field; value: string }[] = [];
  const matches = [...line.matchAll(LABEL_RE)];
  matches.forEach((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index ?? line.length : line.length;
    const field = fieldOf(m[1]);
    const value = clean(line.slice(start, end), field);
    if (value) out.push({ field, value });
  });
  return out;
}

const MAX_BY_FIELD: Record<Field, number> = { title: LIMITS.title, username: LIMITS.username, password: LIMITS.password, url: LIMITS.url, ssid: LIMITS.username };

class CandidateBuilder {
  list: OcrCandidate[] = [];
  private cur: Partial<Record<Field, string>> = {};

  set(field: Field, value: string) {
    // Um campo repetido começa um novo registro (listas com várias contas numa captura de tela)
    if (this.cur[field] && (this.cur.password || field === 'password')) this.flush();
    this.cur[field] = value.slice(0, MAX_BY_FIELD[field]);
  }

  has(field: Field) {
    return !!this.cur[field];
  }

  flush() {
    const c = this.cur;
    this.cur = {};
    if (!c.password && !(c.username && (c.url || c.title)) && !c.ssid) return;
    if (this.list.length >= MAX_CANDIDATES) return;
    const wifi = !!c.ssid;
    const url = c.url || '';
    const username = wifi ? c.ssid! : c.username || '';
    this.list.push({ title: candidateTitle(c, url, wifi), username, password: c.password || '', url, wifi });
  }
}

function candidateTitle(c: Partial<Record<Field, string>>, url: string, wifi: boolean): string {
  if (c.title) return c.title;
  if (wifi) return `Wi-Fi ${c.ssid}`.slice(0, LIMITS.title);
  const host = hostnameOf(url);
  if (host) {
    const name = CategoryService.suggest(url, '').name || host.split('.')[0];
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  const email = c.username?.match(EMAIL_RE)?.[0];
  if (email) {
    const d = email.split('@')[1].split('.')[0];
    return d.charAt(0).toUpperCase() + d.slice(1);
  }
  return 'Importado por foto';
}

/** Linha sem rótulo: "email@x.com  senha123" ou "site.com | usuario | senha" (listas em captura de tela). */
function unlabeled(line: string, b: CandidateBuilder): void {
  const parts = line.split(/\s*[|;\t]\s*|\s{2,}/).filter(Boolean);
  const email = parts.find(p => EMAIL_RE.test(p));
  if (parts.length >= 2 && parts.length <= 4 && email) {
    const url = parts.find(p => p !== email && URL_RE.test(p));
    const rest = parts.filter(p => p !== email && p !== url);
    if (rest.length) {
      b.flush();
      if (url) b.set('url', clean(url, 'url'));
      b.set('username', clean(email, 'username'));
      b.set('password', clean(rest[rest.length - 1], 'password'));
      b.flush();
      return;
    }
  }
  if (email && !b.has('username')) b.set('username', email.match(EMAIL_RE)![0]);
  else if (!email && !b.has('url')) {
    const url = line.match(URL_RE)?.[1];
    if (url) b.set('url', url);
  }
}

/** Extrai os candidatos do texto reconhecido. */
export function parseOcrText(text: string): OcrCandidate[] {
  const lines = String(text || '')
    .slice(0, MAX_OCR_TEXT)
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, MAX_LINES);
  const b = new CandidateBuilder();
  for (const line of lines) {
    const pairs = labeledPairs(line);
    if (!pairs.length) {
      unlabeled(line, b);
      continue;
    }
    for (const p of pairs) b.set(p.field, p.value);
  }
  b.flush();
  // Remove repetidos (mesmo usuário e senha)
  const seen = new Set<string>();
  return b.list.filter(c => {
    const k = `${c.username}|${c.password}|${c.url}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export interface OcrOutcome {
  candidates: OcrCandidate[];
  /** Mensagem para o usuário quando nada foi reconhecido (ou a foto está escura). */
  problem: string | null;
}

/** Interpreta o resultado do módulo nativo: foto escura, texto ilegível ou candidatos. */
export function interpret(raw: OcrRawResult): OcrOutcome {
  const candidates = parseOcrText(raw.text);
  const dark = raw.brightness >= 0 && raw.brightness < DARK_LUMINANCE;
  if (!candidates.length && (dark || (raw.confidence >= 0 && raw.confidence < LOW_CONFIDENCE))) return { candidates, problem: OCR_DARK_MESSAGE };
  if (!candidates.length) return { candidates, problem: OCR_NOTHING_FOUND };
  return { candidates, problem: null };
}

/** Campos para abrir o cadastro pré-preenchido (nunca salva nada). */
export function toPrefill(c: OcrCandidate): Partial<Credential> {
  return {
    title: c.title.slice(0, LIMITS.title),
    username: c.username.slice(0, LIMITS.username),
    password: c.password.slice(0, LIMITS.password),
    url: c.url.slice(0, LIMITS.url),
    notes: c.wifi ? 'Rede Wi-Fi reconhecida por foto' : '',
  };
}

export const OcrService = {
  /** Tira a foto (app de câmera do sistema) e reconhece o texto. null = cancelado. */
  async fromCamera(): Promise<OcrOutcome | null> {
    const raw = await Ocr.recognize('camera');
    return raw ? interpret(raw) : null;
  },

  /** Escolhe uma captura de tela da galeria e reconhece o texto. null = cancelado. */
  async fromGallery(): Promise<OcrOutcome | null> {
    const raw = await Ocr.recognize('gallery');
    return raw ? interpret(raw) : null;
  },
};
