// Criptografia: AES-256-GCM, PBKDF2, codificações e RNG (cobertura mínima de 80%)
import {
  aesDecrypt,
  aesEncrypt,
  concatBytes,
  decryptString,
  deriveKey,
  encryptString,
  equalBytes,
  fromB64,
  fromHex,
  fromUtf8,
  randomBytes,
  randomInt,
  safeEqual,
  sha256Bytes,
  sha256Hex,
  toB64,
  toHex,
  utf8,
  uuid,
  wipe,
} from '../crypto';
import { _test } from '../services/VaultService';

describe('Criptografia', () => {
  it('codifica e decodifica base64/hex/utf8 (inclui emoji e acentos)', () => {
    const b = utf8('Custódia 🔐 ção');
    expect(fromUtf8(b)).toBe('Custódia 🔐 ção');
    expect(toB64(b)).toBe(Buffer.from(b).toString('base64'));
    expect(fromB64(toB64(b))).toEqual(b);
    expect(fromHex(toHex(b))).toEqual(b);
    for (const n of [0, 1, 2, 3, 4, 5]) {
      const r = randomBytes(n);
      expect(toB64(r)).toBe(Buffer.from(r).toString('base64'));
      expect(fromB64(toB64(r))).toEqual(r);
    }
    // base64url também é aceito na decodificação
    expect(fromB64('-_8')).toEqual(new Uint8Array(Buffer.from('+/8', 'base64')));
  });

  it('AES-256-GCM cifra, decifra e detecta adulteração', () => {
    const key = randomBytes(32);
    const ct = aesEncrypt(key, utf8('segredo'));
    expect(fromUtf8(aesDecrypt(key, ct))).toBe('segredo');
    // nonce aleatório: duas cifragens do mesmo texto são diferentes
    expect(toHex(aesEncrypt(key, utf8('segredo')))).not.toBe(toHex(ct));
    ct[ct.length - 1] ^= 1;
    expect(() => aesDecrypt(key, ct)).toThrow();
    expect(() => aesDecrypt(key, new Uint8Array(5))).toThrow('Formato cifrado inválido');
    expect(() => aesDecrypt(randomBytes(32), aesEncrypt(key, utf8('x')))).toThrow();
    expect(decryptString(key, encryptString(key, 'abc', 'aad'), 'aad')).toBe('abc');
    expect(decryptString(key, encryptString(key, 'abc'))).toBe('abc');
    expect(() => decryptString(key, encryptString(key, 'abc', 'aad'), 'outro')).toThrow();
  });

  it('PBKDF2-HMAC-SHA256 é determinístico (vetores RFC 7914)', async () => {
    const k = await deriveKey('passwd', utf8('salt'), 1, 64);
    expect(toHex(k)).toBe(
      '55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783',
    );
    const k2 = await deriveKey('Password', utf8('NaCl'), 80000, 64);
    expect(toHex(k2).slice(0, 32)).toBe('4ddcd8f60b98be21830cee5ef22701f9');
  });

  it('SHA-256 correto', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(toHex(sha256Bytes(utf8('abc')))).toBe(sha256Hex(utf8('abc')));
  });

  it('utilitários de bytes', () => {
    expect(concatBytes(new Uint8Array([1]), new Uint8Array([2, 3]))).toEqual(new Uint8Array([1, 2, 3]));
    expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(equalBytes(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    const w = new Uint8Array([9, 9]);
    wipe(w);
    expect(w).toEqual(new Uint8Array([0, 0]));
    wipe(null);
  });

  it('randomInt é uniforme dentro do intervalo e uuid é v4', () => {
    const counts = [0, 0, 0];
    for (let i = 0; i < 3000; i++) counts[randomInt(3)]++;
    counts.forEach(c => expect(c).toBeGreaterThan(800));
    expect(randomInt(0)).toBe(0);
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('falha de forma explícita sem gerador aleatório seguro', () => {
    const g: any = globalThis;
    const saved = g.crypto;
    try {
      Object.defineProperty(g, 'crypto', { value: undefined, configurable: true, writable: true });
      expect(() => randomBytes(4)).toThrow('Gerador aleatório seguro indisponível');
    } finally {
      Object.defineProperty(g, 'crypto', { value: saved, configurable: true, writable: true });
    }
  });

  it('envelope da chave do cofre (DEK): só abre com o segredo correto', async () => {
    const dek = randomBytes(32);
    const w = await _test.wrapKey('Cofre#Seguro2026', dek);
    expect(w.iter).toBe(310000);
    expect(await _test.unwrapKey('Cofre#Seguro2026', w)).toEqual(dek);
    expect(await _test.unwrapKey('errada', w)).toBeNull();
    // O envelope não contém a DEK em claro
    expect(w.wrapped).not.toContain(toB64(dek));
  });
});
