// Backup cifrado automático e restauração
//
// FORMATO DO ARQUIVO `.custodia` (versão 1, texto JSON):
//   {
//     "format": "custodia-backup", "version": 1, "app": "Custódia", "createdAt": "<ISO>",
//     "kdf":  { "name": "HKDF-SHA256", "salt": "<base64 16 bytes>", "info": "custodia-backup-v1" },
//     "keys": { "master": <envelope>, "recoveryCode": <envelope> },
//     "cipher": "AES-256-GCM",
//     "data": "<base64: versão(1) | nonce(12) | texto cifrado + tag(16)>"
//   }
//   <envelope> = { salt, iter, wrapped }: a DEK do cofre cifrada (AES-256-GCM, AAD "custodia-dek") por
//                PBKDF2-HMAC-SHA256(segredo, salt, iter). É a mesma cópia guardada no Keystore.
//   Chave do backup  BK = HKDF-SHA256(DEK, salt do kdf, info), uma chave nova por arquivo.
//   AAD do conteúdo     = "custodia-backup|1|<createdAt>|<salt>|<info>" (o cabeçalho não pode ser trocado).
//   Conteúdo em claro   = { "collections": { credentials, folders, notes, forms } } (USER_COLLECTIONS).
//
// Por que assim: o backup automático acontece no desbloqueio por biometria, quando a senha mestra não está
// disponível, então a chave vem da DEK (HKDF). E o arquivo precisa abrir depois de reinstalar o app ou em
// outro celular, onde o Keystore é outro: por isso os envelopes da DEK pela senha mestra e pelo código de
// recuperação viajam dentro do arquivo. Para restaurar basta a senha mestra vigente no dia do backup (ou o
// código de recuperação daquele dia). Nada depende do Keystore.
//
// Agenda: a cada `backupIntervalDays` (7), verificado no desbloqueio e quando o app volta ao primeiro plano.
// Destino: pasta escolhida pelo usuário (SAF, permissão persistente) ou, sem pasta, o armazenamento interno do
// app. Ficam os BACKUP_KEEP arquivos mais recentes. Opcional: cópia no Google Drive (escopo drive.file).
// Falha no backup automático gera um alerta "backup" (AlertService).

import { AppState } from 'react-native';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { aesDecrypt, aesEncrypt, fromB64, fromUtf8, randomBytes, sha256Hex, toB64, utf8, wipe } from '../crypto';
import { Collection, USER_COLLECTIONS, vaultDb } from '../db/Database';
import { BackupDoc, BackupNative, DRIVE_NEEDS_CONSENT, DRIVE_NOT_CONFIGURED } from '../native/backup';
import { System } from '../native';
import { Transfer } from '../native/transfer';
import { Credential, DefaultFolderPolicy, Folder, FormItem, SecureNote } from '../types/models';
import { AlertService } from './AlertService';
import { bus, Events } from './events';
import { LIMITS, Repo } from './Repository';
import { dekFromRecoveryLink, KeyEnvelope, normalizeRecoveryCode, Vault, WrappedKey } from './VaultService';
import { sanitizeCredential, sanitizeForm, sanitizeNote } from './transfer/sanitize';

export const BACKUP_FORMAT = 'custodia-backup';
/** Extensão do arquivo (cenário BDD "Exportar arquivo de backup local": arquivo criptografado .custodia). */
export const BACKUP_EXT = '.custodia';
export const BACKUP_MIME = 'application/octet-stream';
export const BACKUP_INFO = 'custodia-backup-v1';
/** Quantos backups ficam no destino (os mais antigos são apagados). */
export const BACKUP_KEEP = 5;
/** Maior backup aceito para restaurar. */
export const MAX_BACKUP_BYTES = 40 * 1024 * 1024;
/** Mensagem do cenário BDD "Restaurar de um backup com senha incorreta". */
export const BACKUP_DECRYPT_ERROR = 'Falha na descriptografia. Senha inválida.';
/** A senha abriu a chave, mas o conteúdo não confere com a tag GCM: o arquivo foi alterado ou está truncado. */
export const BACKUP_INTEGRITY_ERROR = 'Backup corrompido ou adulterado: a verificação de integridade falhou.';
export const DRIVE_NOT_CONFIGURED_MSG = 'Google Drive não configurado';
const DAY_MS = 86400000;
const FOLDER_FALLBACK = 'Pasta escolhida';
const INTERNAL_LABEL = 'Armazenamento interno do app';
const DRIVE_TIMEOUT_MS = 30000;
const MIN_ITER = 100000;
const MAX_ITER = 5000000;
const MSG_LOCKED = 'Cofre bloqueado';
const MAX_DOCS = 20000;
const NAME_RE = /^custodia-backup-[\dT-]+(?:-[a-z0-9]{4}){0,2}\.custodia$/;

