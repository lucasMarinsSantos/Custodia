// Serviço do cofre: criação, hierarquia de chaves, desbloqueio e recuperação
//
// Hierarquia de chaves (zero-knowledge):
//   DEK (32 bytes aleatórios)  → chave do banco SQLCipher; só existe em memória com o cofre aberto
//   KEK_mestra  = PBKDF2(senha mestra, salt)          → envelopa a DEK
//   KEK_recup.  = PBKDF2(código de recuperação, salt) → envelopa a DEK (restauração de emergência)
//   KEK_pergun. = PBKDF2(respostas normalizadas)      → envelopa a DEK (perguntas de segurança)
//   KEK_frase   = PBKDF2(frase de 12 palavras)        → envelopa a DEK (frase semente)
//   Android Keystore → todos os envelopes ficam em preferências cifradas por chave AES do Keystore
//   Biometria  → DEK cifrada por chave do Keystore que exige autenticação biométrica

import { aesDecrypt, aesEncrypt, deriveKey, fromB64, PBKDF2_ITERATIONS, randomBytes, randomInt, toB64, toHex, utf8, uuid, wipe } from '../crypto';
import { vaultDb, VaultDatabase } from '../db/Database';
import { Security } from '../native';
import { AppSettings, DefaultSettings, Profile } from '../types/models';
import { WORDLIST } from '../data/wordlist';
import { commonPasswords } from './PasswordService';
import { bus, Events } from './events';

interface Wrapped {
  salt: string;
  iter: number;
  wrapped: string;
}

interface VaultKeys {
  version: 1;
  master: Wrapped;
  recoveryCode: Wrapped;
  questions?: Wrapped & { items: string[] };
  phrase?: Wrapped;
  hint?: string;
  createdAt: string;
  passwordSetAt: string;
}

interface LockoutState {
  failures: number;
  lockedUntil: number;
}

export type UnlockMethod = 'password' | 'biometric' | 'recovery';

/** Após 5 falhas seguidas o desbloqueio fica bloqueado temporariamente (30 s, dobrando a cada falha). */
export const MAX_FAILURES = 5;
const MSG_LOCKED = 'Cofre bloqueado';
const MSG_BIO_LOCKED = 'Biometria desativada temporariamente por segurança. Use a senha mestra.';
export const MAX_LOCKOUT_MS = 30 * 60 * 1000;
export const MIN_QUESTIONS = 3;
export const MIN_ANSWER_LENGTH = 3;
/** Após 5 falhas de leitura biométrica a biometria fica desativada por este período (BDD). */
export const BIOMETRIC_LOCKOUT_MS = 5 * 60 * 1000;

const k = (profileId: string, name: string) => `p:${profileId}:${name}`;

export class MasterPasswordPolicy {
  static check(pw: string) {
    return {
      length: pw.length >= 12,
      upper: /[A-Z]/.test(pw),
      lower: /[a-z]/.test(pw),
      number: /[0-9]/.test(pw),
      symbol: /[^A-Za-z0-9]/.test(pw),
    };
  }

  /** Senha considerada fraca ou comum (lista das 10 mil mais usadas): é rejeitada. */
  static isCommon(pw: string): boolean {
    return pw.length > 0 && commonPasswords().has(pw.toLowerCase());
  }

  static isValid(pw: string): boolean {
    const c = MasterPasswordPolicy.check(pw);
    return c.length && c.upper && c.lower && c.number && c.symbol && !MasterPasswordPolicy.isCommon(pw);
  }

  /** Primeira mensagem de erro aplicável (textos dos cenários BDD). */
  static error(pw: string): string | null {
    const c = MasterPasswordPolicy.check(pw);
    if (!c.length) return 'A senha deve conter pelo menos 12 caracteres';
    if (!c.upper || !c.lower) return 'A senha deve conter letras maiúsculas e minúsculas';
    if (!c.number) return 'A senha deve conter pelo menos um número';
    if (!c.symbol) return 'A senha deve conter pelo menos um símbolo';
    if (MasterPasswordPolicy.isCommon(pw)) return 'Esta senha é comum demais e foi rejeitada';
    return null;
  }
}

