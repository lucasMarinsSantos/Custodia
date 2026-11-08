// Exportação do cofre e inventário de contas sem senhas
//  • CSV legível (compatível com o importador do Chrome/Edge, com pasta, categoria e favorito a mais)
//  • JSON legível do Custódia (credenciais, pastas, notas e formulários)
//  • JSON cifrado com senha temporária (AES-256-GCM, chave PBKDF2; transfer/envelope.ts)
//  • Inventário (CSV ou JSON) só com metadados, com senha opcional
// Regras: exportar exige reautenticação (senha mestra ou biometria) feita há no máximo 60 s; o conteúdo de
// pastas com "Bloquear exportação" (PolicyService) fica de fora e a quantidade omitida é informada; no CSV, as
// fórmulas são neutralizadas (injeção de CSV).

import { utf8, toB64, wipe } from '../crypto';
import { vaultDb } from '../db/Database';
import { System } from '../native';
import { CategoryLabels, Credential, Folder, FormItem, SecureNote, StrengthLabels } from '../types/models';
import { daysBetween } from '../utils';
import { strengthOf } from './AnalysisService';
import { bus, Events } from './events';
import { PolicyService } from './PolicyService';
import { Repo } from './Repository';
import { Vault } from './VaultService';
import { toCsv } from './transfer/csv';
import { decryptEnvelope, encryptEnvelope, EncryptedEnvelope, filePasswordError } from './transfer/envelope';

export type ExportFormat = 'csv' | 'json' | 'json_encrypted';
export type InventoryFormat = 'csv' | 'json';

export const ExportFormatLabels: Record<ExportFormat, string> = { csv: 'CSV legível', json: 'JSON legível', json_encrypted: 'JSON cifrado' };

/** Aviso exibido antes de exportar um arquivo legível. */
export const PLAIN_EXPORT_WARNING =
  'O arquivo legível não é protegido: qualquer pessoa ou app com acesso a ele verá todas as suas senhas. Guarde-o em local seguro e apague-o depois de usar.';

/** Validade da reautenticação para exportar. */
export const REAUTH_WINDOW_MS = 60 * 1000;

export interface ExportFile {
  name: string;
  mime: string;
  content: string;
  /** Quantos registros entraram no arquivo. */
  count: number;
  /** Quantos ficaram de fora por causa da regra "Bloquear exportação" das pastas. */
  omitted: number;
}

export interface ExportData {
  credentials: Credential[];
  notes: SecureNote[];
  forms: FormItem[];
  folders: Folder[];
  omitted: number;
}

let reauthUntil = 0;
bus.on(Events.LOCKED, () => {
  reauthUntil = 0;
});

function requireReauth() {
  if (!Vault.isUnlocked) throw new Error('Cofre bloqueado');
  if (Date.now() > reauthUntil) throw new Error('Confirme sua identidade (senha mestra ou biometria) para exportar.');
}

const stamp = () => new Date().toISOString().slice(0, 10);
const dateOnly = (iso?: string | null) => (iso ? iso.slice(0, 10) : '');
const totpOf = (c: Credential) => c.customFields.find(f => f.label.trim().toUpperCase() === 'TOTP')?.value || '';

async function collect(): Promise<ExportData> {
  const folders = await Repo.folders();
  const blocked = (folderId: string | null) => PolicyService.effective(folders, folderId).blockExport;
  const creds = await Repo.credentials();
  const notes = await vaultDb.all<SecureNote>('notes');
  const forms = await vaultDb.all<FormItem>('forms');
  const okCreds = creds.filter(c => !blocked(c.folderId));
  const okNotes = notes.filter(n => !blocked(n.folderId ?? null));
  return {
    credentials: okCreds,
    notes: okNotes,
    forms,
    folders: folders.filter(f => !blocked(f.id)),
    omitted: creds.length - okCreds.length + (notes.length - okNotes.length),
  };
}

function custodiaCsv(d: ExportData): string {
  const header = ['name', 'url', 'username', 'password', 'note', 'folder', 'category', 'favorite', 'totp'];
  const rows = d.credentials.map(c => [c.title, c.url, c.username, c.password, c.notes, Repo.folderPath(d.folders, c.folderId), CategoryLabels[c.category] || c.category, c.favorite ? '1' : '', totpOf(c)]);
  return toCsv(header, rows);
}