/** Marca curta do perfil (não revela o id): cada perfil só lista e apaga os próprios backups. */
function profileTag(): string {
  return sha256Hex(`custodia-backup-profile:${vaultDb.profileId ?? ''}`).slice(0, 4);
}

const TAGGED_RE = /^custodia-backup-[\dT-]+?-([a-z0-9]{4})-[a-z0-9]{4}\.custodia$/;

/** Backup do perfil atual ou antigo (sem marca, de antes dos perfis): os de outros perfis ficam de fora. */
function isOwnName(name: string, tag: string): boolean {
  const m = TAGGED_RE.exec(name);
  return !m || m[1] === tag;
}

const KV = {
  lastAt: 'backup:lastAt',
  lastName: 'backup:lastName',
  lastError: 'backup:lastError',
  folderUri: 'backup:folderUri',
  folderName: 'backup:folderName',
  driveState: 'backup:driveState',
  driveLastAt: 'backup:driveLastAt',
  driveError: 'backup:driveError',
};

export interface BackupFileV1 {
  format: typeof BACKUP_FORMAT;
  version: 1;
  app: 'Custódia';
  createdAt: string;
  kdf: { name: 'HKDF-SHA256'; salt: string; info: string };
  /** `recoveryLink`: DEK cifrada pela chave de recuperação, presente quando o código libera uma RK. */
  keys: { master: WrappedKey; recoveryCode: WrappedKey; recoveryLink?: string };
  cipher: 'AES-256-GCM';
  data: string;
}

type Payload = Record<'credentials' | 'folders' | 'notes' | 'forms', any[]>;

export type RestoreMode = 'merge' | 'replace';

export interface RestorePreview {
  createdAt: string;
  /** Perfil em que a prévia foi montada: restaurar em outro perfil é recusado. */
  profileId?: string | null;
  counts: Record<keyof Payload, number>;
  /** Registros do backup que já existem no cofre (mesmo id). */
  conflicts: number;
  /** Documentos inválidos descartados. */
  invalid: number;
  payload: Payload;
}

export interface BackupStatus {
  autoBackup: boolean;
  intervalDays: number;
  lastAt: string | null;
  nextAt: string | null;
  destination: 'folder' | 'internal';
  destinationLabel: string;
  lastError: string | null;
  drive: { enabled: boolean; state: 'ok' | 'not_configured' | 'error' | null; lastAt: string | null; error: string | null };
}

export type DriveResult = 'off' | 'ok' | 'not_configured' | 'error';

const aadOf = (f: Pick<BackupFileV1, 'createdAt' | 'kdf'>) => utf8(`${BACKUP_FORMAT}|1|${f.createdAt}|${f.kdf.salt}|${f.kdf.info}`);

function fileName(at: Date): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const suffix = toB64(randomBytes(3)).replace(/[^a-z0-9]/gi, '').toLowerCase().padEnd(4, '0').slice(0, 4);
  return `custodia-backup-${stamp}-${profileTag()}-${suffix}${BACKUP_EXT}`;
}

// ---------------------------------------------------------------------------
// Validação do arquivo (entrada externa)
// ---------------------------------------------------------------------------
function validEnvelope(w: any): w is WrappedKey {
  return !!w && typeof w.salt === 'string' && typeof w.wrapped === 'string' && Number.isInteger(w.iter) && w.iter >= MIN_ITER && w.iter <= MAX_ITER;
}