export function normalizeAnswer(a: string): string {
  return a
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function generateRecoveryCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const groups: string[] = [];
  for (let g = 0; g < 6; g++) {
    let s = '';
    for (let i = 0; i < 5; i++) s += alphabet[randomInt(alphabet.length)];
    groups.push(s);
  }
  return groups.join('-');
}

export const normalizeRecoveryCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');

export function generatePhrase(words = 12): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(WORDLIST[randomInt(WORDLIST.length)]);
  return out.join(' ');
}

export const normalizePhrase = (p: string) => normalizeAnswer(p).split(' ').filter(Boolean).join(' ');

async function wrapKey(secret: string, dek: Uint8Array): Promise<Wrapped> {
  const salt = randomBytes(16);
  const kek = await deriveKey(secret, salt, PBKDF2_ITERATIONS);
  const wrapped = toB64(aesEncrypt(kek, dek, utf8('custodia-dek')));
  wipe(kek);
  return { salt: toB64(salt), iter: PBKDF2_ITERATIONS, wrapped };
}

async function unwrapKey(secret: string, w: Wrapped): Promise<Uint8Array | null> {
  const kek = await deriveKey(secret, fromB64(w.salt), w.iter);
  try {
    return aesDecrypt(kek, fromB64(w.wrapped), utf8('custodia-dek'));
  } catch {
    return null;
  } finally {
    wipe(kek);
  }
}

class VaultServiceImpl {
  private dek: Uint8Array | null = null;
  private profile: Profile | null = null;
  settings: AppSettings = { ...DefaultSettings };

  // ---------------------------------------------------------------------------
  // Cofre (por enquanto um cofre por aparelho)
  // ---------------------------------------------------------------------------
  async getProfile(): Promise<Profile | null> {
    const raw = await Security.secureGet('profile');
    return raw ? JSON.parse(raw) : null;
  }

  get currentProfile(): Profile | null {
    return this.profile;
  }

  get isUnlocked(): boolean {
    return this.dek !== null && vaultDb.isOpen;
  }

  async hasVault(): Promise<boolean> {
    return (await this.getProfile()) !== null;
  }

  async createVault(opts: { name?: string; masterPassword: string; hint?: string }): Promise<{ profile: Profile; recoveryCode: string }> {
    const err = MasterPasswordPolicy.error(opts.masterPassword);
    if (err) throw new Error(err);
    if (await this.hasVault()) throw new Error('Já existe um cofre neste aparelho.');
    if (opts.hint && opts.hint.toLowerCase().includes(opts.masterPassword.toLowerCase())) {
      throw new Error('A dica não pode conter a senha.');
    }
    const profile: Profile = {
      id: uuid(),
      name: opts.name?.trim() || 'Meu cofre',
      color: '#0D9488',
      createdAt: new Date().toISOString(),
    };
    const dek = randomBytes(32);
    const recoveryCode = generateRecoveryCode();
    const keys: VaultKeys = {
      version: 1,
      master: await wrapKey(opts.masterPassword, dek),
      recoveryCode: await wrapKey(normalizeRecoveryCode(recoveryCode), dek),
      hint: opts.hint?.trim() || undefined,
      createdAt: new Date().toISOString(),
      passwordSetAt: new Date().toISOString(),
    };
    await Security.secureSet(k(profile.id, 'keys'), JSON.stringify(keys));
    await Security.secureSet(k(profile.id, 'settings'), JSON.stringify(DefaultSettings));
    await Security.secureSet('profile', JSON.stringify(profile));

    await vaultDb.open(profile.id, toHex(dek));
    this.dek = dek;
    this.profile = profile;
    this.settings = { ...DefaultSettings };
    // O código de recuperação acompanha o evento para a tela de "Proteja seu acesso" ser exibida em seguida
    bus.emit(Events.UNLOCKED, { recoveryCode });
    return { profile, recoveryCode };
  }

  private async getKeys(profileId: string): Promise<VaultKeys> {
    const raw = await Security.secureGet(k(profileId, 'keys'));
    if (!raw) throw new Error('Cofre não encontrado');
    return JSON.parse(raw);
  }

