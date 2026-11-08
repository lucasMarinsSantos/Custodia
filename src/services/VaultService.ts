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
//
// Perfis e recuperação:
//   • Perfis: lista `profiles`; cada perfil tem banco (custodia_<id>.sqlite), envelopes (p:<id>:keys),
//     biometria (bio_<id>), ajustes, bloqueio e 2FA próprios. O cofre único da versão 0.1 vira o primeiro perfil.
//   • Recuperação reforçada: recuperar troca a DEK e recifra o banco (PRAGMA rekey). Para que os segredos
//     de recuperação ainda válidos continuem valendo sem que o app os conheça, cada método (código, frase, perguntas)
//     envelopa a SUA chave raiz de recuperação (RK_m), e cada RK_m é ligada à DEK atual por dois envelopes AES-GCM:
//        segredo m ─PBKDF2→ RK_m ─dekByRk→ DEK        DEK ─rkByDek→ RK_m (para religar à DEK nova na troca)
//     Trocar um segredo (nova frase, novas perguntas, novo código) gera uma RK_m nova: o envelope antigo copiado,
//     mesmo com o segredo antigo, só libera uma RK que não está ligada a mais nada. Na recuperação, o método usado
//     também ganha RK nova, e a DEK antiga deixa de abrir o banco.
//     Nos cofres da versão 0.1 os segredos envelopam a própria DEK (sem `links`, RK_m = DEK). Na primeira troca esses
//     envelopes são descartados (manter um deles deixaria a DEK antiga valendo como chave para sempre): o método usado
//     é refeito com RK nova, um código de recuperação novo é gerado, e frase/perguntas antigas precisam ser refeitas.
//   • Verificação em duas etapas: TOTP exigido depois da senha mestra e na recuperação (ver seção 2FA).

import { aesDecrypt, aesEncrypt, deriveKey, equalBytes, fromB64, fromUtf8, PBKDF2_ITERATIONS, randomBytes, randomInt, safeEqual, sha256Hex, toB64, toHex, utf8, uuid, wipe } from '../crypto';
import { vaultDb, VaultDatabase } from '../db/Database';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { Security } from '../native';
import { AppSettings, DefaultSettings, Profile, ProfileType } from '../types/models';
import { WORDLIST } from '../data/wordlist';
import { commonPasswords } from './PasswordService';
import { AuthAttemptEvent, bus, Events } from './events';
import { TotpService } from './TotpService';

/** Avisa o histórico de acessos sobre cada tentativa de desbloqueio. */
function reportAttempt(profileId: string, method: AuthAttemptEvent['method'], success: boolean, detail?: string) {
  const ev: AuthAttemptEvent = { profileId, method, success, detail, at: new Date().toISOString() };
  bus.emit(Events.AUTH_ATTEMPT, ev);
}

interface Wrapped {
  salt: string;
  iter: number;
  wrapped: string;
}

export type RecoveryMethod = 'code' | 'questions' | 'phrase';
const RECOVERY_METHODS: RecoveryMethod[] = ['code', 'phrase', 'questions'];

/** Ligação entre a RK de um método de recuperação e a DEK atual (v2). */
interface RecoveryLink {
  /** RK_m cifrada pela DEK atual. */
  rkByDek: string;
  /** DEK atual cifrada pela RK_m. */
  dekByRk: string;
}

interface VaultKeys {
  version: 1 | 2;
  master: Wrapped;
  recoveryCode: Wrapped;
  questions?: Wrapped & { items: string[] };
  phrase?: Wrapped;
  /** v2: ligação de cada método com a DEK. Método sem ligação = cofre da versão 0.1 (o envelope guarda a DEK). */
  links?: Partial<Record<RecoveryMethod, RecoveryLink>>;
  /** 2FA: configuração TOTP cifrada com a DEK (AES-GCM). Ausente = 2FA desativado. */
  twoFactor?: string;
  hint?: string;
  createdAt: string;
  passwordSetAt: string;
  /** Última troca da DEK (recuperação). */
  dekRotatedAt?: string;
}

/** Diário da troca de DEK: gravado antes do PRAGMA rekey, apagado depois de gravar os envelopes novos. */
interface RekeyJournal {
  keys: VaultKeys;
  /** SHA-256 da DEK nova: diz, depois de uma queda, se o banco já está com a chave nova. */
  dekCheck: string;
  startedAt: string;
}