export function parseBackup(text: string): BackupFileV1 {
  let f: any;
  try {
    f = JSON.parse(text);
  } catch {
    throw new Error('O arquivo não é um backup do Custódia.');
  }
  if (!f || f.format !== BACKUP_FORMAT) throw new Error('O arquivo não é um backup do Custódia.');
  if (f.version !== 1) throw new Error('Versão de backup não suportada. Atualize o app.');
  const ok = f.cipher === 'AES-256-GCM' && f.kdf?.name === 'HKDF-SHA256' && typeof f.kdf.salt === 'string' && typeof f.kdf.info === 'string';
  if (!ok || typeof f.data !== 'string' || typeof f.createdAt !== 'string' || !validEnvelope(f.keys?.master) || !validEnvelope(f.keys?.recoveryCode) || (f.keys.recoveryLink !== undefined && (typeof f.keys.recoveryLink !== 'string' || f.keys.recoveryLink.length > 512))) {
    throw new Error('Backup corrompido ou adulterado.');
  }
  return f as BackupFileV1;
}

const ID_OK = (d: any) => !!d && typeof d === 'object' && typeof d.id === 'string' && d.id.length > 0 && d.id.length <= 100;
const isoOr = (v: unknown, fallback: string) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : fallback);

/** Revalida cada documento do backup com as mesmas regras da importação; o inválido é descartado. */
function cleanDoc(collection: keyof Payload, d: any): any | null {
  if (!ID_OK(d)) return null;
  const ts = new Date().toISOString();
  const meta = { id: d.id, createdAt: isoOr(d.createdAt, ts), updatedAt: isoOr(d.updatedAt, ts) };
  const folderId = typeof d.folderId === 'string' ? d.folderId : null;
  try {
    if (collection === 'credentials') return { ...sanitizeCredential(d), ...meta, folderId, passwordChangedAt: isoOr(d.passwordChangedAt, meta.createdAt) };
    if (collection === 'notes') return { ...sanitizeNote(d), ...meta, folderId };
    if (collection === 'forms') return { ...sanitizeForm(d), ...meta };
    return cleanFolder(d, meta);
  } catch {
    return null;
  }
}

