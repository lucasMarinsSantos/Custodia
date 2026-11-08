// Teste de dicionário
// Compara a senha com a lista local das 10 mil senhas mais comuns e com as palavras do dicionário pt-BR, inclusive
// nas variações que um ataque de dicionário testa primeiro: maiúsculas, leetspeak (s3nh4), números e símbolos no
// começo ou no fim (senha123 + 2026) e duas palavras coladas (amorbrasil). Tudo offline: a senha não sai do aparelho.
// Usado pelo gerador (senha gerada nunca cai no dicionário), pelo cadastro (aviso amarelo) e pela análise do cofre.

import { COMMON_PASSWORDS_RAW } from '../data/commonPasswords';
import { WORDLIST } from '../data/wordlist';
import { DefaultPasswordOptions, PasswordOptions, PasswordService } from './PasswordService';
import { stripAccents } from '../utils';

export interface DictionaryHit {
  found: true;
  /** Entrada do dicionário reconhecida (sem a variação). */
  base: string;
  /** Prefixo e sufixo de números/símbolos acrescentados à palavra. */
  prefix: string;
  suffix: string;
  source: 'common' | 'wordlist' | 'combo';
  /** Mensagem pronta para a interface: "Encontrada em dicionário: 'senha123' + 2026". */
  reason: string;
  /** Estimativa de tentativas de um ataque de dicionário até chegar nesta senha. */
  guesses: number;
}

export type DictionaryResult = DictionaryHit | { found: false };

/** Senhas muito longas não são testadas (nenhuma entrada do dicionário passa de 40 caracteres com variações). */
const MAX_TESTED_LENGTH = 64;
/** Prefixo/sufixo de números e símbolos testado em cada ponta (ex.: "2026!!"). */
const MAX_AFFIX = 8;
const MIN_COMMON = 3;
const MIN_WORD = 4;

const NOT_FOUND: DictionaryResult = { found: false };

// Palavras e senhas muito usadas no Brasil que não estão nas listas em inglês.
const EXTRA_WORDS = [
  'senha', 'admin', 'amor', 'brasil', 'deus', 'jesus', 'familia', 'teste', 'futebol', 'flamengo', 'corinthians',
  'palmeiras', 'santos', 'gremio', 'vasco', 'cruzeiro', 'botafogo', 'fluminense', 'bemvindo', 'princesa',
  'minhasenha', 'mudar', 'trocar', 'acesso', 'login', 'usuario', 'segredo', 'casa', 'mae', 'pai', 'filho', 'filha',
  'gatinha', 'gatinho', 'linda', 'lindo', 'meuamor', 'saudade', 'vida', 'felicidade',
  'senha123', 'senha1234', 'senha12345', 'admin123', 'mudar123', 'brasil123', 'teste123', 'amor123', 'deus123',
];

let commonRank: Map<string, number> | null = null;
let words: Set<string> | null = null;

/** Posição de cada senha comum na lista (a ordem da lista é a ordem de tentativa do atacante). */
function rankMap(): Map<string, number> {
  if (!commonRank) {
    commonRank = new Map();
    COMMON_PASSWORDS_RAW.split('\n').forEach((p, i) => {
      const key = p.trim().toLowerCase();
      if (key && !commonRank!.has(key)) commonRank!.set(key, i + 1);
    });
  }
  return commonRank;
}

function wordSet(): Set<string> {
  if (!words) {
    words = new Set<string>();
    for (const w of [...WORDLIST, ...EXTRA_WORDS]) {
      const n = normalize(w);
      if (n.length >= MIN_WORD || EXTRA_WORDS.includes(w)) words.add(n);
    }
  }
  return words;
}

/** Minúsculas e sem acentos (o atacante testa "familia" e "família" do mesmo jeito). */
const normalize = (s: string) => stripAccents(s.toLowerCase());

// Leetspeak: duas leituras para os dígitos ambíguos (1 → i ou l).
const LEET_I: Record<string, string> = { '@': 'a', '4': 'a', '3': 'e', '1': 'i', '!': 'i', '0': 'o', $: 's', '5': 's', '7': 't', '8': 'b', '9': 'g' };
const LEET_L: Record<string, string> = { ...LEET_I, '1': 'l', '!': 'l' };

function deleet(s: string, table: Record<string, string>): string {
  let out = '';
  for (const ch of s) out += table[ch] ?? ch;
  return out;
}

