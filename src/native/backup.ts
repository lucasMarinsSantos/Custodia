// Ponte JS do módulo nativo CustodiaBackup (BackupModule.kt)
//  • Pasta escolhida pelo usuário (SAF, ACTION_OPEN_DOCUMENT_TREE com permissão persistente)
//  • Armazenamento interno do app (quando nenhuma pasta foi escolhida)
//  • Autorização do Google Drive (escopo drive.file) pela Authorization API do Google Identity
// No Jest, tudo funciona em memória.

import { NativeModules } from 'react-native';
import { withExternal } from './transfer';

const M: any = NativeModules || {};

export interface BackupDoc {
  name: string;
  /** content:// (pasta SAF) ou o próprio nome (armazenamento interno). */
  uri: string;
  size: number;
  modified: number;
}

export interface FolderInfo {
  uri: string;
  name: string;
}

/** Erro do módulo quando não há OAuth Client ID Android cadastrado no Google Cloud para o pacote + SHA-1. */
export const DRIVE_NOT_CONFIGURED = 'E_DRIVE_NOT_CONFIGURED';
/** A autorização precisa da interação do usuário (backup automático em segundo plano não pode pedir). */
export const DRIVE_NEEDS_CONSENT = 'E_DRIVE_CONSENT';

// ---------------------------------------------------------------------------
// Simulação em memória (testes)
// ---------------------------------------------------------------------------
const mem = {
  folders: new Map<string, Map<string, { base64: string; modified: number }>>(),
  internal: new Map<string, { base64: string; modified: number }>(),
  nextFolder: null as FolderInfo | null,
  revoked: new Set<string>(),
  driveToken: null as string | null,
  failWrites: false,
};
let clock = 0;
const tick = () => Math.max(Date.now(), ++clock);

/** Apenas para testes. */
export const __backupMock = {
  reset() {
    mem.folders.clear();
    mem.internal.clear();
    mem.nextFolder = null;
    mem.revoked.clear();
    mem.driveToken = null;
    mem.failWrites = false;
  },
  nextFolder(f: FolderInfo | null) {
    mem.nextFolder = f;
  },
  revoke(uri: string) {
    mem.revoked.add(uri);
  },
  setDriveToken(t: string | null) {
    mem.driveToken = t;
  },
  failWrites(v: boolean) {
    mem.failWrites = v;
  },
  folderFiles(uri: string): string[] {
    return [...(mem.folders.get(uri)?.keys() || [])].sort();
  },
};

function list(store: Map<string, { base64: string; modified: number }>, prefix: (n: string) => string): BackupDoc[] {
  return [...store.entries()].map(([name, v]) => ({ name, uri: prefix(name), size: Math.floor((v.base64.length * 3) / 4), modified: v.modified }));
}

function folderStore(uri: string) {
  if (mem.revoked.has(uri)) throw new Error('Sem permissão para a pasta escolhida. Escolha a pasta novamente.');
  let f = mem.folders.get(uri);
  if (!f) {
    f = new Map();
    mem.folders.set(uri, f);
  }
  return f;
}

const sep = '::';

export const BackupNative = {
  /** Abre o seletor de pasta e guarda a permissão persistente. null = cancelado. */
  async pickFolder(): Promise<FolderInfo | null> {
    if (M.CustodiaBackup) return withExternal(() => M.CustodiaBackup.pickFolder());
    const f = mem.nextFolder;
    mem.nextFolder = null;
    return f;
  },

  /** A permissão persistente da pasta ainda vale? (o usuário pode revogá-la nas configurações do Android) */
  async hasFolderPermission(uri: string): Promise<boolean> {
    if (M.CustodiaBackup) return M.CustodiaBackup.hasFolderPermission(uri);
    return !mem.revoked.has(uri);
  },

  async writeToFolder(treeUri: string, name: string, mime: string, base64: string): Promise<string> {
    if (M.CustodiaBackup) return M.CustodiaBackup.writeToFolder(treeUri, name, mime, base64);
    if (mem.failWrites) throw new Error('Falha ao gravar o arquivo');
    folderStore(treeUri).set(name, { base64, modified: tick() });
    return `${treeUri}${sep}${name}`;
  },

  async listFolder(treeUri: string): Promise<BackupDoc[]> {
    if (M.CustodiaBackup) return M.CustodiaBackup.listFolder(treeUri);
    return list(folderStore(treeUri), n => `${treeUri}${sep}${n}`);
  },

  async readDocument(uri: string, maxBytes: number): Promise<string> {
    if (M.CustodiaBackup) return M.CustodiaBackup.readDocument(uri, maxBytes);
    const [tree, name] = uri.split(sep);
    const v = (name ? folderStore(tree).get(name) : mem.internal.get(uri)) || null;
    if (!v) throw new Error('Arquivo de backup não encontrado');
    return v.base64;
  },

  async deleteDocument(uri: string): Promise<void> {
    if (M.CustodiaBackup) return M.CustodiaBackup.deleteDocument(uri);
    const [tree, name] = uri.split(sep);
    if (name) folderStore(tree).delete(name);
    else mem.internal.delete(uri);
  },

  async writeInternal(name: string, base64: string): Promise<string> {
    if (M.CustodiaBackup) return M.CustodiaBackup.writeInternal(name, base64);
    if (mem.failWrites) throw new Error('Falha ao gravar o arquivo');
    mem.internal.set(name, { base64, modified: tick() });
    return name;
  },

  async listInternal(): Promise<BackupDoc[]> {
    if (M.CustodiaBackup) return M.CustodiaBackup.listInternal();
    return list(mem.internal, n => n);
  },

  /** Token de acesso do Google Drive (escopo drive.file). `interactive=false` falha em vez de abrir a tela de consentimento. */
  async driveAuthorize(interactive: boolean): Promise<string> {
    if (M.CustodiaBackup) {
      return interactive ? withExternal(() => M.CustodiaBackup.driveAuthorize(true)) : M.CustodiaBackup.driveAuthorize(false);
    }
    if (!mem.driveToken) {
      const e: any = new Error('Google Drive não configurado');
      e.code = DRIVE_NOT_CONFIGURED;
      throw e;
    }
    return mem.driveToken;
  },
};