  private async saveKeys(profileId: string, keys: VaultKeys) {
    await Security.secureSet(k(profileId, 'keys'), JSON.stringify(keys));
  }

  /** Fila das alterações nos envelopes: duas operações seguidas (ex.: gerar frase e gerar código) não se sobrescrevem. */
  private keysQueue: Promise<unknown> = Promise.resolve();

  /** Lê, altera e grava os envelopes em seção crítica curta (a derivação lenta acontece antes, fora da fila). */
  private updateKeys(profileId: string, change: (keys: VaultKeys) => void): Promise<void> {
    const run = async () => {
      const keys = await this.getKeys(profileId);
      change(keys);
      await this.saveKeys(profileId, keys);
    };
    const p = this.keysQueue.then(run, run);
    this.keysQueue = p.catch(() => undefined);
    return p;
  }

  async getHint(profileId: string): Promise<string | undefined> {
    return (await this.getKeys(profileId)).hint;
  }

  async getRecoveryOptions(profileId: string): Promise<{ questions: string[] | null; phrase: boolean }> {
    const keys = await this.getKeys(profileId);
    return { questions: keys.questions?.items ?? null, phrase: !!keys.phrase };
  }

  // ---------------------------------------------------------------------------
  // Configurações (disponíveis antes do desbloqueio: teclado seguro, biometria)
  // ---------------------------------------------------------------------------
  async loadSettings(profileId: string): Promise<AppSettings> {
    const raw = await Security.secureGet(k(profileId, 'settings'));
    return { ...DefaultSettings, ...(raw ? JSON.parse(raw) : {}) };
  }

  async updateSettings(patch: Partial<AppSettings>) {
    if (!this.profile) return;
    this.settings = { ...this.settings, ...patch };
    await Security.secureSet(k(this.profile.id, 'settings'), JSON.stringify(this.settings));
    bus.emit(Events.SETTINGS_CHANGED, this.settings);
  }

  // ---------------------------------------------------------------------------
  // Tentativas / bloqueio temporário
  // ---------------------------------------------------------------------------
  async getLockout(profileId: string): Promise<LockoutState> {
    const raw = await Security.secureGet(k(profileId, 'lockout'));
    return raw ? JSON.parse(raw) : { failures: 0, lockedUntil: 0 };
  }

  private async registerFailure(profileId: string) {
    const st = await this.getLockout(profileId);
    st.failures += 1;
    if (st.failures >= MAX_FAILURES) {
      st.lockedUntil = Date.now() + Math.min(30000 * 2 ** (st.failures - MAX_FAILURES), MAX_LOCKOUT_MS);
    }
    await Security.secureSet(k(profileId, 'lockout'), JSON.stringify(st));
  }

  private async clearFailures(profileId: string) {
    await Security.secureSet(k(profileId, 'lockout'), JSON.stringify({ failures: 0, lockedUntil: 0 }));
  }

  private async assertNotLockedOut(profileId: string) {
    const st = await this.getLockout(profileId);
    const now = Date.now();
    if (st.lockedUntil > now) {
      // Relógio atrasado manualmente: o bloqueio é reancorado no máximo (30 min) a partir de agora, sem ser liberado antes.
      if (st.lockedUntil - now > MAX_LOCKOUT_MS) {
        st.lockedUntil = now + MAX_LOCKOUT_MS;
        await Security.secureSet(k(profileId, 'lockout'), JSON.stringify(st));
      }
      throw new Error(`Muitas tentativas. Aguarde ${Math.ceil((st.lockedUntil - now) / 1000)}s.`);
    }
  }

  /** Serializa as verificações de segredo: tentativas em paralelo não escapam do limite de falhas. */
  private authQueue: Promise<unknown> = Promise.resolve();

  /**
   * Executa uma tentativa de autenticação contando a falha ANTES da derivação de chave (lenta).
   * Se o app for encerrado no meio, a tentativa já ficou registrada. Em caso de acerto, o contador volta ao estado anterior.
   */
  private attempt<T>(profileId: string, fn: () => Promise<T | null>): Promise<T | null> {
    const run = async () => {
      await this.assertNotLockedOut(profileId);
      const before = await this.getLockout(profileId);
      await this.registerFailure(profileId);
      const result = await fn();
      if (result) await Security.secureSet(k(profileId, 'lockout'), JSON.stringify(before));
      return result;
    };
    const p = this.authQueue.then(run, run);
    this.authQueue = p.catch(() => undefined);
    return p;
  }

