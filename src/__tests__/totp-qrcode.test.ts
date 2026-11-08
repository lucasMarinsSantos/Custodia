// TOTP (RFC 6238/4226) e o gerador de QR Code em TS puro.
// O QR é conferido por um decodificador independente escrito aqui (lê o formato, desfaz a máscara, separa os
// blocos, confere a síndrome Reed-Solomon de cada bloco e lê o modo byte), além de vetores conhecidos.
/* eslint-disable no-bitwise */
import { base32Decode, base32Encode, hotp, TotpService, totpCounter } from '../services/TotpService';
import { encodeQr, formatBits, QR_MAX_BYTES, rsRemainder, versionBits } from '../utils/qrcode';
import { utf8 } from '../crypto';

const RFC_SECRET = base32Encode(utf8('12345678901234567890'));

describe('TOTP (RFC 6238 e RFC 4226)', () => {
  it('Base32 (RFC 4648): vetores oficiais e ida e volta', () => {
    const vectors: [string, string][] = [
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ];
    for (const [plain, enc] of vectors) {
      expect(base32Encode(utf8(plain))).toBe(enc);
      expect(Buffer.from(base32Decode(enc)).toString()).toBe(plain);
    }
    expect(Buffer.from(base32Decode('mzxw 6ytb-oi======')).toString()).toBe('foobar');
    expect(() => base32Decode('MZXW1')).toThrow('Base32');
    expect(() => base32Decode('A'.repeat(500))).toThrow('grande demais');
    const s = TotpService.generateSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)).toHaveLength(20);
  });

  it('HOTP: vetores do apêndice D da RFC 4226', () => {
    const key = utf8('12345678901234567890');
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => expect(hotp(key, counter)).toBe(code));
    expect(() => hotp(key, -1)).toThrow();
  });

  it('TOTP: vetores SHA-1 do apêndice B da RFC 6238 (8 dígitos) e 6 dígitos', () => {
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [t, code] of vectors) {
      expect(TotpService.generate(RFC_SECRET, t * 1000, 8)).toBe(code);
      expect(TotpService.generate(RFC_SECRET, t * 1000)).toBe(code.slice(2));
    }
    expect(totpCounter(59000)).toBe(1);
    expect(TotpService.remaining(59000)).toBe(1);
  });

  it('BDD: gera senhas numéricas de 6 dígitos que mudam a cada 30 segundos', () => {
    const t = 1_700_000_010_000;
    const a = TotpService.generate(RFC_SECRET, t);
    expect(a).toMatch(/^\d{6}$/);
    expect(TotpService.generate(RFC_SECRET, t + 19_000)).toBe(a); // mesma janela
    expect(TotpService.generate(RFC_SECRET, t + 30_000)).not.toBe(a); // próxima janela
  });

  it('verificação: aceita ±1 janela, recusa fora dela, formatos inválidos e reuso (anti-replay)', () => {
    const t = 1_700_000_000_000;
    const now = totpCounter(t);
    const at = (w: number) => TotpService.generate(RFC_SECRET, t + w * 30_000);
    expect(TotpService.verify(RFC_SECRET, at(0), { at: t })).toBe(now);
    expect(TotpService.verify(RFC_SECRET, at(-1), { at: t })).toBe(now - 1);
    expect(TotpService.verify(RFC_SECRET, at(1), { at: t })).toBe(now + 1);
    expect(TotpService.verify(RFC_SECRET, at(2), { at: t })).toBeNull();
    expect(TotpService.verify(RFC_SECRET, at(-2), { at: t })).toBeNull();
    expect(TotpService.verify(RFC_SECRET, `${at(0).slice(0, 3)} ${at(0).slice(3)}`, { at: t })).toBe(now);
    for (const bad of ['', '12345', '1234567', 'abcdef', '12345a']) expect(TotpService.verify(RFC_SECRET, bad, { at: t })).toBeNull();
    // Código já usado (contador ≤ último aceito) é recusado, mesmo dentro da janela
    expect(TotpService.verify(RFC_SECRET, at(0), { at: t, afterCounter: now })).toBeNull();
    expect(TotpService.verify(RFC_SECRET, at(-1), { at: t, afterCounter: now - 1 })).toBeNull();
    expect(TotpService.verify(RFC_SECRET, at(1), { at: t, afterCounter: now })).toBe(now + 1);
  });

  it('URI otpauth: monta no formato dos autenticadores e valida a entrada de terceiros', () => {
    const uri = TotpService.buildUri('JBSWY3DPEHPK3PXP', 'Pessoal');
    expect(uri).toBe('otpauth://totp/Cust%C3%B3dia:Pessoal?secret=JBSWY3DPEHPK3PXP&issuer=Cust%C3%B3dia');
    expect(TotpService.parseUri(uri)).toMatchObject({ secret: 'JBSWY3DPEHPK3PXP', issuer: 'Custódia', account: 'Pessoal' });
    expect(() => TotpService.parseUri('https://evil.example/?secret=JBSWY3DPEHPK3PXP')).toThrow('otpauth');
    expect(() => TotpService.parseUri('otpauth://totp/x?secret=ABC')).toThrow('Segredo');
    expect(() => TotpService.parseUri('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=8')).toThrow('6 dígitos');
    expect(() => TotpService.parseUri('otpauth://totp/x?secret=' + 'A'.repeat(600))).toThrow('grande demais');
    expect(TotpService.parseUri('otpauth://totp/%E0%A4%A?secret=JBSWY3DPEHPK3PXP').secret).toBe('JBSWY3DPEHPK3PXP');
  });
});

