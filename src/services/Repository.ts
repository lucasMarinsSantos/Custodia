// Repositório do cofre (CRUD sobre o banco SQLCipher)
//  • Credenciais: adicionar, editar, excluir e visualizar
//  • Histórico de versões com reversão
//  • Pastas e subpastas, mover credenciais
//  • Contador de uso para a ordenação inteligente

import { vaultDb } from '../db/Database';
import { uuid } from '../crypto';
import { ChangeType, Credential, CredentialVersion, Folder, PasswordHistoryEntry } from '../types/models';
import { bus, Events } from './events';

const now = () => new Date().toISOString();

/** Quantidade máxima de versões guardadas por credencial. */
export const MAX_VERSIONS = 50;

export function newCredential(partial: Partial<Credential> = {}): Credential {
  const ts = now();
  return {
    id: uuid(),
    title: '',
    username: '',
    password: '',
    url: '',
    notes: '',
    category: 'other',
    folderId: null,
    favorite: false,
    customFields: [],
    icon: { kind: 'auto' },
    usageCount: 0,
    lastUsedAt: null,
    passwordChangedAt: ts,
    expiresAt: null,
    inactive: false,
    maxPasswordAgeDays: null,
    passwordHistory: [],
    associatedDomains: [],
    androidPackages: [],
    createdAt: ts,
    updatedAt: ts,
    ...partial,
  };
}

/** Completa registros gravados por versões anteriores (0.1) com os campos novos. */
export function normalizeCredential(c: Credential): Credential {
  return {
    ...c,
    customFields: c.customFields || [],
    icon: c.icon || { kind: 'auto' },
    usageCount: c.usageCount || 0,
    lastUsedAt: c.lastUsedAt ?? null,
    expiresAt: c.expiresAt ?? null,
    inactive: !!c.inactive,
    maxPasswordAgeDays: c.maxPasswordAgeDays ?? null,
    passwordHistory: Array.isArray(c.passwordHistory) ? c.passwordHistory : [],
    associatedDomains: Array.isArray(c.associatedDomains) ? c.associatedDomains : [],
    androidPackages: Array.isArray(c.androidPackages) ? c.androidPackages : [],
  };
}

export function newFolder(name: string, parentId: string | null = null): Folder {
  const ts = now();
  return {
    id: uuid(),
    name,
    parentId,
    color: '#0D9488',
    icon: 'folder',
    order: Date.now(),
    createdAt: ts,
    updatedAt: ts,
  };
}

export class ValidationError extends Error {}

function describeChanges(prev: Credential | null, next: Credential): string {
  if (!prev) return 'Credencial criada';
  const diffs: string[] = [];
  const fields: [keyof Credential, string][] = [
    ['title', 'título'],
    ['username', 'usuário'],
    ['password', 'senha'],
    ['url', 'URL'],
    ['notes', 'notas'],
    ['category', 'categoria'],
    ['folderId', 'pasta'],
    ['favorite', 'favorito'],
    ['expiresAt', 'validade'],
  ];
  for (const [f, label] of fields) if (JSON.stringify(prev[f]) !== JSON.stringify(next[f])) diffs.push(label);
  if (JSON.stringify(prev.customFields) !== JSON.stringify(next.customFields)) diffs.push('campos personalizados');
  if (JSON.stringify(prev.icon) !== JSON.stringify(next.icon)) diffs.push('ícone');
  return diffs.length ? `Alterado: ${diffs.join(', ')}` : 'Sem alterações de conteúdo';
}

function changed() {
  bus.emit(Events.DATA_CHANGED);
}

let lastSeq = 0;
/** Número de sequência crescente (milissegundos × 1000 + contador), estável entre execuções. */
function nextSeq(): number {
  lastSeq = Math.max(lastSeq + 1, Date.now() * 1000);
  return lastSeq;
}

const byNewest = (a: CredentialVersion, b: CredentialVersion) => b.changedAt.localeCompare(a.changedAt) || (b.seq || 0) - (a.seq || 0);

async function addVersion(credentialId: string, changeType: ChangeType, summary: string, snapshot: Credential) {
  await vaultDb.put('versions', { id: uuid(), credentialId, changeType, changedAt: now(), seq: nextSeq(), summary, snapshot } as CredentialVersion, { silent: true });
  // Mantém apenas as versões mais recentes de cada credencial
  const all = (await vaultDb.all<CredentialVersion>('versions')).filter(v => v.credentialId === credentialId).sort(byNewest);
  for (const old of all.slice(MAX_VERSIONS)) await vaultDb.remove('versions', old.id, { silent: true });
}

