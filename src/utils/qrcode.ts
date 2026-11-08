/* eslint-disable no-bitwise -- Reed-Solomon em GF(256) e códigos BCH dependem de operações de bits */
// Gerador de QR Code em TypeScript puro (ISO/IEC 18004), usado para mostrar a URI otpauth:// da verificação em
// duas etapas. Não há biblioteca de QR instalada; o algoritmo segue o do `qrcode-generator` (MIT),
// limitado ao que o app precisa:
//  • modo byte (UTF-8), nível de correção M (recupera ~15% dos módulos);
//  • versões 1 a 10 (até 213 bytes), escolhidas automaticamente pelo tamanho do texto;
//  • as 8 máscaras são avaliadas pelas 4 regras de penalidade e a de menor pontuação é usada.
//
// A matriz devolvida é `boolean[linha][coluna]` (true = módulo escuro), sem a zona de silêncio.

import { utf8 } from '../crypto';

/** Blocos do nível M por versão: [blocos do grupo 1, dados por bloco, blocos do grupo 2, dados por bloco, EC por bloco]. */
const RS_BLOCKS_M: [number, number, number, number, number][] = [
  [1, 16, 0, 0, 10],
  [1, 28, 0, 0, 16],
  [1, 44, 0, 0, 26],
  [2, 32, 0, 0, 18],
  [2, 43, 0, 0, 24],
  [4, 27, 0, 0, 16],
  [4, 31, 0, 0, 18],
  [2, 38, 2, 39, 22],
  [3, 36, 2, 37, 22],
  [4, 43, 1, 44, 26],
];

/** Centros dos padrões de alinhamento por versão (a versão 1 não tem). */
const ALIGNMENT: number[][] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

export const QR_MAX_VERSION = RS_BLOCKS_M.length;
const EC_LEVEL_M_BITS = 0b00;
const PAD_BYTES = [0xec, 0x11];

// ---------------------------------------------------------------------------
// Aritmética em GF(256) com o polinômio primitivo x^8 + x^4 + x^3 + x^2 + 1 (0x11D)
// ---------------------------------------------------------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Polinômio gerador de grau `n`: (x − α^0)(x − α^1)…(x − α^(n−1)), coeficientes do maior para o menor grau. */
function generatorPoly(n: number): number[] {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Códigos de correção Reed-Solomon: resto da divisão de dados·x^n pelo polinômio gerador. */
export function rsRemainder(data: number[], ecCount: number): number[] {
  const gen = generatorPoly(ecCount);
  const rem = new Array(ecCount).fill(0);
  for (const d of data) {
    const factor = d ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let i = 0; i < ecCount; i++) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

// ---------------------------------------------------------------------------
// Códigos BCH das informações de formato e de versão
// ---------------------------------------------------------------------------
const bitLength = (n: number) => (n === 0 ? 0 : 32 - Math.clz32(n));

function bchRemainder(value: number, poly: number): number {
  let d = value;
  const deg = bitLength(poly);
  while (bitLength(d) >= deg) d ^= poly << (bitLength(d) - deg);
  return d;
}

/** 15 bits de formato (nível M + máscara), já com a máscara fixa 0x5412. */
export function formatBits(mask: number): number {
  const data = (EC_LEVEL_M_BITS << 3) | mask;
  return ((data << 10) | bchRemainder(data << 10, 0x537)) ^ 0x5412;
}

/** 18 bits de versão (versões 7 em diante). */
export function versionBits(version: number): number {
  return (version << 12) | bchRemainder(version << 12, 0x1f25);
}

// ---------------------------------------------------------------------------
// Codificação dos dados
// ---------------------------------------------------------------------------
const dataCapacity = (v: number) => {
  const [b1, d1, b2, d2] = RS_BLOCKS_M[v - 1];
  return b1 * d1 + b2 * d2;
};
const countBits = (v: number) => (v < 10 ? 8 : 16);

/** Menor versão em que `byteLen` bytes cabem no modo byte com correção M (ou 0 se não couber). */
export function pickVersion(byteLen: number): number {
  for (let v = 1; v <= QR_MAX_VERSION; v++) {
    if (4 + countBits(v) + byteLen * 8 <= dataCapacity(v) * 8) return v;
  }
  return 0;
}

class BitBuffer {
  bytes: number[] = [];
  length = 0;
  put(value: number, len: number) {
    for (let i = len - 1; i >= 0; i--) this.putBit(((value >>> i) & 1) === 1);
  }
  putBit(bit: boolean) {
    const idx = this.length >>> 3;
    if (this.bytes.length <= idx) this.bytes.push(0);
    if (bit) this.bytes[idx] |= 0x80 >>> (this.length % 8);
    this.length++;
  }
}

/** Palavras de dados (modo, contagem, bytes, terminador e preenchimento) seguidas das de correção, intercaladas. */
function buildCodewords(bytes: Uint8Array, version: number): number[] {
  const capacity = dataCapacity(version);
  const buf = new BitBuffer();
  buf.put(0b0100, 4); // modo byte
  buf.put(bytes.length, countBits(version));
  for (const b of bytes) buf.put(b, 8);
  buf.put(0, Math.min(4, capacity * 8 - buf.length)); // terminador
  while (buf.length % 8) buf.putBit(false);
  for (let i = 0; buf.bytes.length < capacity; i++) buf.bytes.push(PAD_BYTES[i % 2]);

  const [b1, d1, b2, d2, ec] = RS_BLOCKS_M[version - 1];
  const sizes = [...new Array(b1).fill(d1), ...new Array(b2).fill(d2)];
  const dataBlocks: number[][] = [];
  let offset = 0;
  for (const size of sizes) {
    dataBlocks.push(buf.bytes.slice(offset, offset + size));
    offset += size;
  }
  const ecBlocks = dataBlocks.map(b => rsRemainder(b, ec));
  const out: number[] = [];
  for (let i = 0; i < Math.max(d1, d2); i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ec; i++) for (const b of ecBlocks) out.push(b[i]);
  return out;
}

// ---------------------------------------------------------------------------
// Matriz: padrões fixos, dados e máscara
// ---------------------------------------------------------------------------
type Cell = boolean | null;

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  r => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r * c) % 3) + ((r + c) % 2)) % 2 === 0,
];