// -----------------------------------------------------------------------------
// Decodificador independente (para conferir o encoder)
// -----------------------------------------------------------------------------
const M_BLOCKS: Record<number, number[][]> = {
  1: [[1, 16]],
  2: [[1, 28]],
  3: [[1, 44]],
  4: [[2, 32]],
  5: [[2, 43]],
  6: [[4, 27]],
  7: [[4, 31]],
  8: [[2, 38], [2, 39]],
  9: [[3, 36], [2, 37]],
  10: [[4, 43], [1, 44]],
};
const M_EC: Record<number, number> = { 1: 10, 2: 16, 3: 26, 4: 18, 5: 24, 6: 16, 7: 18, 8: 22, 9: 22, 10: 26 };
const ALIGN: Record<number, number[]> = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

// GF(256) próprio do teste
const gexp: number[] = [];
const glog: number[] = [];
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    gexp[i] = x;
    glog[x] = i;
    x = x << 1;
    if (x > 255) x ^= 0x11d;
  }
}
const gmul = (a: number, b: number) => (a && b ? gexp[(glog[a] + glog[b]) % 255] : 0);

/** Síndromes do bloco (dados + correção) avaliadas em α^0..α^(n−1): todas zero = palavra de código válida. */
function syndromesZero(block: number[], ec: number): boolean {
  for (let i = 0; i < ec; i++) {
    let s = 0;
    for (const b of block) s = gmul(s, gexp[i]) ^ b;
    if (s !== 0) return false;
  }
  return true;
}

function isFunctionModule(n: number, version: number, r: number, c: number): boolean {
  const inFinder = (r0: number, c0: number) => r >= r0 - 1 && r <= r0 + 7 && c >= c0 - 1 && c <= c0 + 7;
  if (inFinder(0, 0) || inFinder(0, n - 7) || inFinder(n - 7, 0)) return true;
  if (r === 6 || c === 6) return true; // linhas de sincronismo
  if ((r === 8 && (c <= 8 || c >= n - 8)) || (c === 8 && (r <= 8 || r >= n - 8))) return true; // formato e módulo escuro
  if (version >= 7 && ((r < 6 && c >= n - 11 && c < n - 8) || (c < 6 && r >= n - 11 && r < n - 8))) return true;
  const pos = ALIGN[version];
  for (const ar of pos) {
    for (const ac of pos) {
      const overlapsFinder = (ar === 6 && ac === 6) || (ar === 6 && ac === pos[pos.length - 1]) || (ar === pos[pos.length - 1] && ac === 6);
      if (!overlapsFinder && Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2) return true;
    }
  }
  return false;
}