  /** Biometria desativada temporariamente após 5 leituras não reconhecidas (cenário BDD). */
  async biometricLockedUntil(profileId: string): Promise<number> {
    const raw = await Security.secureGet(k(profileId, 'bioLockout'));
    const until = raw ? Number(raw) : 0;
    return until > Date.now() ? until : 0;
  }

  // ---------------------------------------------------------------------------
  // Desbloqueio
  // ---------------------------------------------------------------------------
  private async finishUnlock(profileId: string, dek: Uint8Array, recoveryCode: string | null = null) {
    const profile = await this.getProfile();
    if (!profile || profile.id !== profileId) throw new Error('Cofre não encontrado');
    await vaultDb.open(profileId, toHex(dek));
    this.dek = dek;
    this.profile = profile;
    this.settings = await this.loadSettings(profileId);
    await this.clearFailures(profileId);
    // "5 leituras seguidas": entrar no cofre (por qualquer meio) zera a contagem de leituras biométricas falhas
    await Security.secureRemove(k(profileId, 'bioFailures')).catch(() => {});
    bus.emit(Events.UNLOCKED, recoveryCode ? { recoveryCode } : undefined);
  }

  /** Senha mestra → DEK. Falhas contam para o bloqueio temporário. */
  async verifyPassword(profileId: string, password: string): Promise<Uint8Array> {
    const dek = await this.attempt(profileId, async () => unwrapKey(password, (await this.getKeys(profileId)).master));
    if (!dek) throw new Error('Senha mestra incorreta.');
    return dek;
  }

  async verifyBiometric(profileId: string): Promise<Uint8Array> {
    if (await this.biometricLockedUntil(profileId)) {
      throw new Error(MSG_BIO_LOCKED);
    }
    try {
      const b64 = await Security.biometricUnlock(`bio_${profileId}`, 'Desbloquear Custódia', 'Use sua digital ou reconhecimento facial');
      await Security.secureRemove(k(profileId, 'bioFailures'));
      return fromB64(b64);
    } catch (e: any) {
      throw await this.biometricError(profileId, e);
    }
  }

  /** Traduz a falha do BiometricPrompt na mensagem do app e aplica as regras de bloqueio. */
  private async biometricError(profileId: string, e: any): Promise<Error> {
    const code = String(e?.code || '');
    const msg = String(e?.message || e);
    if (/cancel/i.test(msg) || code === 'E_CANCELLED') return new Error('Autenticação biométrica cancelada. Use a senha mestra.');
    if (code === 'E_LOCKOUT' || /lockout|muitas tentativas|too many/i.test(msg)) {
      await Security.secureSet(k(profileId, 'bioLockout'), String(Date.now() + BIOMETRIC_LOCKOUT_MS));
      return new Error(MSG_BIO_LOCKED);
    }
    if (code === 'E_INVALIDATED') {
      await this.updateSettingsFor(profileId, { biometricEnabled: false });
      return new Error(msg);
    }
    // Outras falhas (sensor ocupado, tempo esgotado…) não contam como leitura errada
    if (code !== 'E_NOT_RECOGNIZED') return new Error(`Não foi possível usar a biometria (${msg}). Use a senha mestra.`);
    // Leitura não reconhecida: 5 seguidas desativam a biometria temporariamente
    const failures = Number((await Security.secureGet(k(profileId, 'bioFailures'))) || 0) + 1;
    if (failures >= MAX_FAILURES) {
      await Security.secureRemove(k(profileId, 'bioFailures'));
      await Security.secureSet(k(profileId, 'bioLockout'), String(Date.now() + BIOMETRIC_LOCKOUT_MS));
      return new Error(MSG_BIO_LOCKED);
    }
    await Security.secureSet(k(profileId, 'bioFailures'), String(failures));
    return new Error('Não foi possível reconhecer a biometria. Use a senha mestra.');
  }