function custodiaJson(d: ExportData): string {
  return JSON.stringify(
    {
      format: 'custodia-export',
      version: 1,
      app: 'Custódia',
      exportedAt: new Date().toISOString(),
      folders: d.folders,
      credentials: d.credentials,
      notes: d.notes,
      forms: d.forms,
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Inventário: nunca inclui senha, histórico de senhas, notas nem campos personalizados
// ---------------------------------------------------------------------------
export interface InventoryEntry {
  title: string;
  username: string;
  url: string;
  category: string;
  folder: string;
  createdAt: string;
  updatedAt: string;
  passwordChangedAt: string;
  strength: string;
  passwordAgeDays: number;
  expiresAt: string | null;
  status: 'Ativa' | 'Vencida' | 'Inativa';
  usageCount: number;
  lastUsedAt: string | null;
}

export function inventoryEntries(creds: Credential[], folders: Folder[]): InventoryEntry[] {
  return creds.map(c => {
    const expired = !!c.expiresAt && Date.parse(c.expiresAt) <= Date.now();
    return {
      title: c.title,
      username: c.username,
      url: c.url,
      category: CategoryLabels[c.category] || c.category,
      folder: Repo.folderPath(folders, c.folderId),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      passwordChangedAt: c.passwordChangedAt,
      strength: c.password ? StrengthLabels[strengthOf(c.password)] : 'Sem senha',
      passwordAgeDays: Math.max(0, daysBetween(c.passwordChangedAt || c.createdAt)),
      expiresAt: c.expiresAt,
      status: expired ? 'Vencida' : c.inactive ? 'Inativa' : 'Ativa',
      usageCount: c.usageCount || 0,
      lastUsedAt: c.lastUsedAt,
    };
  });
}

const INVENTORY_HEADER = ['Título', 'Usuário', 'Site', 'Categoria', 'Pasta', 'Criada em', 'Atualizada em', 'Senha trocada em', 'Força', 'Idade da senha (dias)', 'Vence em', 'Situação', 'Vezes utilizada', 'Último uso'];

function inventoryCsv(list: InventoryEntry[]): string {
  return toCsv(
    INVENTORY_HEADER,
    list.map(e => [e.title, e.username, e.url, e.category, e.folder, dateOnly(e.createdAt), dateOnly(e.updatedAt), dateOnly(e.passwordChangedAt), e.strength, e.passwordAgeDays, dateOnly(e.expiresAt), e.status, e.usageCount, dateOnly(e.lastUsedAt)]),
    ',',
  );
}

function inventoryJson(list: InventoryEntry[]): string {
  return JSON.stringify({ format: 'custodia-inventory', version: 1, app: 'Custódia', exportedAt: new Date().toISOString(), accounts: list }, null, 2);
}

export const ExportService = {
  /**
   * Reautenticação exigida antes de exportar (senha mestra, com o mesmo limite de tentativas do login, ou biometria).
   * Vale por 60 s.
   */
  async confirmIdentity(input: { method: 'password'; password: string } | { method: 'biometric' }): Promise<void> {
    const profile = Vault.currentProfile;
    if (!profile || !Vault.isUnlocked) throw new Error('Cofre bloqueado');
    if (input.method === 'password') {
      if (!(await Vault.verifyCurrentPassword(input.password))) throw new Error('Senha mestra incorreta.');
    } else {
      if (!Vault.settings.biometricEnabled) throw new Error('A biometria não está ativada. Use a senha mestra.');
      wipe(await Vault.verifyBiometric(profile.id));
    }
    reauthUntil = Date.now() + REAUTH_WINDOW_MS;
  },

  /** Apenas para testes. */
  _resetReauth() {
    reauthUntil = 0;
  },

  collect,

  /** Monta o arquivo de exportação. `password` é obrigatório no JSON cifrado (temporária ou definida pelo usuário). */
  async build(format: ExportFormat, opts: { password?: string; iterations?: number } = {}): Promise<ExportFile> {
    requireReauth();
    const data = await collect();
    const count = data.credentials.length + data.notes.length + data.forms.length;
    const base = `custodia-exportacao-${stamp()}`;
    if (format === 'csv') return { name: `${base}.csv`, mime: 'text/csv', content: custodiaCsv(data), count: data.credentials.length, omitted: data.omitted };
    if (format === 'json') return { name: `${base}.json`, mime: 'application/json', content: custodiaJson(data), count, omitted: data.omitted };
    const err = filePasswordError(opts.password || '');
    if (err) throw new Error(err);
    const env = await encryptEnvelope(custodiaJson(data), opts.password!, 'export', opts.iterations);
    return { name: `${base}-cifrado.json`, mime: 'application/json', content: JSON.stringify(env, null, 2), count, omitted: data.omitted };
  },

  /** Inventário de contas (sem senhas), com senha opcional. */
  async buildInventory(format: InventoryFormat, opts: { password?: string; iterations?: number } = {}): Promise<ExportFile> {
    requireReauth();
    const data = await collect();
    const list = inventoryEntries(data.credentials, data.folders);
    const name = `custodia-inventario-${stamp()}.${format}`;
    const mime = format === 'csv' ? 'text/csv' : 'application/json';
    const content = format === 'csv' ? inventoryCsv(list) : inventoryJson(list);
    if (!opts.password) return { name, mime, content, count: list.length, omitted: data.omitted };
    const err = filePasswordError(opts.password);
    if (err) throw new Error(err);
    const env = await encryptEnvelope(JSON.stringify({ name, mime, content }), opts.password, 'inventory', opts.iterations);
    return { name: `custodia-inventario-${stamp()}-cifrado.json`, mime: 'application/json', content: JSON.stringify(env, null, 2), count: list.length, omitted: data.omitted };
  },

  /** Abre um inventário cifrado e devolve o arquivo legível original (CSV ou JSON) para salvar. */
  async openInventory(env: EncryptedEnvelope, password: string, opts?: { minIterations?: number }): Promise<{ name: string; mime: string; content: string }> {
    if (env.kind !== 'inventory') throw new Error('O arquivo não é um inventário do Custódia');
    const inner = JSON.parse(await decryptEnvelope(env, password, opts));
    if (typeof inner?.content !== 'string' || typeof inner?.name !== 'string') throw new Error('Inventário cifrado inválido');
    const name = inner.name.replace(/[^\w.-]/g, '_').slice(0, 80);
    return { name, mime: inner.mime === 'text/csv' ? 'text/csv' : 'application/json', content: inner.content };
  },

  /** Salva pelo seletor do sistema (SAF). Devolve false se o usuário cancelar. */
  async save(file: { name: string; mime: string; content: string }): Promise<boolean> {
    return System.saveFile(file.name, file.mime, toB64(utf8(file.content)));
  },
};