/** Formas que o atacante testa para um "miolo" de senha: original, leetspeak (duas leituras). */
function variants(core: string): string[] {
  return [...new Set([core, deleet(core, LEET_I), deleet(core, LEET_L)])];
}

const isAffixChar = (ch: string) => !/[a-zÀ-ɏ]/i.test(ch);

/** Tamanho da sequência de números/símbolos no começo e no fim (limitada a MAX_AFFIX). */
function affixRuns(s: string): { lead: number; trail: number } {
  let lead = 0;
  while (lead < s.length && lead < MAX_AFFIX && isAffixChar(s[lead])) lead++;
  let trail = 0;
  while (trail < s.length - lead && trail < MAX_AFFIX && isAffixChar(s[s.length - 1 - trail])) trail++;
  return { lead, trail };
}

interface Match {
  base: string;
  source: DictionaryHit['source'];
  rank: number;
}

/** O miolo é uma senha comum, uma palavra do dicionário ou duas palavras coladas? */
function matchCore(core: string): Match | null {
  const ranks = rankMap();
  const dict = wordSet();
  let combo: Match | null = null;
  for (const v of variants(core)) {
    const r = ranks.get(v);
    if (r && v.length >= MIN_COMMON) return { base: v, source: 'common', rank: r };
    if (dict.has(v)) return { base: v, source: 'wordlist', rank: ranks.size + 1 };
    if (!combo) combo = matchCombo(v);
  }
  return combo;
}

/** Duas entradas coladas (amor + brasil, dragon + 2000). */
function matchCombo(v: string): Match | null {
  if (v.length < 2 * MIN_WORD || !/^[a-z]+$/.test(v)) return null;
  const ranks = rankMap();
  const dict = wordSet();
  const known = (w: string) => dict.has(w) || (ranks.has(w) && /^[a-z]+$/.test(w));
  for (let i = MIN_WORD; i <= v.length - MIN_WORD; i++) {
    const a = v.slice(0, i);
    const b = v.slice(i);
    if (known(a) && known(b)) return { base: `${a} + ${b}`, source: 'combo', rank: (ranks.size + dict.size) * 2 };
  }
  return null;
}

/** Número de variações de afixo que o ataque testa antes de chegar ao prefixo/sufixo usado. */
function affixCost(affix: string): number {
  if (!affix) return 1;
  return Math.pow(/^\d+$/.test(affix) ? 10 : 40, affix.length);
}

function describe(original: string, m: Match, prefix: string, suffix: string): string {
  const shown = m.source === 'combo' ? m.base : `'${m.base}'`;
  const parts = [prefix ? `${prefix} + ` : '', shown, suffix ? ` + ${suffix}` : ''].join('');
  const leet = m.source !== 'combo' && normalize(original).indexOf(m.base) < 0 ? ' (com troca de letras por números)' : '';
  return `Encontrada em dicionário: ${parts}${leet}`;
}

export const DictionaryService = {
  /**
   * Testa a senha como um ataque de dicionário: a senha inteira, depois sem os números/símbolos do começo e do
   * fim (do menor corte para o maior), cada miolo em minúsculas, sem acentos e com leetspeak desfeito.
   */
  check(password: string): DictionaryResult {
    if (!password || password.length > MAX_TESTED_LENGTH) return NOT_FOUND;
    const s = normalize(password);
    const { lead, trail } = affixRuns(s);
    for (let p = 0; p <= lead; p++) {
      for (let t = 0; t <= trail; t++) {
        const core = s.slice(p, s.length - t);
        if (!core) continue;
        const m = matchCore(core);
        if (!m) continue;
        const prefix = password.slice(0, p);
        const suffix = t ? password.slice(password.length - t) : '';
        const guesses = m.rank * affixCost(prefix) * affixCost(suffix);
        return { found: true, base: m.base, prefix, suffix, source: m.source, reason: describe(password, m, prefix, suffix), guesses };
      }
    }
    return NOT_FOUND;
  },

  isDictionary(password: string): boolean {
    return this.check(password).found;
  },

  /**
   * Gera uma senha que não cai no dicionário: se a sorteada cair (pode acontecer com senhas pronunciáveis ou
   * muito curtas), sorteia de novo. O limite de tentativas evita laço infinito com opções impossíveis.
   */
  generate(opts: PasswordOptions = DefaultPasswordOptions, maxTries = 50): string {
    let pw = PasswordService.generate(opts);
    for (let i = 1; i < maxTries && this.isDictionary(pw); i++) pw = PasswordService.generate(opts);
    return pw;
  },
};