function placeFinder(m: Cell[][], row: number, col: number) {
  const n = m.length;
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      if (row + r < 0 || row + r >= n || col + c < 0 || col + c >= n) continue;
      const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
      m[row + r][col + c] = ring !== 2 && ring !== 4; // 3×3 central, anel escuro de 7×7; separador claro
    }
  }
}

function placeAlignment(m: Cell[][], version: number) {
  const pos = ALIGNMENT[version - 1];
  for (const r of pos) {
    for (const c of pos) {
      if (m[r][c] !== null) continue; // sobreposto a um padrão localizador
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) m[r + dr][c + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
    }
  }
}

function placeTiming(m: Cell[][]) {
  for (let i = 8; i < m.length - 8; i++) {
    if (m[i][6] === null) m[i][6] = i % 2 === 0;
    if (m[6][i] === null) m[6][i] = i % 2 === 0;
  }
}

function placeFormat(m: Cell[][], mask: number) {
  const n = m.length;
  const bits = formatBits(mask);
  for (let i = 0; i < 15; i++) {
    const on = ((bits >> i) & 1) === 1;
    // Cópia vertical (coluna 8) e horizontal (linha 8)
    if (i < 6) m[i][8] = on;
    else if (i < 8) m[i + 1][8] = on;
    else m[n - 15 + i][8] = on;
    if (i < 8) m[8][n - i - 1] = on;
    else if (i < 9) m[8][15 - i] = on;
    else m[8][14 - i] = on;
  }
  m[n - 8][8] = true; // módulo escuro fixo
}

function placeVersion(m: Cell[][], version: number) {
  if (version < 7) return;
  const n = m.length;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const on = ((bits >> i) & 1) === 1;
    m[Math.floor(i / 3)][(i % 3) + n - 11] = on;
    m[(i % 3) + n - 11][Math.floor(i / 3)] = on;
  }
}

/** Colunas da área de dados na ordem de leitura: pares da direita para a esquerda, pulando a coluna 6 (sincronismo). */
function dataColumnPairs(n: number): number[] {
  const out: number[] = [];
  for (let right = n - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;
    out.push(right);
  }
  return out;
}