/** Limites de tamanho dos campos: evitam registros gigantes que travariam o cofre (entrada maliciosa ou colada por engano). */
export const MAX_FOLDER_DEPTH = 10;

/** Quantidade de senhas anteriores guardadas por credencial. */
export const MAX_PASSWORD_HISTORY = 10;

/**
 * Histórico de senhas: quando a senha muda, a anterior entra no topo da lista, a senha atual nunca
 * aparece nela, não há repetidas e ficam só as MAX_PASSWORD_HISTORY mais recentes.
 */
export function pushPasswordHistory(history: PasswordHistoryEntry[], previous: string, current: string, at: string): PasswordHistoryEntry[] {
  const valid = (Array.isArray(history) ? history : []).filter(
    h => h && typeof h.password === 'string' && h.password && h.password.length <= LIMITS.password && typeof h.changedAt === 'string',
  );
  const list = previous && previous !== current ? [{ password: previous, changedAt: at }, ...valid] : valid;
  const seen = new Set<string>([current]);
  const out: PasswordHistoryEntry[] = [];
  for (const h of list) {
    if (seen.has(h.password)) continue;
    seen.add(h.password);
    out.push({ password: h.password, changedAt: h.changedAt });
  }
  return out.slice(0, MAX_PASSWORD_HISTORY);
}

/**
 * a credencial inativa (vencida) volta a ficar ativa quando o usuário troca a senha ou muda a data de
 * validade para o futuro (ou a remove). Trocar a senha mantendo uma data que já passou também reativa: nesse caso
 * a validade vencida é retirada (senão a próxima varredura a desativaria de novo) e o usuário define outra, se quiser.
 */
function reactivateIfRenewed(prev: Credential | null, next: Credential, at = Date.now()): Credential {
  if (!prev || !next.inactive) return next;
  const expired = (iso: string | null) => !!iso && Date.parse(iso) <= at;
  if (prev.expiresAt !== next.expiresAt && !expired(next.expiresAt)) return { ...next, inactive: false };
  if (prev.password !== next.password) return { ...next, inactive: false, expiresAt: expired(next.expiresAt) ? null : next.expiresAt };
  return next;
}

export const LIMITS = { title: 120, username: 256, password: 512, url: 2048, notes: 10000, customFields: 30, fieldLabel: 60, fieldValue: 2048, folderName: 60 };

function validateLimits(c: Credential) {
  const over = (v: unknown, max: number) => String(v ?? '').length > max;
  if (over(c.title, LIMITS.title)) throw new ValidationError(`O título pode ter até ${LIMITS.title} caracteres`);
  if (over(c.username, LIMITS.username)) throw new ValidationError(`O usuário pode ter até ${LIMITS.username} caracteres`);
  if (over(c.password, LIMITS.password)) throw new ValidationError(`A senha pode ter até ${LIMITS.password} caracteres`);
  if (over(c.url, LIMITS.url)) throw new ValidationError(`O endereço pode ter até ${LIMITS.url} caracteres`);
  if (over(c.notes, LIMITS.notes)) throw new ValidationError(`As notas podem ter até ${LIMITS.notes} caracteres`);
  const fields = c.customFields || [];
  if (fields.length > LIMITS.customFields) throw new ValidationError(`Use no máximo ${LIMITS.customFields} campos personalizados`);
  if (fields.some(f => over(f.label, LIMITS.fieldLabel) || over(f.value, LIMITS.fieldValue))) {
    throw new ValidationError('Um campo personalizado está grande demais');
  }
}

