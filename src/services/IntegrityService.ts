// Verificação de integridade do banco de dados
// Ao iniciar, calcula o SHA-256 do arquivo SQLCipher cifrado e compara com o hash registrado
// na última escrita (guardado fora do banco, em preferências protegidas pelo Keystore).
// Após o desbloqueio, executa PRAGMA integrity_check e compara o digest do conteúdo.

import { vaultDb, VaultDatabase } from '../db/Database';
import { Security } from '../native';

let debounce: any = null;
let unsub: (() => void) | null = null;
let pendingFileHash: Promise<void> | null = null;
let preUnlock: { status: 'ok' | 'mismatch' | 'unknown'; profileId: string } | null = null;

const key = (profileId: string, name: string) => `p:${profileId}:${name}`;

async function record() {
  const profileId = vaultDb.profileId;
  if (!vaultDb.isOpen || !profileId) return;
  try {
    const digest = await vaultDb.contentDigest();
    await Security.secureSet(key(profileId, 'digest'), digest);
    const fileHash = await Security.sha256File(VaultDatabase.fileName(profileId));
    if (fileHash) await Security.secureSet(key(profileId, 'dbhash'), fileHash);
  } catch (e) {
    console.warn('[Integrity] record', e);
  }
}

export const IntegrityService = {
  /** Antes do desbloqueio: compara o hash do arquivo cifrado com o registrado. */
  async checkFile(profileId: string): Promise<'ok' | 'mismatch' | 'unknown'> {
    // Logo após um bloqueio o banco ainda está sendo fechado e o hash do arquivo, registrado
    for (let i = 0; i < 30 && vaultDb.isOpen; i++) await new Promise(r => setTimeout(r, 100));
    if (pendingFileHash) await pendingFileHash.catch(() => {});
    const stored = await Security.secureGet(key(profileId, 'dbhash'));
    const current = await Security.sha256File(VaultDatabase.fileName(profileId)).catch(() => null);
    const status = !stored || !current ? 'unknown' : stored === current ? 'ok' : 'mismatch';
    preUnlock = { status, profileId };
    return status;
  },

  /** Após o desbloqueio: integridade estrutural + digest do conteúdo. */
  async checkAfterUnlock(): Promise<{ ok: boolean; message: string }> {
    const profileId = vaultDb.profileId!;
    const structural = await vaultDb.integrityCheck().catch(() => 'erro');
    const stored = await Security.secureGet(key(profileId, 'digest'));
    const digest = await vaultDb.contentDigest();
    const fileChanged = preUnlock?.profileId === profileId && preUnlock.status === 'mismatch';
    const contentChanged = !!stored && stored !== digest;
    let ok = true;
    let message = 'Banco íntegro';
    if (structural !== 'ok') {
      ok = false;
      message = `O banco de dados apresenta corrupção (${structural}).`;
    } else if (contentChanged) {
      ok = false;
      message = 'O conteúdo do banco não corresponde ao hash registrado: ele pode ter sido alterado externamente ou restaurado de outra cópia.';
    } else if (fileChanged) {
      message = 'O arquivo foi modificado após o último registro, mas o conteúdo confere (provável encerramento inesperado do app).';
    }
    await vaultDb.setKv('lastIntegrityCheck', JSON.stringify({ at: new Date().toISOString(), ok, message, fileStatus: preUnlock?.status || 'unknown' }));
    if (!stored || (ok && fileChanged)) await record();
    // Divergência só do arquivo já conciliada (conteúdo confere): novas verificações na sessão não repetem o alerta
    if (ok && preUnlock?.profileId === profileId) preUnlock = { status: 'ok', profileId };
    return { ok, message };
  },

  async lastResult(): Promise<{ at: string; ok: boolean; message: string; fileStatus: string } | null> {
    const raw = vaultDb.isOpen ? await vaultDb.getKv('lastIntegrityCheck') : null;
    return raw ? JSON.parse(raw) : null;
  },

  start() {
    unsub?.();
    unsub = vaultDb.onAnyWrite(() => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(record, 400);
    });
  },

  /** Com o banco fechado, o arquivo cifrado é estável: registra seu SHA-256. */
  recordFileHash(profileId: string): Promise<void> {
    pendingFileHash = (async () => {
      const fileHash = await Security.sha256File(VaultDatabase.fileName(profileId)).catch(() => null);
      if (fileHash) await Security.secureSet(key(profileId, 'dbhash'), fileHash);
    })();
    return pendingFileHash;
  },

  async flush() {
    if (debounce) clearTimeout(debounce);
    debounce = null;
    await record();
  },

  stop() {
    unsub?.();
    unsub = null;
  },
};