  private async updateSettingsFor(profileId: string, patch: Partial<AppSettings>) {
    const s = { ...(await this.loadSettings(profileId)), ...patch };
    await Security.secureSet(k(profileId, 'settings'), JSON.stringify(s));
  }

  async completeUnlock(profileId: string, dek: Uint8Array, _method: UnlockMethod = 'password') {
    await this.finishUnlock(profileId, dek);
  }

  // ---------------------------------------------------------------------------
  // Biometria
  // ---------------------------------------------------------------------------
  async enableBiometric(): Promise<void> {
    if (!this.profile || !this.dek) throw new Error(MSG_LOCKED);
    const avail = await Security.biometricAvailable();
    if (!avail.available) throw new Error(avail.reason || 'Biometria indisponível neste aparelho.');
    if (!this.profile || !this.dek) throw new Error(MSG_LOCKED);
    await Security.biometricEnroll(`bio_${this.profile.id}`, toB64(this.dek), 'Ativar desbloqueio biométrico', 'Confirme sua digital ou rosto');
    await Security.secureRemove(k(this.profile.id, 'bioLockout'));
    await this.updateSettings({ biometricEnabled: true });
  }

  async disableBiometric(): Promise<void> {
    if (!this.profile) return;
    await Security.biometricRemove(`bio_${this.profile.id}`);
    await this.updateSettings({ biometricEnabled: false });
  }

  // ---------------------------------------------------------------------------
  // Recuperação e restauração de emergência
  // ---------------------------------------------------------------------------
  /**
   * Envelopa a DEK com um segredo de recuperação. Usa uma CÓPIA da chave: se o cofre bloquear durante a derivação
   * (app minimizado, sensor), o lock() zera a DEK original, e envelopar a original gravaria uma chave de zeros.
   */
  private async wrapCurrentDek(secret: string) {
    if (!this.profile || !this.dek) throw new Error(MSG_LOCKED);
    const profileId = this.profile.id;
    const dek = this.dek.slice();
    try {
      const wrapped = await wrapKey(secret, dek);
      if (!this.dek || this.profile?.id !== profileId) throw new Error(MSG_LOCKED);
      return { profileId, wrapped };
    } finally {
      wipe(dek);
    }
  }

  async setSecurityQuestions(items: { question: string; answer: string }[]) {
    if (!this.profile || !this.dek) throw new Error(MSG_LOCKED);
    if (items.length < MIN_QUESTIONS || items.some(i => !i.question.trim() || normalizeAnswer(i.answer).length < MIN_ANSWER_LENGTH)) {
      throw new Error(`Informe ao menos ${MIN_QUESTIONS} perguntas, com respostas de ${MIN_ANSWER_LENGTH} ou mais caracteres.`);
    }
    if (new Set(items.map(i => normalizeAnswer(i.answer))).size < items.length) {
      throw new Error('Use respostas diferentes para cada pergunta.');
    }
    const secret = items.map(i => normalizeAnswer(i.answer)).join('|');
    const { profileId, wrapped } = await this.wrapCurrentDek(secret);
    const questions = { ...wrapped, items: items.map(i => i.question.trim()) };
    await this.updateKeys(profileId, keys => {
      keys.questions = questions;
    });
  }

  async setRecoveryPhrase(): Promise<string> {
    if (!this.profile || !this.dek) throw new Error(MSG_LOCKED);
    const phrase = generatePhrase(12);
    const { profileId, wrapped } = await this.wrapCurrentDek(normalizePhrase(phrase));
    await this.updateKeys(profileId, keys => {
      keys.phrase = wrapped;
    });
    return phrase;
  }

  async regenerateRecoveryCode(): Promise<string> {
    if (!this.profile || !this.dek) throw new Error(MSG_LOCKED);
    const code = generateRecoveryCode();
    const { profileId, wrapped } = await this.wrapCurrentDek(normalizeRecoveryCode(code));
    await this.updateKeys(profileId, keys => {
      keys.recoveryCode = wrapped;
    });
    return code;
  }