/** Configuração da verificação em duas etapas de um perfil (p:<id>:2fa). */
interface TwoFactorConfig {
  version: 1;
  /** Segredo TOTP em Base32. */
  secret: string;
  enabledAt: string;
  /** Contador TOTP do último código aceito (anti-replay). */
  lastCounter: number;
  /** Códigos de reserva de uso único, guardados só como hash (dentro do envelope cifrado pela DEK). */
  backupCodes: { salt: string; hash: string }[];
  /** A biometria dispensa o código (posse do aparelho + inerência). Padrão: sim. */
  allowBiometric: boolean;
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

// Perfis
const PROFILES_KEY = 'profiles';
/** Chave do cofre único da versão 0.1 (migrada para `profiles`). */
const LEGACY_PROFILE_KEY = 'profile';
const SELECTED_PROFILE_KEY = 'profileSelected';
export const MAX_PROFILES = 5;
export const PROFILE_NAME_MAX = 30;
export const PROFILE_COLORS = ['#0D9488', '#4F46E5', '#DB2777', '#D97706', '#0284C7', '#7C3AED'];
const MSG_PROFILE_NOT_FOUND = 'Perfil não encontrado';

// Verificação em duas etapas
/** Códigos de reserva de uso único gerados na ativação (e ao gerar novos). */
export const BACKUP_CODE_COUNT = 8;
/** A etapa do código vale por 3 minutos depois da senha; depois disso a senha é pedida de novo. */
export const SECOND_FACTOR_TTL_MS = 3 * 60 * 1000;
const BIO_PROOF_TTL_MS = 60 * 1000;
const MSG_2FA_INVALID = 'Código de verificação inválido.';
const MSG_2FA_REUSED = 'Este código já foi usado. Aguarde o próximo código no app autenticador.';
const MSG_2FA_REQUIRED = 'Informe o código de verificação em duas etapas (ou um código de reserva).';
const MSG_2FA_EXPIRED = 'A verificação expirou. Digite a senha mestra novamente.';
const MSG_WRONG_PASSWORD = 'Senha mestra incorreta.';

// Troca da DEK
const MSG_REKEY_FAILED = 'Não foi possível trocar a chave do cofre. Nada foi alterado: ele continua abrindo como antes.';
const MSG_REKEY_INTERRUPTED = 'Uma recuperação foi interrompida. Entre com a nova senha mestra definida nela.';

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

const aadRkByDek = (m: RecoveryMethod) => utf8(`custodia-rk-by-dek:${m}`);
const aadDekByRk = (m: RecoveryMethod) => utf8(`custodia-dek-by-rk:${m}`);

/** RK do método `m` a partir da DEK atual (cópia). Sem ligação (versão 0.1): RK = DEK. */
function rkFromDek(keys: VaultKeys, m: RecoveryMethod, dek: Uint8Array): Uint8Array {
  const link = keys.links?.[m];
  return link ? aesDecrypt(dek, fromB64(link.rkByDek), aadRkByDek(m)) : dek.slice();
}

/** DEK a partir da RK liberada por um segredo de recuperação (null se a ligação não confere). */
function dekFromRk(keys: VaultKeys, m: RecoveryMethod, rk: Uint8Array): Uint8Array | null {
  const link = keys.links?.[m];
  if (!link) return rk.slice();
  try {
    return aesDecrypt(rk, fromB64(link.dekByRk), aadDekByRk(m));
  } catch {
    return null;
  }
}

function linkKeys(m: RecoveryMethod, rk: Uint8Array, dek: Uint8Array): RecoveryLink {
  return { rkByDek: toB64(aesEncrypt(dek, rk, aadRkByDek(m))), dekByRk: toB64(aesEncrypt(rk, dek, aadDekByRk(m))) };
}

/** Segredo de recuperação normalizado, como é usado na derivação (null se a entrada não serve para o método). */
function recoverySecret(keys: VaultKeys, method: RecoveryMethod, secret: string | string[]): string | null {
  if (method === 'code' && typeof secret === 'string') return normalizeRecoveryCode(secret);
  if (method === 'questions' && keys.questions && Array.isArray(secret) && secret.length === keys.questions.items.length) {
    return secret.map(a => normalizeAnswer(String(a))).join('|');
  }
  if (method === 'phrase' && keys.phrase && typeof secret === 'string') return normalizePhrase(secret);
  return null;
}

function recoveryEnvelope(keys: VaultKeys, m: RecoveryMethod): Wrapped | undefined {
  if (m === 'code') return keys.recoveryCode;
  return m === 'phrase' ? keys.phrase : keys.questions;
}

/** Segredo de recuperação → RK. Entrada malformada conta como tentativa errada. */
function unwrapRecovery(keys: VaultKeys, method: RecoveryMethod, secret: string | string[]): Promise<Uint8Array | null> {
  const normalized = recoverySecret(keys, method, secret);
  const envelope = recoveryEnvelope(keys, method);
  // Limite de tamanho: a entrada vem do usuário e alimenta o PBKDF2
  if (!normalized || !envelope || normalized.length > 2048) return Promise.resolve(null);
  return unwrapKey(normalized, envelope);
}

const RECOVERY_LABEL = { code: 'código', phrase: 'frase', questions: 'perguntas' } as const;

// Códigos de reserva do 2FA: 10 caracteres do mesmo alfabeto do código de recuperação (50 bits), "XXXXX-XXXXX"
const BACKUP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateBackupCode(): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += BACKUP_ALPHABET[randomInt(BACKUP_ALPHABET.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

const hashBackupCode = (salt: string, code: string) => sha256Hex(`${salt}:${normalizeRecoveryCode(code)}`);

function newBackupCodes(): { codes: string[]; stored: TwoFactorConfig['backupCodes'] } {
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, generateBackupCode);
  const stored = codes.map(c => {
    const salt = toB64(randomBytes(16));
    return { salt, hash: hashBackupCode(salt, c) };
  });
  return { codes, stored };
}

const aad2fa = (profileId: string) => utf8(`custodia-2fa:${profileId}`);

function sealTwoFactor(profileId: string, dek: Uint8Array, cfg: TwoFactorConfig): string {
  return toB64(aesEncrypt(dek, utf8(JSON.stringify(cfg)), aad2fa(profileId)));
}

function openTwoFactor(profileId: string, dek: Uint8Array, sealed: string): TwoFactorConfig {
  let plain: Uint8Array;
  try {
    plain = aesDecrypt(dek, fromB64(sealed), aad2fa(profileId));
  } catch {
    throw new Error('A configuração da verificação em duas etapas não confere com a chave do cofre.');
  }
  const cfg = JSON.parse(fromUtf8(plain)) as TwoFactorConfig;
  wipe(plain);
  if (!TotpService.isValidSecret(cfg.secret) || !Array.isArray(cfg.backupCodes)) throw new Error('Configuração 2FA corrompida.');
  return cfg;
}

/** Método `m` ganha RK nova, envelopada por `secret` e ligada à DEK nova. */
async function freshRecoveryEnvelope(next: VaultKeys, m: RecoveryMethod, secret: string, newDek: Uint8Array) {
  const rk = randomBytes(32);
  try {
    const wrapped = await wrapKey(secret, rk);
    if (m === 'code') next.recoveryCode = wrapped;
    else if (m === 'phrase') next.phrase = wrapped;
    else next.questions = { ...wrapped, items: next.questions!.items };
    next.links![m] = linkKeys(m, rk, newDek);
  } finally {
    wipe(rk);
  }
}

/** Mantém a RK do método `m` e a religa à DEK nova. */
function relink(current: VaultKeys, m: RecoveryMethod, oldDek: Uint8Array, newDek: Uint8Array): RecoveryLink {
  const rk = rkFromDek(current, m, oldDek);
  try {
    return linkKeys(m, rk, newDek);
  } finally {
    wipe(rk);
  }
}

function dropRecoveryEnvelope(next: VaultKeys, m: RecoveryMethod): RecoveryMethod {
  if (m === 'phrase') delete next.phrase;
  if (m === 'questions') delete next.questions;
  return m;
}

/** Confere um código 2FA na configuração e atualiza o estado nela (contador ou reserva usada). */
function matchSecondFactor(cfg: TwoFactorConfig, input: string): 'totp' | 'backup' | null {
  const counter = TotpService.verify(cfg.secret, input, { afterCounter: cfg.lastCounter });
  if (counter !== null) {
    cfg.lastCounter = counter;
    return 'totp';
  }
  const normalized = normalizeRecoveryCode(input);
  if (normalized.length !== 10) return null;
  const i = cfg.backupCodes.findIndex(b => safeEqual(b.hash, hashBackupCode(b.salt, normalized)));
  if (i < 0) return null;
  cfg.backupCodes.splice(i, 1);
  return 'backup';
}

/** Valida e completa um perfil lido das preferências (dados externos ao código: podem estar corrompidos). */
function sanitizeProfile(p: any, index: number): Profile | null {
  if (!p || typeof p.id !== 'string' || !p.id) return null;
  return {
    id: p.id,
    name: String(p.name || 'Meu cofre').slice(0, PROFILE_NAME_MAX),
    type: p.type === 'professional' ? 'professional' : 'personal',
    color: typeof p.color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(p.color) ? p.color : PROFILE_COLORS[index % PROFILE_COLORS.length],
    createdAt: String(p.createdAt || new Date().toISOString()),
  };
}

function validateProfileName(name: string, others: Profile[]): string {
  const n = name.trim();
  if (!n) throw new Error('Informe o nome do perfil.');
  if (n.length > PROFILE_NAME_MAX) throw new Error(`O nome do perfil pode ter até ${PROFILE_NAME_MAX} caracteres.`);
  if (others.some(o => o.name.trim().toLowerCase() === n.toLowerCase())) throw new Error('Já existe um perfil com esse nome.');
  return n;
}

class VaultServiceImpl {
  private dek: Uint8Array | null = null;
  private profile: Profile | null = null;
  settings: AppSettings = { ...DefaultSettings };

  // ---------------------------------------------------------------------------
  // Perfis: cada perfil é um cofre independente
  // ---------------------------------------------------------------------------
  /** Lista de perfis. Na primeira leitura migra o cofre da versão 0.1 (chave `profile`) para o primeiro perfil. */
  async listProfiles(): Promise<Profile[]> {
    const raw = await Security.secureGet(PROFILES_KEY);
    if (raw) {
      let list: unknown;
      try {
        list = JSON.parse(raw);
      } catch {
        throw new Error('A lista de perfis está corrompida.');
      }
      return (Array.isArray(list) ? list : []).map(sanitizeProfile).filter((p): p is Profile => !!p);
    }
    const legacy = await Security.secureGet(LEGACY_PROFILE_KEY);
    if (!legacy) return [];
    const migrated = sanitizeProfile({ type: 'personal', ...JSON.parse(legacy) }, 0);
    if (!migrated) return [];
    // Grava a lista antes de remover a chave antiga: se o app cair no meio, a migração só se repete
    await Security.secureSet(PROFILES_KEY, JSON.stringify([migrated]));
    await Security.secureRemove(LEGACY_PROFILE_KEY);
    return [migrated];
  }

  private async saveProfiles(list: Profile[]) {
    await Security.secureSet(PROFILES_KEY, JSON.stringify(list));
    bus.emit(Events.PROFILES_CHANGED);
  }

  async getProfileById(id: string): Promise<Profile | null> {
    return (await this.listProfiles()).find(p => p.id === id) ?? null;
  }

  /** Perfil escolhido na tela de login (o último aberto); o primeiro da lista se nenhum foi escolhido. */
  async getProfile(): Promise<Profile | null> {
    const list = await this.listProfiles();
    const selected = await Security.secureGet(SELECTED_PROFILE_KEY);
    return list.find(p => p.id === selected) ?? list[0] ?? null;
  }

  /** Escolhe o perfil mostrado na tela de login. Só com o cofre bloqueado (use switchProfile com ele aberto). */
  async selectProfile(id: string): Promise<void> {
    if (!(await this.getProfileById(id))) throw new Error(MSG_PROFILE_NOT_FOUND);
    this.cancelSecondFactor();
    await Security.secureSet(SELECTED_PROFILE_KEY, id);
    bus.emit(Events.PROFILES_CHANGED);
  }

  /** Alterna de perfil: bloqueia o atual (apaga a DEK da memória) e deixa o outro selecionado no login. */
  async switchProfile(id: string): Promise<void> {
    if (!(await this.getProfileById(id))) throw new Error(MSG_PROFILE_NOT_FOUND);
    await this.lock('troca de perfil');
    await this.selectProfile(id);
  }

  async renameProfile(id: string, patch: { name?: string; type?: ProfileType; color?: string }): Promise<Profile> {
    const list = await this.listProfiles();
    const i = list.findIndex(p => p.id === id);
    if (i < 0) throw new Error(MSG_PROFILE_NOT_FOUND);
    const name = patch.name === undefined ? list[i].name : validateProfileName(patch.name, list.filter(p => p.id !== id));
    const updated = sanitizeProfile({ ...list[i], ...patch, name }, i)!;
    list[i] = updated;
    await this.saveProfiles(list);
    if (this.profile?.id === id) this.profile = updated;
    return updated;
  }

  /**
   * Exclui um perfil com confirmação forte: senha mestra do perfil (e o código 2FA, se ativo). Conta as falhas no
   * bloqueio do próprio perfil. O banco é apagado com secure_delete e os envelopes, a biometria e os ajustes saem do
   * Keystore; sem os envelopes a DEK deixa de existir (apagamento criptográfico), mesmo que sobre algum resto do arquivo.
   */
  async deleteProfile(id: string, password: string, secondFactor?: string): Promise<void> {
    const list = await this.listProfiles();
    if (!list.some(p => p.id === id)) throw new Error(MSG_PROFILE_NOT_FOUND);
    if (list.length <= 1) throw new Error('Não é possível excluir o único perfil.');
    const twoFactor = await this.isTwoFactorEnabled(id);
    if (twoFactor && !secondFactor?.trim()) throw new Error(MSG_2FA_REQUIRED);
    const dek = await this.verifyPassword(id, password);
    try {
      if (twoFactor) await this.checkSecondFactor(id, dek, secondFactor!);
      if (this.profile?.id === id || vaultDb.profileId === id) await this.lock('perfil excluído');
      // 1) some da lista (não pode mais ser aberto); 2) apaga o banco; 3) apaga as chaves
      const rest = list.filter(p => p.id !== id);
      await this.saveProfiles(rest);
      if ((await Security.secureGet(SELECTED_PROFILE_KEY)) === id) await Security.secureSet(SELECTED_PROFILE_KEY, rest[0].id);
      // Mesmo se a sobrescrita falhar, apagar as chaves torna o arquivo ilegível (a falha fica registrada)
      await VaultDatabase.destroy(id, toHex(dek)).catch(e => console.warn('[Vault] exclusão segura do banco falhou', e));
      for (const key of await Security.secureKeys(`p:${id}:`)) await Security.secureRemove(key);
      await Security.biometricRemove(`bio_${id}`);
      bus.emit(Events.PROFILES_CHANGED);
    } finally {
      wipe(dek);
    }
  }

  get currentProfile(): Profile | null {
    return this.profile;
  }

  get isUnlocked(): boolean {
    return this.dek !== null && vaultDb.isOpen;
  }

  async hasVault(): Promise<boolean> {
    return (await this.listProfiles()).length > 0;
  }

  /** Cria o primeiro cofre do aparelho. */
  async createVault(opts: { name?: string; type?: ProfileType; masterPassword: string; hint?: string }): Promise<{ profile: Profile; recoveryCode: string }> {
    if (await this.hasVault()) throw new Error('Já existe um cofre neste aparelho.');
    return this.createProfileVault(opts);
  }

  /** "Novo perfil": outro cofre, com outro banco e outra senha mestra. */
  async createProfile(opts: { name: string; type?: ProfileType; masterPassword: string; hint?: string }): Promise<{ profile: Profile; recoveryCode: string }> {
    const list = await this.listProfiles();
    if (list.length >= MAX_PROFILES) throw new Error(`Use no máximo ${MAX_PROFILES} perfis.`);
    validateProfileName(opts.name, list);
    return this.createProfileVault(opts);
  }

  private async createProfileVault(opts: { name?: string; type?: ProfileType; masterPassword: string; hint?: string }): Promise<{ profile: Profile; recoveryCode: string }> {
    const err = MasterPasswordPolicy.error(opts.masterPassword);
    if (err) throw new Error(err);
    if (opts.hint && opts.hint.toLowerCase().includes(opts.masterPassword.toLowerCase())) {
      throw new Error('A dica não pode conter a senha.');
    }
    const list = await this.listProfiles();
    const profile: Profile = {
      id: uuid(),
      name: validateProfileName(opts.name?.trim() || 'Meu cofre', list),
      type: opts.type === 'professional' ? 'professional' : 'personal',
      color: PROFILE_COLORS[list.length % PROFILE_COLORS.length],
      createdAt: new Date().toISOString(),
    };
    const dek = randomBytes(32);
    // Chave raiz de recuperação própria do código: capturar a DEK não revela a RK
    const rk = randomBytes(32);
    const recoveryCode = generateRecoveryCode();
    const keys: VaultKeys = {
      version: 2,
      master: await wrapKey(opts.masterPassword, dek),
      recoveryCode: await wrapKey(normalizeRecoveryCode(recoveryCode), rk),
      links: { code: linkKeys('code', rk, dek) },
      hint: opts.hint?.trim() || undefined,
      createdAt: new Date().toISOString(),
      passwordSetAt: new Date().toISOString(),
    };
    wipe(rk);
    // Outro perfil aberto: fecha antes (a DEK dele sai da memória)
    if (this.dek) await this.lock('novo perfil');
    await Security.secureSet(k(profile.id, 'keys'), JSON.stringify(keys));
    await Security.secureSet(k(profile.id, 'settings'), JSON.stringify(DefaultSettings));
    await this.saveProfiles([...list, profile]);
    await Security.secureSet(SELECTED_PROFILE_KEY, profile.id);

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

  private async getRekeyJournal(profileId: string): Promise<RekeyJournal | null> {
    const raw = await Security.secureGet(k(profileId, 'rekey'));
    return raw ? JSON.parse(raw) : null;
  }

  /**
   * Fecha uma troca de DEK interrompida, sabendo qual DEK abriu o banco: se foi a nova, o PRAGMA rekey chegou a
   * terminar e os envelopes do diário passam a valer; se foi a antiga, a troca não aconteceu e o diário é descartado.
   */
  private async settleRekeyJournal(profileId: string, openedWith: Uint8Array) {
    const journal = await this.getRekeyJournal(profileId);
    if (!journal) return;
    if (safeEqual(journal.dekCheck, sha256Hex(openedWith))) {
      await this.saveKeys(profileId, journal.keys);
      await Security.biometricRemove(`bio_${profileId}`);
      await this.updateSettingsFor(profileId, { biometricEnabled: false });
    }
    await Security.secureRemove(k(profileId, 'rekey'));
  }

  /** Abre o banco do perfil. Se ele não abre e há uma troca de DEK pendente, explica o que fazer. */
  private async openVault(profileId: string, dek: Uint8Array) {
    try {
      await vaultDb.open(profileId, toHex(dek));
    } catch (e) {
      if (await this.getRekeyJournal(profileId)) throw new Error(MSG_REKEY_INTERRUPTED);
      throw e;
    }
    await this.settleRekeyJournal(profileId, dek);
  }

  /** Senha mestra → DEK, pelos envelopes gravados ou, numa troca interrompida, pelos do diário. */
  private async unwrapMaster(profileId: string, password: string): Promise<Uint8Array | null> {
    const dek = await unwrapKey(password, (await this.getKeys(profileId)).master);
    if (dek) return dek;
    const journal = await this.getRekeyJournal(profileId);
    return journal ? unwrapKey(password, journal.keys.master) : null;
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
    const profile = await this.getProfileById(profileId);
    if (!profile) throw new Error('Cofre não encontrado');
    // Outro perfil aberto: a DEK dele sai da memória antes de abrir este
    if (this.dek && this.profile?.id !== profileId) await this.lock('troca de perfil');
    await this.openVault(profileId, dek);
    await Security.secureSet(SELECTED_PROFILE_KEY, profileId);
    this.pendingSecondFactor = null;
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
    let dek: Uint8Array | null;
    try {
      dek = await this.attempt(profileId, () => this.unwrapMaster(profileId, password));
    } catch (e: any) {
      reportAttempt(profileId, 'password', false, String(e?.message || e));
      throw e;
    }
    reportAttempt(profileId, 'password', !!dek, dek ? undefined : 'Senha mestra incorreta');
    if (!dek) throw new Error(MSG_WRONG_PASSWORD);
    return dek;
  }

  async verifyBiometric(profileId: string): Promise<Uint8Array> {
    if (await this.biometricLockedUntil(profileId)) {
      throw new Error(MSG_BIO_LOCKED);
    }
    try {
      const b64 = await Security.biometricUnlock(`bio_${profileId}`, 'Desbloquear Custódia', 'Use sua digital ou reconhecimento facial');
      await Security.secureRemove(k(profileId, 'bioFailures'));
      reportAttempt(profileId, 'biometric', true);
      // Prova de que a DEK veio do BiometricPrompt: só ela dispensa o código 2FA em completeUnlock
      this.bioProof = { profileId, at: Date.now() };
      return fromB64(b64);
    } catch (e: any) {
      const err = await this.biometricError(profileId, e);
      // Cancelar o prompt não é uma tentativa de acesso
      if (!/cancelada/.test(err.message)) reportAttempt(profileId, 'biometric', false, err.message);
      throw err;
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

  /**
   * Conclui o desbloqueio com a DEK já verificada.
   * Com a verificação em duas etapas ativa, a senha mestra não basta: a DEK fica retida aqui (fora da interface) e
   * o cofre só abre depois de `verifySecondFactor`. A biometria pode dispensar o código (configurável, ver 2FA).
   * @returns 'unlocked' ou 'second_factor' (falta o código 2FA)
   */
  async completeUnlock(profileId: string, dek: Uint8Array, method: UnlockMethod = 'password'): Promise<'unlocked' | 'second_factor'> {
    const bio = method === 'biometric' && this.consumeBiometricProof(profileId);
    const sealed = (await this.getKeys(profileId)).twoFactor;
    if (sealed && !(bio && openTwoFactor(profileId, dek, sealed).allowBiometric)) {
      this.cancelSecondFactor();
      this.pendingSecondFactor = { profileId, dek, expiresAt: Date.now() + SECOND_FACTOR_TTL_MS };
      return 'second_factor';
    }
    await this.finishUnlock(profileId, dek);
    return 'unlocked';
  }

  private bioProof: { profileId: string; at: number } | null = null;

  private consumeBiometricProof(profileId: string): boolean {
    const p = this.bioProof;
    this.bioProof = null;
    return !!p && p.profileId === profileId && Date.now() - p.at >= 0 && Date.now() - p.at < BIO_PROOF_TTL_MS;
  }

  // ---------------------------------------------------------------------------
  // Verificação em duas etapas
  //
  // Desenho: o 2FA é pedido DEPOIS da senha e ANTES de abrir o banco. Por isso a configuração (segredo TOTP,
  // contador do último código aceito e hashes dos códigos de reserva) não pode ficar no banco; ela fica em
  // `keys.twoFactor`, cifrada com a DEK (AES-GCM, AAD com o id do perfil), dentro das preferências cifradas pelo
  // Keystore. Assim o segredo só é legível depois da senha mestra (ou da biometria, ou de um segredo de
  // recuperação, que liberam a DEK), e uma cópia das preferências sem a senha não revela o segredo TOTP.
  // A DEK liberada pela senha fica retida em `pendingSecondFactor` por no máximo 3 minutos; a interface nunca a vê.
  // Cada código errado conta no mesmo bloqueio temporário da senha (5 falhas → 30 s, dobrando). Um código só vale
  // uma vez (anti-replay pelo contador TOTP) e os códigos de reserva são apagados ao serem usados.
  // Biometria: por padrão dispensa o código (a chave biométrica do Keystore já é posse do aparelho + inerência);
  // o usuário pode exigir o código também na biometria (`allowBiometric = false`).
  // ---------------------------------------------------------------------------
  private pendingSecondFactor: { profileId: string; dek: Uint8Array; expiresAt: number } | null = null;
  private twoFactorSetup: { profileId: string; secret: string } | null = null;

  async isTwoFactorEnabled(profileId: string): Promise<boolean> {
    return !!(await this.getKeys(profileId)).twoFactor;
  }

  /** Perfil aguardando o código 2FA (a senha já foi aceita), ou null. */
  get pendingSecondFactorProfile(): string | null {
    const p = this.pendingSecondFactor;
    return p && p.expiresAt > Date.now() ? p.profileId : null;
  }

  /** Descarta a etapa pendente (voltar, trocar de perfil): a DEK retida é apagada. */
  cancelSecondFactor() {
    if (this.pendingSecondFactor) wipe(this.pendingSecondFactor.dek);
    this.pendingSecondFactor = null;
  }

  /** Segunda etapa do login: código TOTP de 6 dígitos ou código de reserva. */
  async verifySecondFactor(code: string): Promise<void> {
    const p = this.pendingSecondFactor;
    if (!p || p.expiresAt <= Date.now()) {
      this.cancelSecondFactor();
      throw new Error(MSG_2FA_EXPIRED);
    }
    try {
      await this.checkSecondFactor(p.profileId, p.dek, code);
    } catch (e) {
      // Bloqueio temporário atingido: a senha volta a ser exigida depois dele
      if ((await this.getLockout(p.profileId)).lockedUntil > Date.now()) this.cancelSecondFactor();
      throw e;
    }
    if (this.pendingSecondFactor !== p) throw new Error(MSG_2FA_EXPIRED);
    await this.finishUnlock(p.profileId, p.dek);
  }

  /**
   * Confere um código (TOTP ou reserva) com a DEK do perfil e grava o novo estado (contador / reserva usada).
   * Conta no bloqueio temporário e registra a tentativa no histórico (método 'totp').
   */
  private async checkSecondFactor(profileId: string, dek: Uint8Array, code: string): Promise<'totp' | 'backup'> {
    const input = String(code ?? '').slice(0, 64);
    let detail = MSG_2FA_INVALID;
    let used: 'totp' | 'backup' | null;
    try {
      used = await this.attempt(profileId, async () => {
        const keys = await this.getKeys(profileId);
        if (!keys.twoFactor) throw new Error('A verificação em duas etapas não está ativa.');
        const cfg = openTwoFactor(profileId, dek, keys.twoFactor);
        const kind = matchSecondFactor(cfg, input);
        if (!kind) {
          if (TotpService.verify(cfg.secret, input) !== null) detail = MSG_2FA_REUSED;
          return null;
        }
        const sealed = sealTwoFactor(profileId, dek, cfg);
        await this.updateKeys(profileId, k2 => {
          k2.twoFactor = sealed;
        });
        return kind;
      });
    } catch (e: any) {
      reportAttempt(profileId, 'totp', false, String(e?.message || e));
      throw e;
    }
    reportAttempt(profileId, 'totp', !!used, used === 'backup' ? 'Código de reserva' : used ? undefined : detail);
    if (!used) throw new Error(detail);
    return used;
  }

  /** Confere a senha mestra do perfil aberto (conta no bloqueio). */
  private async reauth(password: string): Promise<void> {
    if (!(await this.verifyCurrentPassword(password))) throw new Error(MSG_WRONG_PASSWORD);
  }

  private requireOpen(): { profileId: string; dek: Uint8Array } {
    if (!this.profile || !this.dek) throw new Error(MSG_LOCKED);
    return { profileId: this.profile.id, dek: this.dek };
  }

  async getTwoFactorStatus(): Promise<{ enabled: boolean; enabledAt?: string; backupCodesLeft: number; allowBiometric: boolean }> {
    const { profileId, dek } = this.requireOpen();
    const sealed = (await this.getKeys(profileId)).twoFactor;
    if (!sealed) return { enabled: false, backupCodesLeft: 0, allowBiometric: true };
    const cfg = openTwoFactor(profileId, dek, sealed);
    return { enabled: true, enabledAt: cfg.enabledAt, backupCodesLeft: cfg.backupCodes.length, allowBiometric: cfg.allowBiometric };
  }

  /** Passo 1 da ativação: segredo novo de 160 bits (só em memória até a confirmação) e a URI do QR Code. */
  async beginTwoFactorSetup(): Promise<{ secret: string; uri: string }> {
    const { profileId } = this.requireOpen();
    if (await this.isTwoFactorEnabled(profileId)) throw new Error('A verificação em duas etapas já está ativa.');
    const secret = TotpService.generateSecret();
    this.twoFactorSetup = { profileId, secret };
    return { secret, uri: TotpService.buildUri(secret, this.profile!.name) };
  }

  /** Passo 2: confirma com a senha mestra e com um código do app autenticador. Devolve os códigos de reserva. */
  async confirmTwoFactorSetup(password: string, code: string): Promise<string[]> {
    const { profileId } = this.requireOpen();
    const setup = this.twoFactorSetup;
    if (!setup || setup.profileId !== profileId) throw new Error('Comece a ativação de novo.');
    await this.reauth(password);
    const ok = await this.attempt(profileId, async () => {
      const c = TotpService.verify(setup.secret, String(code ?? '').slice(0, 64));
      return c === null ? null : { counter: c };
    });
    reportAttempt(profileId, 'totp', !!ok, ok ? 'Ativação da verificação em duas etapas' : MSG_2FA_INVALID);
    if (!ok) throw new Error(`${MSG_2FA_INVALID} Confira se o relógio do aparelho está certo.`);
    const { dek } = this.requireOpen();
    const { codes, stored } = newBackupCodes();
    const cfg: TwoFactorConfig = { version: 1, secret: setup.secret, enabledAt: new Date().toISOString(), lastCounter: ok.counter, backupCodes: stored, allowBiometric: true };
    const sealed = sealTwoFactor(profileId, dek, cfg);
    await this.updateKeys(profileId, keys => {
      keys.twoFactor = sealed;
    });
    this.twoFactorSetup = null;
    return codes;
  }

  cancelTwoFactorSetup() {
    this.twoFactorSetup = null;
  }

  /** Desativa: exige a senha mestra e um código (TOTP ou reserva). */
  async disableTwoFactor(password: string, code: string): Promise<void> {
    const { profileId, dek } = this.requireOpen();
    await this.reauth(password);
    await this.checkSecondFactor(profileId, dek, code);
    await this.updateKeys(profileId, keys => {
      delete keys.twoFactor;
    });
  }

  /** Gera novos códigos de reserva (os anteriores deixam de valer). */
  async regenerateBackupCodes(password: string, code: string): Promise<string[]> {
    const { profileId, dek } = this.requireOpen();
    await this.reauth(password);
    await this.checkSecondFactor(profileId, dek, code);
    const { codes, stored } = newBackupCodes();
    await this.changeTwoFactor(profileId, dek, cfg => {
      cfg.backupCodes = stored;
    });
    return codes;
  }

  /** Biometria dispensa o código? (, configurável nos Ajustes). */
  async setTwoFactorBiometric(allow: boolean): Promise<void> {
    const { profileId, dek } = this.requireOpen();
    await this.changeTwoFactor(profileId, dek, cfg => {
      cfg.allowBiometric = !!allow;
    });
  }

  private async changeTwoFactor(profileId: string, dek: Uint8Array, change: (cfg: TwoFactorConfig) => void) {
    const copy = dek.slice();
    try {
      await this.updateKeys(profileId, keys => {
        if (!keys.twoFactor) throw new Error('A verificação em duas etapas não está ativa.');
        const cfg = openTwoFactor(profileId, copy, keys.twoFactor);
        change(cfg);
        keys.twoFactor = sealTwoFactor(profileId, copy, cfg);
      });
    } finally {
      wipe(copy);
    }
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
   * Envelopa uma RK NOVA com um segredo de recuperação e a liga à DEK atual. Usa uma CÓPIA da DEK: se o cofre
   * bloquear durante a derivação (app minimizado, sensor), o lock() zera a DEK original, e ligar a original
   * gravaria uma chave de zeros. RK nova a cada segredo novo: o envelope do segredo substituído não abre mais nada.
   */
  private async wrapRecoveryRoot(method: RecoveryMethod, secret: string) {
    const { profileId, dek: current } = this.requireOpen();
    const dek = current.slice();
    const rk = randomBytes(32);
    try {
      const wrapped = await wrapKey(secret, rk);
      if (!this.dek || this.profile?.id !== profileId) throw new Error(MSG_LOCKED);
      return { profileId, wrapped, link: linkKeys(method, rk, dek) };
    } finally {
      wipe(rk);
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
    const { profileId, wrapped, link } = await this.wrapRecoveryRoot('questions', secret);
    const questions = { ...wrapped, items: items.map(i => i.question.trim()) };
    await this.updateKeys(profileId, keys => {
      keys.questions = questions;
      keys.links = { ...keys.links, questions: link };
    });
  }

  async setRecoveryPhrase(): Promise<string> {
    if (!this.profile || !this.dek) throw new Error(MSG_LOCKED);
    const phrase = generatePhrase(12);
    const { profileId, wrapped, link } = await this.wrapRecoveryRoot('phrase', normalizePhrase(phrase));
    await this.updateKeys(profileId, keys => {
      keys.phrase = wrapped;
      keys.links = { ...keys.links, phrase: link };
    });
    return phrase;
  }

  async regenerateRecoveryCode(): Promise<string> {
    if (!this.profile || !this.dek) throw new Error(MSG_LOCKED);
    const code = generateRecoveryCode();
    const { profileId, wrapped, link } = await this.wrapRecoveryRoot('code', normalizeRecoveryCode(code));
    await this.updateKeys(profileId, keys => {
      keys.recoveryCode = wrapped;
      keys.links = { ...keys.links, code: link };
    });
    return code;
  }

  /**
   * Redefine a senha mestra usando código de recuperação, perguntas ou frase (/1.18, reforçada na).
   *  • Com o 2FA ativo, exige também o código TOTP ou um código de reserva, verificado ANTES de qualquer mudança
   *    (quem só tem a frase não consegue trocar a senha do dono).
   *  • Gera uma DEK nova e recifra o banco (PRAGMA rekey): envelopes antigos copiados, a biometria e a DEK antiga
   *    deixam de abrir o cofre. Os segredos ainda válidos dos outros métodos continuam valendo (a RK deles é
   *    religada à DEK nova); o método usado ganha RK nova.
   *  • O código de recuperação é de uso único: após o uso, um novo código é gerado e devolvido (também quando o código
   *    era da versão 0.1 e precisou ser descartado).
   * @returns o código novo (ou null) e os métodos descartados (cofres da versão 0.1), que precisam ser refeitos
   */
  async recover(
    profileId: string,
    method: RecoveryMethod,
    secret: string | string[],
    newPassword: string,
    secondFactor?: string,
  ): Promise<{ newRecoveryCode: string | null; dropped: RecoveryMethod[] }> {
    if (!RECOVERY_METHODS.includes(method)) throw new Error('Método de recuperação inválido.');
    const err = MasterPasswordPolicy.error(newPassword);
    if (err) throw new Error(err);
    if ((await this.isTwoFactorEnabled(profileId)) && !secondFactor?.trim()) throw new Error(MSG_2FA_REQUIRED);
    const keys = await this.getKeys(profileId);
    const journal = await this.getRekeyJournal(profileId);
    const rk = await this.attempt(profileId, async () => {
      const fromKeys = await unwrapRecovery(keys, method, secret);
      return fromKeys ?? (journal ? unwrapRecovery(journal.keys, method, secret) : null);
    });
    reportAttempt(profileId, 'recovery', !!rk, rk ? `Recuperação por ${RECOVERY_LABEL[method]}` : 'Dados de recuperação incorretos');
    if (!rk) throw new Error('Dados de recuperação incorretos.');
    let oldDek: Uint8Array | null = null;
    try {
      const candidates = [dekFromRk(keys, method, rk), journal ? dekFromRk(journal.keys, method, rk) : null];
      oldDek = await this.openWithAny(profileId, candidates);
      await this.settleRekeyJournal(profileId, oldDek);
      if (await this.isTwoFactorEnabled(profileId)) await this.checkSecondFactor(profileId, oldDek, secondFactor!);
      const rewrap = method === 'code' ? null : recoverySecret(keys, method, secret);
      const result = await this.rotateDek(profileId, oldDek, method, rewrap, newPassword);
      await this.finishUnlock(profileId, result.dek, result.newRecoveryCode);
      return { newRecoveryCode: result.newRecoveryCode, dropped: result.dropped };
    } catch (e) {
      // O banco foi aberto só para a troca: com o cofre ainda bloqueado ele não pode ficar aberto
      if (!this.dek && vaultDb.profileId === profileId) vaultDb.close();
      throw e;
    } finally {
      wipe(rk);
      wipe(oldDek);
    }
  }

  // ---------------------------------------------------------------------------
  // Troca da DEK
  // ---------------------------------------------------------------------------
  private rekeyHooks: ((profileId: string, oldDek: Uint8Array, newDek: Uint8Array) => Promise<void>)[] = [];

  /**
   * Registra quem guarda segredos cifrados pela DEK fora do banco (ex.: chave de sincronização ou de backup) para
   * reenvelopá-los na troca. Os ganchos rodam antes de a troca ser confirmada; se um falhar, o banco volta para a
   * DEK antiga e a recuperação é cancelada. Devem ser idempotentes.
   */
  onRekey(hook: (profileId: string, oldDek: Uint8Array, newDek: Uint8Array) => Promise<void>) {
    this.rekeyHooks.push(hook);
  }

  /** Abre o banco com a primeira DEK candidata que funcionar e devolve essa DEK (as outras são apagadas). */
  private async openWithAny(profileId: string, candidates: (Uint8Array | null)[]): Promise<Uint8Array> {
    let found: Uint8Array | null = null;
    for (const dek of candidates) {
      if (!dek || found) {
        wipe(dek);
        continue;
      }
      try {
        await vaultDb.open(profileId, toHex(dek));
        found = dek;
      } catch {
        wipe(dek);
      }
    }
    if (!found) throw new Error('Não foi possível abrir o banco do cofre com a chave recuperada.');
    return found;
  }

  /**
   * Monta os envelopes da DEK nova (lento: PBKDF2), sem gravar nada.
   *  • método usado: RK nova envelopada pelo mesmo segredo (código: um código novo);
   *  • outros métodos com ligação: a RK deles é religada à DEK nova;
   *  • métodos sem ligação (versão 0.1, RK = DEK antiga): descartados; o código, nesse caso, é refeito.
   */
  private async buildRotatedKeys(profileId: string, oldDek: Uint8Array, newDek: Uint8Array, used: RecoveryMethod, rewrap: string | null, newPassword: string) {
    const current = await this.getKeys(profileId);
    const next: VaultKeys = { ...current, version: 2, master: await wrapKey(newPassword, newDek), links: {} };
    const dropped: RecoveryMethod[] = [];
    const newRecoveryCode = used === 'code' || !current.links?.code ? generateRecoveryCode() : null;
    const freshSecret = (m: RecoveryMethod) => {
      if (m === 'code') return newRecoveryCode ? normalizeRecoveryCode(newRecoveryCode) : null;
      return m === used ? rewrap : null;
    };
    for (const m of RECOVERY_METHODS.filter(x => recoveryEnvelope(current, x))) {
      const fresh = freshSecret(m);
      if (fresh) await freshRecoveryEnvelope(next, m, fresh, newDek);
      else if (current.links?.[m]) next.links![m] = relink(current, m, oldDek, newDek);
      else dropped.push(dropRecoveryEnvelope(next, m));
    }
    if (current.twoFactor) next.twoFactor = sealTwoFactor(profileId, newDek, openTwoFactor(profileId, oldDek, current.twoFactor));
    return { next, newRecoveryCode, dropped };
  }

  /**
   * Gera uma DEK nova, recifra o banco e grava os envelopes novos, de forma segura contra quedas:
   *   1. deriva os envelopes novos (lento) sem tocar em nada;
   *   2. grava o diário (envelopes novos + hash da DEK nova);
   *   3. PRAGMA rekey (atômico no SQLCipher). Se falhar: diário apagado, nada mudou;
   *   4. reabre com a DEK nova para confirmar e roda os ganchos onRekey (falha → volta para a DEK antiga);
   *   5. grava os envelopes novos (ponto de confirmação) e apaga o diário; remove a biometria (tinha a DEK antiga).
   * Uma queda entre 3 e 5 é resolvida no próximo desbloqueio pelo diário (settleRekeyJournal).
   */
  private async rotateDek(profileId: string, oldDek: Uint8Array, used: RecoveryMethod, rewrap: string | null, newPassword: string) {
    const newDek = randomBytes(32);
    const now = new Date().toISOString();
    const built = await this.buildRotatedKeys(profileId, oldDek, newDek, used, rewrap, newPassword);
    const next: VaultKeys = { ...built.next, passwordSetAt: now, dekRotatedAt: now };
    const journal: RekeyJournal = { keys: next, dekCheck: sha256Hex(newDek), startedAt: now };
    await Security.secureSet(k(profileId, 'rekey'), JSON.stringify(journal));
    await this.applyRekey(profileId, oldDek, newDek);
    await this.saveKeys(profileId, next);
    await Security.secureRemove(k(profileId, 'rekey'));
    await Security.biometricRemove(`bio_${profileId}`);
    await this.updateSettingsFor(profileId, { biometricEnabled: false });
    return { dek: newDek, newRecoveryCode: built.newRecoveryCode, dropped: built.dropped };
  }

  /** Passos 3 e 4 da troca. Em qualquer falha o banco termina com a DEK antiga e o diário é apagado. */
  private async applyRekey(profileId: string, oldDek: Uint8Array, newDek: Uint8Array) {
    const abort = async (rollback: boolean) => {
      if (rollback) await vaultDb.rekey(toHex(oldDek)).catch(e => console.warn('[Vault] rekey de volta falhou', e));
      vaultDb.close();
      await Security.secureRemove(k(profileId, 'rekey'));
      wipe(newDek);
      return new Error(MSG_REKEY_FAILED);
    };
    try {
      await vaultDb.rekey(toHex(newDek));
    } catch (e) {
      console.warn('[Vault] PRAGMA rekey falhou', e);
      throw await abort(false);
    }
    try {
      vaultDb.close();
      await vaultDb.open(profileId, toHex(newDek));
      for (const hook of this.rekeyHooks) await hook(profileId, oldDek, newDek);
    } catch (e) {
      console.warn('[Vault] confirmação da troca de chave falhou', e);
      if (!vaultDb.isOpen) await vaultDb.open(profileId, toHex(newDek)).catch(() => vaultDb.open(profileId, toHex(oldDek)));
      throw await abort(true);
    }
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
    wipe(dek);
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
    wipe(dek);
    return !!dek;
  }

  /**
   * Reautenticação com o cofre aberto (regra "reautenticar para ver/copiar" das pastas): senha mestra ou
   * biometria. A DEK devolvida pela biometria precisa ser a do cofre aberto; ela é apagada logo em seguida e a prova
   * biométrica não fica valendo para o login.
   */
  async reauthenticate(method: 'password' | 'biometric', password = ''): Promise<boolean> {
    const { profileId, dek } = this.requireOpen();
    if (method === 'password') return this.verifyCurrentPassword(password);
    const got = await this.verifyBiometric(profileId);
    this.bioProof = null;
    try {
      return equalBytes(got, dek);
    } finally {
      wipe(got);
    }
  }

  // ---------------------------------------------------------------------------
  // Backup cifrado: a DEK nunca sai do serviço
  // ---------------------------------------------------------------------------
  /** Chave derivada da DEK por HKDF-SHA256 (ex.: chave de um arquivo de backup). */
  deriveSubkey(salt: Uint8Array, info: string, len = 32): Uint8Array {
    if (!this.dek) throw new Error(MSG_LOCKED);
    return hkdf(sha256, this.dek, salt, utf8(info), len);
  }

  /**
   * Cópia dos envelopes que vão dentro do arquivo de backup: a DEK pela senha mestra e o código de recuperação.
   * Desde a o código libera uma chave de recuperação (RK) ligada à DEK; nesse caso vai junto a ligação
   * `recoveryLink` (DEK cifrada pela RK), sem a qual o código não abriria o backup em outro aparelho.
   */
  async backupEnvelopes(): Promise<{ master: Wrapped; recoveryCode: Wrapped; recoveryLink?: string }> {
    if (!this.profile || !this.dek) throw new Error(MSG_LOCKED);
    const keys = await this.getKeys(this.profile.id);
    const link = keys.links?.code;
    return { master: { ...keys.master }, recoveryCode: { ...keys.recoveryCode }, ...(link ? { recoveryLink: link.dekByRk } : {}) };
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
    // Etapa 2FA pendente e ativação em andamento também saem da memória
    this.cancelSecondFactor();
    this.twoFactorSetup = null;
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
export const _test = { wrapKey, unwrapKey, dekFromRk };

/** DEK a partir da RK do código de recuperação e da ligação guardada no backup (null se não confere). */
export function dekFromRecoveryLink(rk: Uint8Array, dekByRk: string): Uint8Array | null {
  try {
    return aesDecrypt(rk, fromB64(dekByRk), aadDekByRk('code'));
  } catch {
    return null;
  }
}
/** Envelope da DEK (PBKDF2 + AES-256-GCM), usado também para abrir backups em outro aparelho. */
export const KeyEnvelope = { wrap: wrapKey, unwrap: unwrapKey };
export type { Wrapped as WrappedKey };