/** Percorre a área de dados em zigue-zague (pares de colunas, da direita para a esquerda, pulando a coluna 6). */
function placeData(m: Cell[][], data: number[], mask: number) {
  const n = m.length;
  const maskFn = MASKS[mask];
  let bitIndex = 0;
  dataColumnPairs(n).forEach((right, pair) => {
    const upward = pair % 2 === 0;
    for (let k = 0; k < n; k++) {
      const row = upward ? n - 1 - k : k;
      for (const col of [right, right - 1]) {
        if (m[row][col] !== null) continue;
        const byte = data[bitIndex >>> 3];
        const dark = byte !== undefined && ((byte >>> (7 - (bitIndex % 8))) & 1) === 1;
        m[row][col] = dark !== maskFn(row, col);
        bitIndex++;
      }
    }
  });
}

function buildMatrix(version: number, codewords: number[], mask: number): boolean[][] {
  const n = 17 + version * 4;
  const m: Cell[][] = Array.from({ length: n }, () => new Array<Cell>(n).fill(null));
  placeFinder(m, 0, 0);
  placeFinder(m, n - 7, 0);
  placeFinder(m, 0, n - 7);
  placeAlignment(m, version);
  placeTiming(m);
  placeFormat(m, mask);
  placeVersion(m, version);
  placeData(m, codewords, mask);
  return m as boolean[][];
}

// ---------------------------------------------------------------------------
// Penalidades (seção 7.8.3 da norma) para escolher a máscara
// ---------------------------------------------------------------------------
function runPenalty(line: boolean[]): number {
  let score = 0;
  let run = 1;
  for (let i = 1; i <= line.length; i++) {
    if (i < line.length && line[i] === line[i - 1]) {
      run++;
      continue;
    }
    if (run >= 5) score += 3 + (run - 5);
    run = 1;
  }
  // Padrão parecido com o localizador (1:1:3:1:1) com 4 módulos claros de um dos lados
  const s = line.map(b => (b ? '1' : '0')).join('');
  for (const pat of ['10111010000', '00001011101']) {
    for (let i = s.indexOf(pat); i >= 0; i = s.indexOf(pat, i + 1)) score += 40;
  }
  return score;
}

/** Bloco 2×2 da mesma cor com canto superior esquerdo em (r, c). */
function sameBlock(m: boolean[][], r: number, c: number): boolean {
  if (r >= m.length - 1 || c >= m.length - 1) return false;
  const v = m[r][c];
  return m[r][c + 1] === v && m[r + 1][c] === v && m[r + 1][c + 1] === v;
}

export function penalty(m: boolean[][]): number {
  const n = m.length;
  let score = 0;
  let dark = 0;
  for (let i = 0; i < n; i++) {
    score += runPenalty(m[i]);
    score += runPenalty(m.map(row => row[i]));
  }
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (m[r][c]) dark++;
      if (sameBlock(m, r, c)) score += 3;
    }
  }
  score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return score;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
export interface QrMatrix {
  version: number;
  mask: number;
  size: number;
  modules: boolean[][];
}

/** Gera o QR Code do texto (UTF-8). Lança erro se o texto não couber na versão 10 com correção M. */
export function encodeQr(text: string, opts: { mask?: number } = {}): QrMatrix {
  const bytes = utf8(text);
  const version = pickVersion(bytes.length);
  if (!version) throw new Error('Texto grande demais para o QR Code');
  const codewords = buildCodewords(bytes, version);
  let best: QrMatrix | null = null;
  let bestScore = Infinity;
  const masks = opts.mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [opts.mask];
  for (const mask of masks) {
    const modules = buildMatrix(version, codewords, mask);
    const score = masks.length > 1 ? penalty(modules) : 0;
    if (score < bestScore) {
      bestScore = score;
      best = { version, mask, size: modules.length, modules };
    }
  }
  return best!;
}

/** Capacidade máxima (bytes UTF-8) suportada. */
export const QR_MAX_BYTES = (() => {
  let max = 0;
  while (pickVersion(max + 1)) max++;
  return max;
})();