function cleanFolder(d: any, meta: { id: string; createdAt: string; updatedAt: string }): Folder | null {
  const name = typeof d.name === 'string' ? d.name.trim().slice(0, LIMITS.folderName) : '';
  if (!name) return null;
  const p = d.policy && typeof d.policy === 'object' ? d.policy : null;
  const num = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 && (v as number) <= 3650 ? (v as number) : null);
  return {
    ...meta,
    name,
    parentId: typeof d.parentId === 'string' ? d.parentId : null,
    color: typeof d.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(d.color) ? d.color : '#0D9488',
    icon: typeof d.icon === 'string' && d.icon.length <= 40 ? d.icon : 'folder',
    order: Number.isFinite(d.order) ? d.order : Date.now(),
    policy: p
      ? {
          ...DefaultFolderPolicy,
          requireReauth: p.requireReauth === true,
          blockAutofill: p.blockAutofill === true,
          blockExport: p.blockExport === true,
          minStrength: ['critical', 'weak', 'medium', 'strong', 'very_strong'].includes(p.minStrength) ? p.minStrength : null,
          maxAgeDays: num(p.maxAgeDays),
          clipboardSeconds: num(p.clipboardSeconds),
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Destino e Google Drive
// ---------------------------------------------------------------------------
async function kv(key: string): Promise<string | null> {
  return vaultDb.isOpen ? vaultDb.getKv(key) : null;
}

async function listDestination(): Promise<BackupDoc[]> {
  const folder = await kv(KV.folderUri);
  const docs = folder ? await BackupNative.listFolder(folder) : await BackupNative.listInternal();
  const tag = profileTag();
  return docs.filter(d => NAME_RE.test(d.name) && isOwnName(d.name, tag)).sort((a, b) => b.name.localeCompare(a.name));
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DRIVE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e: any) {
    throw new Error(e?.name === 'AbortError' ? 'Tempo esgotado ao falar com o Google Drive' : 'Sem conexão com o Google Drive');
  } finally {
    clearTimeout(timer);
  }
}

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id';

async function driveUpload(token: string, name: string, json: string): Promise<void> {
  const boundary = `custodia${toB64(randomBytes(9)).replace(/[^a-z0-9]/gi, '')}`;
  const metadata = { name, mimeType: BACKUP_MIME, description: 'Backup cifrado do Custódia', appProperties: { custodia: 'backup', profile: profileTag() } };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${BACKUP_MIME}\r\n\r\n${json}\r\n--${boundary}--`;
  const res = await fetchWithTimeout(DRIVE_UPLOAD, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`O Google Drive recusou o envio (${res.status})`);
}

/** Mantém só os BACKUP_KEEP mais recentes no Drive (o escopo drive.file só enxerga arquivos criados pelo app). */
async function driveRetention(token: string): Promise<void> {
  // Só os backups deste perfil: os de outros perfis (e os antigos, sem marca) não são apagados
  const q = encodeURIComponent(`appProperties has { key='custodia' and value='backup' } and appProperties has { key='profile' and value='${profileTag()}' } and trashed=false`);
  const res = await fetchWithTimeout(`${DRIVE_FILES}?q=${q}&orderBy=createdTime%20desc&fields=files(id,name)&pageSize=100`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Não foi possível listar os backups no Google Drive (${res.status})`);
  const files: { id: string }[] = ((await res.json())?.files || []).filter((f: any) => typeof f?.id === 'string' && /^[\w-]+$/.test(f.id));
  for (const f of files.slice(BACKUP_KEEP)) {
    await fetchWithTimeout(`${DRIVE_FILES}/${f.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  }
}

function driveErrorState(e: any): 'not_configured' | 'error' {
  const code = String(e?.code || '');
  return code === DRIVE_NOT_CONFIGURED || /DEVELOPER_ERROR|não configurado|not configured|\b10:/i.test(String(e?.message || '')) ? 'not_configured' : 'error';
}

// ---------------------------------------------------------------------------
// Restauração
// ---------------------------------------------------------------------------
/** Referência a uma pasta que não existe mais: o item (ou a subpasta) vai para a raiz. */
function fixRefs(doc: any, folderIds: Set<string>): any {
  let out = doc;
  if (out.folderId && !folderIds.has(out.folderId)) out = { ...out, folderId: null };
  if (out.parentId && !folderIds.has(out.parentId)) out = { ...out, parentId: null };
  return out;
}

async function removeMissing(c: keyof Payload, current: Map<string, any>, incoming: Set<string>, guard: () => void): Promise<number> {
  let removed = 0;
  for (const id of current.keys()) {
    guard();
    if (incoming.has(id)) continue;
    if (c === 'credentials') await Repo.deleteCredential(id);
    else await vaultDb.remove(c as Collection, id);
    removed++;
  }
  return removed;
}

async function restoreCollection(c: keyof Payload, docs: any[], mode: RestoreMode, folderIds: Set<string>, guard: () => void) {
  const current = new Map((await vaultDb.all<any>(c as Collection)).map(d => [d.id, d]));
  const removed = mode === 'replace' ? await removeMissing(c, current, new Set(docs.map(d => d.id)), guard) : 0;
  let written = 0;
  for (const doc of docs) {
    guard();
    const prev = current.get(doc.id);
    // Mesclar: o que já está no cofre e é igual ou mais novo fica como está
    if (mode === 'merge' && prev && String(prev.updatedAt || '') >= String(doc.updatedAt || '')) continue;
    await vaultDb.put(c as Collection, fixRefs(doc, folderIds) as Credential | Folder | SecureNote | FormItem);
    written++;
  }
  return { written, removed };
}

// ---------------------------------------------------------------------------
// Serviço
// ---------------------------------------------------------------------------
let running: Promise<unknown> | null = null;
let initialized = false;

export const BackupService = {
  /** Agenda a verificação quando o app volta ao primeiro plano (o desbloqueio é tratado no AppController). */
  init() {
    if (initialized) return;
    initialized = true;
    AppState.addEventListener('change', s => {
      if (s === 'active' && Vault.isUnlocked) this.autoBackupIfDue().catch(() => {});
    });
  },

  /** Monta o arquivo cifrado com todas as coleções do usuário. */
  async build(): Promise<{ name: string; json: string; file: BackupFileV1 }> {
    if (!Vault.isUnlocked) throw new Error(MSG_LOCKED);
    const collections: Record<string, any[]> = {};
    for (const c of USER_COLLECTIONS) collections[c] = await vaultDb.all(c);
    const createdAt = new Date().toISOString();
    const salt = randomBytes(16);
    const kdf = { name: 'HKDF-SHA256' as const, salt: toB64(salt), info: BACKUP_INFO };
    const keys = await Vault.backupEnvelopes();
    const bk = Vault.deriveSubkey(salt, BACKUP_INFO);
    let data: string;
    try {
      data = toB64(aesEncrypt(bk, utf8(JSON.stringify({ collections })), aadOf({ createdAt, kdf })));
    } finally {
      wipe(bk);
    }
    const file: BackupFileV1 = { format: BACKUP_FORMAT, version: 1, app: 'Custódia', createdAt, kdf, keys, cipher: 'AES-256-GCM', data };
    return { name: fileName(new Date(createdAt)), json: JSON.stringify(file), file };
  },

  /** Faz o backup no destino configurado, aplica a retenção e envia ao Drive (se ativado). */
  async run(opts: { interactive?: boolean } = {}): Promise<{ name: string; destination: string; drive: DriveResult }> {
    const job = (async () => {
      const { name, json } = await this.build();
      const b64 = toB64(utf8(json));
      const folder = await kv(KV.folderUri);
      if (folder) await BackupNative.writeToFolder(folder, name, BACKUP_MIME, b64);
      else await BackupNative.writeInternal(name, b64);
      const docs = await listDestination();
      for (const old of docs.slice(BACKUP_KEEP)) await BackupNative.deleteDocument(old.uri);
      await vaultDb.setKv(KV.lastAt, new Date().toISOString());
      await vaultDb.setKv(KV.lastName, name);
      await vaultDb.setKv(KV.lastError, '');
      const drive = Vault.settings.googleDriveBackup ? await this.sendToDrive(name, json, !!opts.interactive) : 'off';
      return { name, destination: folder ? (await kv(KV.folderName)) || FOLDER_FALLBACK : INTERNAL_LABEL, drive };
    })();
    running = job;
    try {
      return await job;
    } finally {
      if (running === job) running = null;
    }
  },

  /** Envia ao Google Drive. Sem OAuth Client ID configurado, devolve 'not_configured' e o backup local continua valendo. */
  async sendToDrive(name: string, json: string, interactive: boolean): Promise<DriveResult> {
    try {
      const token = await BackupNative.driveAuthorize(interactive);
      await driveUpload(token, name, json);
      await vaultDb.setKv(KV.driveState, 'ok');
      await vaultDb.setKv(KV.driveLastAt, new Date().toISOString());
      await vaultDb.setKv(KV.driveError, '');
      await driveRetention(token).catch(e => console.warn('[Backup] retenção no Google Drive:', String(e?.message || e)));
      return 'ok';
    } catch (e: any) {
      const state = driveErrorState(e);
      const msg = state === 'not_configured' ? DRIVE_NOT_CONFIGURED_MSG : String(e?.code === DRIVE_NEEDS_CONSENT ? 'Abra Backup e reconecte o Google Drive' : e?.message || e);
      if (vaultDb.isOpen) {
        await vaultDb.setKv(KV.driveState, state);
        await vaultDb.setKv(KV.driveError, msg);
      }
      if (state === 'error' && Vault.isUnlocked) {
        await AlertService.raise({ type: 'backup', severity: 'warning', title: 'Falha ao enviar o backup ao Google Drive', message: `${msg}. O backup local foi feito normalmente.` });
      }
      return state;
    }
  },

  /** Testa a conexão com o Drive pedindo a autorização (abre a tela de consentimento do Google). */
  async connectDrive(): Promise<void> {
    try {
      await BackupNative.driveAuthorize(true);
      await vaultDb.setKv(KV.driveState, 'ok');
      await vaultDb.setKv(KV.driveError, '');
    } catch (e: any) {
      const state = driveErrorState(e);
      await vaultDb.setKv(KV.driveState, state);
      const msg = state === 'not_configured' ? DRIVE_NOT_CONFIGURED_MSG : String(e?.message || e);
      await vaultDb.setKv(KV.driveError, msg);
      throw new Error(state === 'not_configured' ? `${DRIVE_NOT_CONFIGURED_MSG}. O backup continua sendo feito no aparelho.` : msg);
    }
  },

  async lastBackupAt(): Promise<string | null> {
    return (await kv(KV.lastAt)) || null;
  },

  /** Backup automático vencido? Um cofre novo e vazio ainda não precisa de backup. */
  async isDue(at = Date.now()): Promise<boolean> {
    if (!Vault.isUnlocked || !Vault.settings.autoBackup) return false;
    const last = await this.lastBackupAt();
    if (!last) return (await Repo.credentials()).length > 0 || (await vaultDb.all('notes')).length > 0;
    const interval = Math.max(1, Vault.settings.backupIntervalDays || 7) * DAY_MS;
    const elapsed = at - Date.parse(last);
    // Relógio atrasado (tempo negativo) também dispara: melhor um backup a mais do que nenhum
    return !(elapsed >= 0 && elapsed < interval);
  },

  /** Verificado no desbloqueio e ao voltar ao primeiro plano. Nunca lança: a falha vira alerta "backup". */
  async autoBackupIfDue(): Promise<boolean> {
    if (running) return false;
    try {
      if (!(await this.isDue())) return false;
      await this.run({ interactive: false });
      return true;
    } catch (e: any) {
      // Cofre bloqueado no meio do backup não é falha do backup
      if (!Vault.isUnlocked) return false;
      const msg = String(e?.message || e);
      await vaultDb.setKv(KV.lastError, msg).catch(() => {});
      await AlertService.raise({ type: 'backup', severity: 'warning', title: 'Falha no backup automático', message: `${msg}. Abra Ajustes › Backup para tentar de novo.` });
      return false;
    }
  },

  async status(): Promise<BackupStatus> {
    const s = Vault.settings;
    const lastAt = (await kv(KV.lastAt)) || null;
    const folderUri = await kv(KV.folderUri);
    const intervalDays = Math.max(1, s.backupIntervalDays || 7);
    const driveState = (await kv(KV.driveState)) as BackupStatus['drive']['state'];
    return {
      autoBackup: s.autoBackup,
      intervalDays,
      lastAt,
      nextAt: s.autoBackup ? new Date(lastAt ? Date.parse(lastAt) + intervalDays * DAY_MS : Date.now()).toISOString() : null,
      destination: folderUri ? 'folder' : 'internal',
      destinationLabel: folderUri ? (await kv(KV.folderName)) || FOLDER_FALLBACK : INTERNAL_LABEL,
      lastError: (await kv(KV.lastError)) || null,
      drive: { enabled: s.googleDriveBackup, state: driveState || null, lastAt: (await kv(KV.driveLastAt)) || null, error: (await kv(KV.driveError)) || null },
    };
  },

  /** Escolhe a pasta de destino (permissão persistente). false = cancelado. */
  async chooseFolder(): Promise<boolean> {
    const f = await BackupNative.pickFolder();
    if (!f) return false;
    await vaultDb.setKv(KV.folderUri, f.uri);
    await vaultDb.setKv(KV.folderName, String(f.name || FOLDER_FALLBACK).slice(0, 120));
    return true;
  },

  /** Volta a usar o armazenamento interno do app. */
  async selectInternal(): Promise<void> {
    await vaultDb.setKv(KV.folderUri, '');
    await vaultDb.setKv(KV.folderName, '');
  },

  list: listDestination,

  /**
   * "Criar Backup" (BDD "Exportar arquivo de backup local"): confirma a senha mestra e grava o arquivo cifrado
   * `.custodia` no destino local (pasta privada do app ou a pasta escolhida), mantendo os BACKUP_KEEP mais recentes.
   */
  async createBackup(masterPassword: string) {
    if (!(await Vault.verifyCurrentPassword(masterPassword))) throw new Error('Senha mestra incorreta.');
    return this.run({ interactive: true });
  },

  /**
   * Alternativa ao Drive sem OAuth: abre o seletor do Android (SAF, ACTION_CREATE_DOCUMENT), onde o usuário pode
   * escolher o próprio Google Drive, um cartão SD ou outro provedor. Devolve false se o usuário cancelar.
   */
  async saveCopy(masterPassword: string): Promise<boolean> {
    if (!(await Vault.verifyCurrentPassword(masterPassword))) throw new Error('Senha mestra incorreta.');
    const { name, json } = await this.build();
    return System.saveFile(name, BACKUP_MIME, toB64(utf8(json)));
  },

  /** "Restaurar Backup": escolhe o arquivo pelo seletor do sistema e valida o formato. null = cancelado. */
  async pickFile(): Promise<BackupFileV1 | null> {
    const f = await Transfer.pickFile(['application/octet-stream', 'application/json', '*/*'], MAX_BACKUP_BYTES);
    if (!f) return null;
    if (f.size > MAX_BACKUP_BYTES || f.base64.length > (MAX_BACKUP_BYTES * 4) / 3 + 4) throw new Error('Backup grande demais para restaurar');
    return parseBackup(fromUtf8(fromB64(f.base64)));
  },

  /** Lê um backup do destino (lista "Backups salvos"). */
  async readDocument(uri: string): Promise<BackupFileV1> {
    const b64 = await BackupNative.readDocument(uri, MAX_BACKUP_BYTES);
    return parseBackup(fromUtf8(fromB64(b64)));
  },

  parse: parseBackup,

  /**
   * Abre o backup com a senha mestra do dia do backup (ou o código de recuperação). Mostra a prévia, não grava nada.
   * Senha errada: "Falha na descriptografia. Senha inválida."
   */
  async open(file: BackupFileV1, secret: string): Promise<RestorePreview> {
    let dek = await KeyEnvelope.unwrap(secret, file.keys.master);
    const code = normalizeRecoveryCode(secret);
    if (!dek && code.length === 30) {
      const rk = await KeyEnvelope.unwrap(code, file.keys.recoveryCode);
      // Com a ligação o código libera a RK, e a RK abre a DEK; sem ela (cofres da versão 0.1) RK = DEK
      if (rk && file.keys.recoveryLink) {
        dek = dekFromRecoveryLink(rk, file.keys.recoveryLink);
        wipe(rk);
      } else {
        dek = rk;
      }
    }
    if (!dek) throw new Error(BACKUP_DECRYPT_ERROR);
    const bk = hkdf(sha256, dek, fromB64(file.kdf.salt), utf8(file.kdf.info), 32);
    wipe(dek);
    let text: string;
    try {
      text = fromUtf8(aesDecrypt(bk, fromB64(file.data), aadOf(file)));
    } catch {
      // A chave abriu, então a senha está certa: quem falhou foi a verificação de integridade do conteúdo
      throw new Error(BACKUP_INTEGRITY_ERROR);
    } finally {
      wipe(bk);
    }
    let collections: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(text)?.collections;
      if (parsed && typeof parsed === 'object') collections = parsed;
    } catch {
      throw new Error(BACKUP_INTEGRITY_ERROR);
    }
    return this.previewPayload(file.createdAt, collections);
  },

  async previewPayload(createdAt: string, raw: Record<string, unknown>): Promise<RestorePreview> {
    const payload: Payload = { credentials: [], folders: [], notes: [], forms: [] };
    let invalid = 0;
    let conflicts = 0;
    for (const c of Object.keys(payload) as (keyof Payload)[]) {
      const list = Array.isArray(raw[c]) ? (raw[c] as any[]) : [];
      if (list.length > MAX_DOCS) throw new Error('Backup grande demais para restaurar');
      const existing = new Set((await vaultDb.all<{ id: string }>(c as Collection)).map(d => d.id));
      for (const d of list) {
        const clean = cleanDoc(c, d);
        if (!clean) invalid++;
        else {
          payload[c].push(clean);
          if (existing.has(clean.id)) conflicts++;
        }
      }
    }
    const counts = { credentials: payload.credentials.length, folders: payload.folders.length, notes: payload.notes.length, forms: payload.forms.length };
    return { createdAt, profileId: vaultDb.profileId, counts, conflicts, invalid, payload };
  },

  /**
   * Aplica a restauração.
   *  • merge  : acrescenta o que falta e atualiza o que no backup é mais recente (updatedAt).
   *  • replace: o cofre fica igual ao backup (o que não está no backup é removido).
   */
  async restore(preview: RestorePreview, mode: RestoreMode): Promise<{ written: number; removed: number }> {
    if (!Vault.isUnlocked) throw new Error(MSG_LOCKED);
    const guard = () => {
      // Bloqueio (ou troca de perfil) no meio da restauração: não grava no cofre de outro perfil
      if (!Vault.isUnlocked || (preview.profileId && preview.profileId !== vaultDb.profileId)) throw new Error(MSG_LOCKED);
    };
    guard();
    const total = { written: 0, removed: 0 };
    const folderIds = new Set(preview.payload.folders.map(f => f.id));
    if (mode === 'merge') for (const f of await Repo.folders()) folderIds.add(f.id);
    for (const c of ['folders', 'credentials', 'notes', 'forms'] as (keyof Payload)[]) {
      const r = await restoreCollection(c, preview.payload[c], mode, folderIds, guard);
      total.written += r.written;
      total.removed += r.removed;
    }
    bus.emit(Events.DATA_CHANGED);
    return total;
  },

  /** Apenas para testes. */
  _reset() {
    running = null;
  },
};