export const Repo = {
  // ---------------------------------------------------------------------------
  // Credenciais
  // ---------------------------------------------------------------------------
  async credentials(): Promise<Credential[]> {
    return (await vaultDb.all<Credential>('credentials')).map(normalizeCredential);
  },

  async credential(id: string): Promise<Credential | null> {
    const c = await vaultDb.get<Credential>('credentials', id);
    return c ? normalizeCredential(c) : null;
  },

  /** Cria ou atualiza a credencial e registra uma versão no histórico. */
  async saveCredential(input: Credential, changeType?: ChangeType): Promise<Credential> {
    if (!input.title || !input.title.trim()) throw new ValidationError('O título é obrigatório');
    validateLimits(input);
    const prev = await this.credential(input.id);
    const cred: Credential = reactivateIfRenewed(prev, { ...input, title: input.title.trim(), updatedAt: now() });
    // a base do histórico é o que está gravado (a tela pode ter uma cópia desatualizada)
    cred.passwordHistory = pushPasswordHistory(prev ? prev.passwordHistory : input.passwordHistory, prev?.password ?? '', cred.password, now());
    if (prev && prev.password !== cred.password) cred.passwordChangedAt = now();
    if (!prev) cred.passwordChangedAt = cred.createdAt;
    await vaultDb.put('credentials', cred);

    const type: ChangeType = changeType || (!prev ? 'create' : prev.password !== cred.password ? 'password' : 'update');
    await addVersion(cred.id, type, type === 'restore' ? 'Versão anterior restaurada' : describeChanges(prev, cred), cred);
    changed();
    return cred;
  },

  /** Exclui a credencial e todo o seu histórico de versões. */
  async deleteCredential(id: string): Promise<void> {
    await vaultDb.remove('credentials', id);
    const versions = await this.versions(id);
    for (const v of versions) await vaultDb.remove('versions', v.id, { silent: true });
    changed();
  },

  async versions(credentialId: string): Promise<CredentialVersion[]> {
    const all = await vaultDb.all<CredentialVersion>('versions');
    return all.filter(v => v.credentialId === credentialId).sort(byNewest);
  },

  /** Reverte (rollback) para uma versão anterior; a versão atual continua no histórico. */
  async restoreVersion(version: CredentialVersion): Promise<Credential> {
    const current = await this.credential(version.credentialId);
    const restored: Credential = {
      ...version.snapshot,
      // Estatísticas de uso não voltam no tempo
      usageCount: current?.usageCount ?? version.snapshot.usageCount,
      lastUsedAt: current?.lastUsedAt ?? version.snapshot.lastUsedAt,
      lastUsageAt: current?.lastUsageAt ?? version.snapshot.lastUsageAt ?? null,
      // o histórico de senhas não volta no tempo (a versão restaurada tem uma lista mais antiga)
      passwordHistory: current?.passwordHistory ?? version.snapshot.passwordHistory ?? [],
      // Se a pasta original não existe mais, a credencial volta para a raiz
      folderId: version.snapshot.folderId && (await vaultDb.get<Folder>('folders', version.snapshot.folderId)) ? version.snapshot.folderId : null,
    };
    return this.saveCredential(restored, 'restore');
  },

  async moveCredential(id: string, folderId: string | null): Promise<void> {
    const cred = await this.credential(id);
    if (!cred || cred.folderId === folderId) return;
    if (folderId && !(await vaultDb.get<Folder>('folders', folderId))) throw new ValidationError('A pasta não existe mais.');
    const moved = { ...cred, folderId, updatedAt: now() };
    await vaultDb.put('credentials', moved);
    await addVersion(id, 'move', folderId ? 'Movida para outra pasta' : 'Removida da pasta', moved);
    changed();
  },

  /** Favoritar não é alteração de conteúdo: não gera versão no histórico (que guarda só as últimas 50). */
  async setFavorite(id: string, favorite: boolean): Promise<void> {
    const cred = await this.credential(id);
    if (!cred || !!cred.favorite === favorite) return;
    await vaultDb.put('credentials', { ...cred, favorite, updatedAt: now() });
    changed();
  },

  /** Contador de uso: incrementado a cada cópia de senha (ordenação "Mais usadas"). */
  async recordUsage(id: string, at = now()): Promise<void> {
    const cred = await this.credential(id);
    if (!cred) return;
    await vaultDb.put('credentials', { ...cred, usageCount: (cred.usageCount || 0) + 1, lastUsedAt: at, lastUsageAt: at });
    changed();
  },

  /** Marca/desmarca como inativa (: credencial vencida). Não é alteração de conteúdo: não gera versão. */
  async setInactive(id: string, inactive: boolean): Promise<void> {
    const cred = await this.credential(id);
    if (!cred || cred.inactive === inactive) return;
    await vaultDb.put('credentials', { ...cred, inactive, updatedAt: now() });
    changed();
  },

  /** Marca a credencial como acessada (ordenação "Recentes"). */
  async touch(id: string): Promise<void> {
    const cred = await this.credential(id);
    if (!cred) return;
    await vaultDb.put('credentials', { ...cred, lastUsedAt: now() }, { silent: true });
  },

  // ---------------------------------------------------------------------------
  // Pastas e subpastas
  // ---------------------------------------------------------------------------
  async folders(): Promise<Folder[]> {
    return (await vaultDb.all<Folder>('folders')).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  },

  async saveFolder(folder: Folder): Promise<void> {
    if (!folder.name.trim()) throw new ValidationError('Informe o nome da pasta');
    if (folder.name.trim().length > LIMITS.folderName) throw new ValidationError(`O nome da pasta pode ter até ${LIMITS.folderName} caracteres`);
    const folders = await this.folders();
    if (folder.parentId && this.descendantIds(folders, folder.id).includes(folder.parentId)) {
      throw new ValidationError('Uma pasta não pode ficar dentro de si mesma');
    }
    const sibling = folders.find(
      f => f.id !== folder.id && f.parentId === folder.parentId && f.name.trim().toLowerCase() === folder.name.trim().toLowerCase(),
    );
    if (sibling) throw new ValidationError('Já existe uma pasta com esse nome neste local');
    // Profundidade máxima: nível do novo pai + altura da subárvore que está sendo movida
    const depthOf = (id: string | null): number => {
      let d = 0;
      for (let cur = id; cur && d <= MAX_FOLDER_DEPTH; d++) cur = folders.find(f => f.id === cur)?.parentId ?? null;
      return d;
    };
    const height = (id: string): number => 1 + Math.max(0, ...folders.filter(f => f.parentId === id).map(f => height(f.id)));
    if (depthOf(folder.parentId) + height(folder.id) > MAX_FOLDER_DEPTH) {
      throw new ValidationError(`Use no máximo ${MAX_FOLDER_DEPTH} níveis de subpastas`);
    }
    await vaultDb.put('folders', { ...folder, name: folder.name.trim(), updatedAt: now() });
    changed();
  },

  /** Quantas credenciais existem na pasta e em todas as subpastas. */
  countInFolder(folders: Folder[], creds: Credential[], id: string): number {
    const ids = new Set(this.descendantIds(folders, id));
    return creds.filter(c => c.folderId && ids.has(c.folderId)).length;
  },

  /**
   * Exclui uma pasta.
   *  • mode 'move'  : as credenciais da pasta (e das subpastas) vão para a raiz e as subpastas são removidas.
   *  • mode 'delete': a pasta, as subpastas e todas as credenciais dentro delas são excluídas.
   */
  async deleteFolder(id: string, mode: 'move' | 'delete' = 'move'): Promise<void> {
    const folders = await this.folders();
    if (!folders.find(f => f.id === id)) return;
    const ids = new Set(this.descendantIds(folders, id));
    const creds = (await this.credentials()).filter(c => c.folderId && ids.has(c.folderId));
    for (const c of creds) {
      if (mode === 'delete') {
        await vaultDb.remove('credentials', c.id, { silent: true });
        for (const v of await this.versions(c.id)) await vaultDb.remove('versions', v.id, { silent: true });
      } else {
        const moved = { ...c, folderId: null, updatedAt: now() };
        await vaultDb.put('credentials', moved, { silent: true });
        await addVersion(c.id, 'move', 'Pasta excluída, movida para a raiz', moved);
      }
    }
    for (const fid of ids) await vaultDb.remove('folders', fid, { silent: true });
    changed();
  },

  /** Caminho completo da pasta (ex.: Finanças › Bancos). */
  folderPath(folders: Folder[], id: string | null): string {
    const parts: string[] = [];
    let cur = folders.find(f => f.id === id);
    let guard = 0;
    while (cur && guard++ < 20) {
      parts.unshift(cur.name);
      cur = folders.find(f => f.id === cur!.parentId);
    }
    return parts.join(' › ');
  },

  descendantIds(folders: Folder[], id: string): string[] {
    const out = [id];
    for (const f of folders.filter(x => x.parentId === id)) out.push(...this.descendantIds(folders, f.id));
    return out;
  },
};