function decodeQr(m: boolean[][]): { text: string; mask: number; version: number } {
  const n = m.length;
  const version = (n - 17) / 4;
  // Formato: bits 0..14 ao longo da coluna 8 (linhas 0-5, 7, 8 e as 7 de baixo)
  const rows = [0, 1, 2, 3, 4, 5, 7, 8, n - 7, n - 6, n - 5, n - 4, n - 3, n - 2, n - 1];
  let fmt = 0;
  rows.forEach((r, i) => {
    if (m[r][8]) fmt |= 1 << i;
  });
  fmt ^= 0x5412;
  expect(fmt >> 13).toBe(0); // nível M = 00
  const mask = (fmt >> 10) & 7;
  // Lê os bits em zigue-zague, desfazendo a máscara
  const maskFns = [
    (i: number, j: number) => (i + j) % 2 === 0,
    (i: number) => i % 2 === 0,
    (_: number, j: number) => j % 3 === 0,
    (i: number, j: number) => (i + j) % 3 === 0,
    (i: number, j: number) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
    (i: number, j: number) => ((i * j) % 2) + ((i * j) % 3) === 0,
    (i: number, j: number) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
    (i: number, j: number) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0,
  ];
  const bits: number[] = [];
  let up = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let k = 0; k < n; k++) {
      const r = up ? n - 1 - k : k;
      for (const c of [col, col - 1]) {
        if (isFunctionModule(n, version, r, c)) continue;
        bits.push(m[r][c] !== maskFns[mask](r, c) ? 1 : 0);
      }
    }
    up = !up;
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  // Separa os blocos (intercalados) e confere a correção de cada um
  const sizes = M_BLOCKS[version].flatMap(([count, size]) => new Array(count).fill(size));
  const ec = M_EC[version];
  const blocks: number[][] = sizes.map(() => []);
  let p = 0;
  for (let i = 0; i < Math.max(...sizes); i++) sizes.forEach((s, b) => i < s && blocks[b].push(bytes[p++]));
  for (let i = 0; i < ec; i++) blocks.forEach(b => b.push(bytes[p++]));
  for (const b of blocks) expect(syndromesZero(b, ec)).toBe(true);
  const data = blocks.flatMap((b, i) => b.slice(0, sizes[i]));
  // Modo byte
  const dataBits = data.map(b => b.toString(2).padStart(8, '0')).join('');
  expect(dataBits.slice(0, 4)).toBe('0100');
  const cbits = version < 10 ? 8 : 16;
  const len = parseInt(dataBits.slice(4, 4 + cbits), 2);
  const out: number[] = [];
  for (let i = 0; i < len; i++) out.push(parseInt(dataBits.slice(4 + cbits + i * 8, 12 + cbits + i * 8), 2));
  return { text: Buffer.from(out).toString('utf8'), mask, version };
}

describe('QR Code (modo byte, correção M)', () => {
  it('Reed-Solomon: vetor do exemplo "HELLO WORLD" 1-M', () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(rsRemainder(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it('informação de formato (BCH 15,5) e de versão (BCH 18,6): tabelas da norma', () => {
    const fmtM = ['101010000010010', '101000100100101', '101111001111100', '101101101001011', '100010111111001', '100000011001110', '100111110010111', '100101010100000'];
    fmtM.forEach((bits, mask) => expect(formatBits(mask).toString(2).padStart(15, '0')).toBe(bits));
    expect(versionBits(7).toString(2).padStart(18, '0')).toBe('000111110010010100');
    expect(versionBits(10).toString(2).padStart(18, '0')).toBe('001010010011010011');
  });

  it('padrões fixos: localizadores nos 3 cantos, sincronismo e módulo escuro', () => {
    const qr = encodeQr('Custódia');
    const m = qr.modules;
    const n = qr.size;
    expect(n).toBe(21);
    for (const [r0, c0] of [
      [0, 0],
      [0, n - 7],
      [n - 7, 0],
    ]) {
      const ring = [0, 1, 2, 3, 4, 5, 6].map(i => m[r0][c0 + i]);
      expect(ring).toEqual([true, true, true, true, true, true, true]);
      expect(m[r0 + 3][c0 + 3]).toBe(true);
      expect(m[r0 + 1][c0 + 1]).toBe(false);
    }
    for (let i = 8; i < n - 8; i++) {
      expect(m[6][i]).toBe(i % 2 === 0);
      expect(m[i][6]).toBe(i % 2 === 0);
    }
    expect(m[n - 8][8]).toBe(true);
  });

  it('decodifica de volta textos de vários tamanhos (versões 1 a 10) e todas as máscaras', () => {
    const samples = ['A', 'Custódia', 'x'.repeat(40), 'otpauth://totp/Cust%C3%B3dia:Pessoal?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Cust%C3%B3dia', 'é'.repeat(75), 'z'.repeat(QR_MAX_BYTES)];
    const versions = new Set<number>();
    for (const s of samples) {
      const qr = encodeQr(s);
      const d = decodeQr(qr.modules);
      expect(d.text).toBe(s);
      expect(d.mask).toBe(qr.mask);
      versions.add(qr.version);
    }
    expect([...versions].some(v => v >= 7)).toBe(true); // passa pela informação de versão
    for (let mask = 0; mask < 8; mask++) expect(decodeQr(encodeQr('máscara ' + mask, { mask }).modules).text).toBe('máscara ' + mask);
    expect(QR_MAX_BYTES).toBe(213);
  });

  it('recusa texto acima da capacidade', () => {
    expect(() => encodeQr('z'.repeat(QR_MAX_BYTES + 1))).toThrow('grande demais');
  });
});
