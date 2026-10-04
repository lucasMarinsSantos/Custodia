// Geração e avaliação de senhas
// Gerador com parâmetros ajustáveis (comprimento, classes, ambíguos, pronunciáveis) usando RNG
// criptográfico, e analisador de força com detecção de padrões fracos.

import { randomInt } from '../crypto';
import { COMMON_PASSWORDS_RAW } from '../data/commonPasswords';
import { PasswordStrength } from '../types/models';

export interface PasswordOptions {
  length: number;
  uppercase: boolean;
  lowercase: boolean;
  numbers: boolean;
  symbols: boolean;
  avoidAmbiguous: boolean;
  pronounceable: boolean;
}

/** Padrão do gerador (cenário BDD): 16 caracteres com maiúsculas, minúsculas, números e símbolos. */
export const DefaultPasswordOptions: PasswordOptions = {
  length: 16,
  uppercase: true,
  lowercase: true,
  numbers: true,
  symbols: true,
  avoidAmbiguous: true,
  pronounceable: false,
};

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const SYMBOLS = '!@#$%&*()-_=+[]{};:,.?/';
const AMBIGUOUS = /[O0oIl1|`'"]/g;

const CONSONANTS = 'bcdfghjklmnprstvz';
const VOWELS = 'aeiou';

let commonSet: Set<string> | null = null;
export function commonPasswords(): Set<string> {
  if (!commonSet) commonSet = new Set(COMMON_PASSWORDS_RAW.split('\n'));
  return commonSet;
}

const COMMON_WORDS = [
  'senha', 'password', 'admin', 'amor', 'brasil', 'deus', 'jesus', 'familia', 'teste', 'qwerty', 'abc',
  'love', 'master', 'dragon', 'monkey', 'football', 'futebol', 'flamengo', 'corinthians', 'palmeiras',
  'santos', 'gremio', 'vasco', 'sao', 'paulo', 'letmein', 'welcome', 'bemvindo', 'princesa', 'minhasenha',
  'mudar', 'trocar', 'acesso', 'login', 'user', 'usuario', 'root', 'secret', 'segredo', 'casa', 'mae', 'pai',
];

const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890', 'qazwsxedc', 'mnbvcxz'];

function pick(chars: string): string {
  return chars[randomInt(chars.length)];
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// Análise de força: cada verificação ajusta a pontuação e explica o motivo
// ---------------------------------------------------------------------------
interface Analysis {
  score: number;
  feedback: string[];
  patterns: string[];
}

function penalize(r: Analysis, points: number, pattern: string, message: string) {
  r.score -= points;
  r.patterns.push(pattern);
  r.feedback.push(message);
}

const LEET: [RegExp, string][] = [[/@/g, 'a'], [/4/g, 'a'], [/3/g, 'e'], [/1/g, 'i'], [/!/g, 'i'], [/0/g, 'o'], [/\$/g, 's'], [/5/g, 's'], [/7/g, 't']];
const toLeet = (lower: string) => LEET.reduce((acc, [re, ch]) => acc.replace(re, ch), lower);

function baseScore(pw: string, bits: number): number {
  let score = Math.min(60, bits * 0.75);
  if (pw.length >= 16) score += 15;
  else if (pw.length >= 12) score += 10;
  return score;
}

function lengthAndClasses(pw: string, r: Analysis) {
  if (pw.length < 8) {
    r.score -= 15;
    r.feedback.push('Use pelo menos 12 caracteres');
  }
  const classes: [RegExp, string][] = [
    [/[A-Z]/, 'Adicione letras maiúsculas'],
    [/[a-z]/, 'Adicione letras minúsculas'],
    [/[0-9]/, 'Adicione números'],
    [/[^A-Za-z0-9]/, 'Adicione símbolos'],
  ];
  for (const [re, msg] of classes) {
    if (re.test(pw)) r.score += 5;
    else r.feedback.push(msg);
  }
}

function repetitionCheck(lower: string, _leet: string, r: Analysis) {
  if (/(.)\1{2,}/.test(lower) || /^(.{2,})\1+$/.test(lower)) penalize(r, 20, 'repetição', 'Evite repetições de caracteres');
}

function sequenceCheck(lower: string, _leet: string, r: Analysis) {
  let seq = 0;
  for (let i = 2; i < lower.length; i++) {
    const d1 = lower.charCodeAt(i - 1) - lower.charCodeAt(i - 2);
    const d2 = lower.charCodeAt(i) - lower.charCodeAt(i - 1);
    if (d1 === d2 && Math.abs(d1) === 1) seq++;
  }
  if (seq > 0) penalize(r, Math.min(25, 8 * seq), 'sequência', 'Evite sequências como 123 ou abc');
}

function keyboardCheck(lower: string, _leet: string, r: Analysis) {
  const hit = KEYBOARD_ROWS.some(row => {
    for (let i = 0; i + 4 <= row.length; i++) {
      const frag = row.slice(i, i + 4);
      if (lower.includes(frag) || lower.includes(frag.split('').reverse().join(''))) return true;
    }
    return false;
  });
  if (hit) penalize(r, 15, 'teclado', 'Evite sequências do teclado (qwerty, asdf)');
}

function dateCheck(lower: string, _leet: string, r: Analysis) {
  if (/(19|20)\d{2}/.test(lower) || /\d{2}[/.-]?\d{2}[/.-]?\d{2,4}/.test(lower)) penalize(r, 10, 'data', 'Evite datas e anos');
}

function wordCheck(lower: string, leet: string, r: Analysis) {
  const word = COMMON_WORDS.find(w => w.length >= 3 && (lower.includes(w) || leet.includes(w)));
  if (word) penalize(r, 20, 'palavra comum', `Evite palavras comuns ("${word}")`);
}

const PATTERN_CHECKS = [repetitionCheck, sequenceCheck, keyboardCheck, dateCheck, wordCheck];

/** Lista das 10 mil senhas mais comuns (por enquanto só para a senha mestra). */
function commonListCheck(lower: string, leet: string, r: Analysis) {
  const set = commonPasswords();
  const stripped = leet.replace(/[^a-z0-9]/g, '').replace(/\d+$/, '');
  if (set.has(lower) || set.has(leet)) {
    r.score = Math.min(r.score, 5);
    r.patterns.push('senha vazada comum');
    r.feedback.unshift('Esta senha está entre as 10 mil mais usadas');
  } else if (stripped.length >= 4 && set.has(stripped)) {
    penalize(r, 25, 'variação de senha comum', 'É uma variação de senha muito comum');
  }
}

function strengthFor(score: number): PasswordStrength {
  if (score >= 85) return 'very_strong';
  if (score >= 65) return 'strong';
  if (score >= 45) return 'medium';
  if (score >= 25) return 'weak';
  return 'critical';
}

export const PasswordService = {
  generate(opts: PasswordOptions = DefaultPasswordOptions): string {
    const length = Math.max(4, Math.min(128, Math.floor(opts.length)));
    if (opts.pronounceable) return this.generatePronounceable(length, opts);

    const sets: string[] = [];
    const strip = (s: string) => (opts.avoidAmbiguous ? s.replace(AMBIGUOUS, '') : s);
    if (opts.uppercase) sets.push(strip(UPPER));
    if (opts.lowercase) sets.push(strip(LOWER));
    if (opts.numbers) sets.push(strip(DIGITS));
    if (opts.symbols) sets.push(strip(SYMBOLS));
    if (sets.length === 0) sets.push(strip(LOWER));
    const all = sets.join('');

    const chars: string[] = sets.map(s => pick(s)); // garante uma de cada classe
    while (chars.length < length) chars.push(pick(all));
    return shuffle(chars).slice(0, length).join('');
  },

  /**
   * Senhas pronunciáveis: sílabas consoante+vogal, com 2 dígitos e 1 símbolo opcionais no fim.
   * Respeita todas as opções: comprimento exato, sem símbolos/números quando desligados, só maiúsculas
   * ou só minúsculas, e sem caracteres ambíguos (l, i, o → I, l, O, 0, 1).
   */
  generatePronounceable(length: number, opts: PasswordOptions): string {
    const cons = opts.avoidAmbiguous ? CONSONANTS.replace(/l/g, '') : CONSONANTS;
    const vow = opts.avoidAmbiguous ? VOWELS.replace(/[io]/g, '') : VOWELS;
    const digits = opts.avoidAmbiguous ? '23456789' : DIGITS;
    const symbols = '!@#$%&*-_=+?'; // nenhum deles é ambíguo
    const extras: string[] = [];
    if (opts.symbols) extras.push(pick(symbols));
    if (opts.numbers) extras.push(pick(digits), pick(digits));
    const bodyLen = Math.max(2, length - extras.length);
    let body = '';
    while (body.length < bodyLen) {
      let syl = pick(cons) + pick(vow);
      if (randomInt(4) === 0) syl += pick(cons);
      body += syl;
    }
    let chars = body.slice(0, bodyLen).split('');
    if (opts.uppercase && !opts.lowercase) chars = chars.map(c => c.toUpperCase());
    else if (opts.uppercase) chars = chars.map((c, i) => (i === 0 || (i % 5 === 0 && randomInt(2) === 0) ? c.toUpperCase() : c));
    return (chars.join('') + extras.join('')).slice(0, length);
  },

  /** Estimativa de entropia (bits) considerando o alfabeto usado. */
  entropyBits(pw: string): number {
    let pool = 0;
    if (/[a-z]/.test(pw)) pool += 26;
    if (/[A-Z]/.test(pw)) pool += 26;
    if (/[0-9]/.test(pw)) pool += 10;
    if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
    return pool ? Math.round(pw.length * Math.log2(pool)) : 0;
  },

  /**
   * Análise de força com detecção de padrões fracos:
   * sequências numéricas/alfabéticas/teclado, palavras comuns, repetições e datas.
   * `checkCommon` compara também com a lista das 10 mil senhas mais comuns (senha mestra).
   */
  analyze(pw: string, opts: { checkCommon?: boolean } = {}): { strength: PasswordStrength; score: number; feedback: string[]; patterns: string[] } {
    if (!pw) return { strength: 'critical', score: 0, feedback: ['Senha vazia'], patterns: ['vazia'] };
    const r: Analysis = { score: baseScore(pw, this.entropyBits(pw)), feedback: [], patterns: [] };
    const lower = pw.toLowerCase();
    const leet = toLeet(lower);
    lengthAndClasses(pw, r);
    for (const check of PATTERN_CHECKS) check(lower, leet, r);
    if (opts.checkCommon) commonListCheck(lower, leet, r);
    const score = Math.max(0, Math.min(100, Math.round(r.score)));
    return { strength: strengthFor(score), score, feedback: [...new Set(r.feedback)], patterns: [...new Set(r.patterns)] };
  },

  isCommon(pw: string): boolean {
    return commonPasswords().has(pw.toLowerCase());
  },
};

export const StrengthLevel: Record<PasswordStrength, number> = {
  critical: 0,
  weak: 1,
  medium: 2,
  strong: 3,
  very_strong: 4,
};