  /**
   * Redefine a senha mestra usando código de recuperação, perguntas ou frase.
   * O código de recuperação é de uso único: após o uso, um novo código é gerado e devolvido.
   */
  async recover(
    profileId: string,
    method: 'code' | 'questions' | 'phrase',
    secret: string | string[],
    newPassword: string,
  ): Promise<{ newRecoveryCode: string | null }> {
    const err = MasterPasswordPolicy.error(newPassword);
    if (err) throw new Error(err);
    const keys = await this.getKeys(profileId);
    const dek = await this.attempt(profileId, async () => {
      if (method === 'code') return unwrapKey(normalizeRecoveryCode(String(secret)), keys.recoveryCode);
      if (method === 'questions' && keys.questions && Array.isArray(secret)) {
        return unwrapKey(secret.map(normalizeAnswer).join('|'), keys.questions);
      }
      if (method === 'phrase' && keys.phrase) return unwrapKey(normalizePhrase(String(secret)), keys.phrase);
      return null;
    });
    if (!dek) throw new Error('Dados de recuperação incorretos.');
    keys.master = await wrapKey(newPassword, dek);
    keys.passwordSetAt = new Date().toISOString();
    let newRecoveryCode: string | null = null;
    if (method === 'code') {
      newRecoveryCode = generateRecoveryCode();
      keys.recoveryCode = await wrapKey(normalizeRecoveryCode(newRecoveryCode), dek);
    }
    await this.saveKeys(profileId, keys);
    await Security.biometricRemove(`bio_${profileId}`);
    await this.updateSettingsFor(profileId, { biometricEnabled: false });
    await this.finishUnlock(profileId, dek, newRecoveryCode);
    return { newRecoveryCode };
  }

  async changeMasterPassword(current: string, next: string): Promise<void> {
    if (!this.profile || !this.dek) throw new Error(MSG_LOCKED);
    const err = MasterPasswordPolicy.error(next);
    if (err) throw new Error(err);
    const profileId = this.profile.id;
    const keys = await this.getKeys(profileId);
    const dek = await this.attempt(profileId, () => unwrapKey(current, keys.master));
    if (!dek) throw new Error('Senha atual incorreta.');
    const wrapped = await wrapKey(next, dek);
    await this.updateKeys(profileId, k2 => {
      k2.master = wrapped;
      k2.passwordSetAt = new Date().toISOString();
    });
  }

  async verifyCurrentPassword(pw: string): Promise<boolean> {
    if (!this.profile) return false;
    const profileId = this.profile.id;
    const keys = await this.getKeys(profileId);
    const dek = await this.attempt(profileId, () => unwrapKey(pw, keys.master));
    return !!dek;
  }

  // ---------------------------------------------------------------------------
  // Bloqueio
  // ---------------------------------------------------------------------------
  private beforeLockHooks: (() => Promise<void>)[] = [];

  /** Registra rotinas executadas antes do fechamento do banco (ex.: hash de integridade). */
  onBeforeLock(hook: () => Promise<void>) {
    this.beforeLockHooks.push(hook);
  }

  private afterCloseHooks: ((profileId: string) => Promise<void>)[] = [];

  /** Registra rotinas executadas depois que o banco foi fechado (ex.: hash do arquivo cifrado). */
  onAfterClose(hook: (profileId: string) => Promise<void>) {
    this.afterCloseHooks.push(hook);
  }

  /** Fecha o cofre: a DEK é apagada da memória e o banco é fechado. */
  lock(reason = 'manual'): Promise<void> {
    if (!this.dek) return Promise.resolve();
    const dek = this.dek;
    const profileId = vaultDb.profileId;
    this.dek = null; // a partir daqui isUnlocked = false
    bus.emit(Events.LOCKED, reason);
    return Promise.all(this.beforeLockHooks.map(h => h().catch(() => {}))).then(async () => {
      wipe(dek);
      if (this.dek) return; // desbloqueado novamente enquanto fechava
      vaultDb.close();
      if (profileId) {
        for (const h of this.afterCloseHooks) {
          if (this.dek) break;
          await h(profileId).catch(() => {});
        }
      }
    });
  }

  static fileName = VaultDatabase.fileName;
}

export const Vault = new VaultServiceImpl();
export const _test = { wrapKey, unwrapKey };
