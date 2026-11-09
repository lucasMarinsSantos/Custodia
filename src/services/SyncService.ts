// Sincronização entre aparelhos
//
// Visão geral (detalhes em sync/crdt.ts, sync/engine.ts, sync/http.ts e crypto/sync.ts):
//  • CRDT: LWW-Map por documento com granularidade por campo e relógio lógico híbrido (HLC). Editar a senha num
//    aparelho e o título no outro não perde nada. Exclusão × edição concorrente: a edição vence.
//  • Ponta a ponta: cada documento vai cifrado (AES-256-GCM, AAD = coleção + id) pela chave de sincronização.
//    O servidor só guarda blocos opacos e nunca recebe a senha mestra, a DEK nem a chave de sincronização.
//  • Pareamento: o aparelho A mostra o código (chave em base32 com verificação); o aparelho B digita ou cola.
//  • Sincroniza credentials, folders, notes e forms (USER_COLLECTIONS). Histórico de versões e logs ficam locais.
//  • Quando: no desbloqueio, a cada 5 min com o cofre aberto, alguns segundos depois de cada alteração e em
//    "Sincronizar agora".
//
// Onde fica cada coisa: a chave de sincronização e a conta ficam nas preferências cifradas pelo Keystore (por
// perfil); os metadados do CRDT, a fila e o cursor ficam no kv do banco SQLCipher.

import { Platform } from 'react-native';
import { fromB64, randomBytes, toB64, toHex, wipe } from '../crypto';
import { decodePairingCode, deriveSyncAccount, encodePairingCode, generateSyncKey } from '../crypto/sync';
import { vaultDb, WriteEvent } from '../db/Database';
import { Security } from '../native';
import { AlertService } from './AlertService';
import { bus, Events } from './events';
import { afterIntegrityCheck } from './unlockGate';
import { Vault } from './VaultService';
import { HybridClock } from './sync/crdt';
import { SyncEngine, SyncResult } from './sync/engine';
import { RemoteDevice, SyncHttpClient, SyncHttpError, validateServerUrl } from './sync/http';

export { validateServerUrl, SyncHttpError } from './sync/http';
export type { SyncResult } from './sync/engine';

/** Intervalo da sincronização automática com o cofre aberto. */
export const AUTO_SYNC_MINUTES = 5;
/** Espera depois de uma alteração local (agrupa várias edições em um envio). */
export const WRITE_DEBOUNCE_MS = 3000;
/** Evento do barramento com o estado da sincronização (para a tela). */
export const SYNC_STATUS_EVENT = 'syncStatus';

const MSG_NOT_CONNECTED = 'Este aparelho não está conectado à sincronização.';
const MSG_LOCKED = 'Desbloqueie o cofre para sincronizar.';

export interface SyncAccount {
  accountId: string;
  deviceId: string;
  deviceName: string;
  serverUrl: string;
  connectedAt: string;
  lastSyncAt: string | null;
}

export interface SyncStatus {
  connected: boolean;
  enabled: boolean;
  syncing: boolean;
  account: SyncAccount | null;
  lastSyncAt: string | null;
  lastError: string | null;
  /** A última falha foi de rede (servidor fora do ar, sem internet ou tempo esgotado). */
  offline: boolean;
  lastResult: SyncResult | null;
  pending: number;
}

const prefKey = (profileId: string, name: string) => `p:${profileId}:${name}`;

/** Nome padrão do aparelho (modelo informado pelo Android). */
export function defaultDeviceName(): string {
  const c: any = (Platform as any).constants || {};
  const model = typeof c.Model === 'string' && c.Model.trim() ? c.Model.trim() : 'Android';
  return model.slice(0, 60);
}

class SyncServiceImpl {
  private engine: SyncEngine | null = null;
  private client: SyncHttpClient | null = null;
  private key: Uint8Array | null = null;
  private unsubscribe: (() => void) | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;
  private syncing = false;
  private lastError: string | null = null;
  private offline = false;
  private lastResult: SyncResult | null = null;
  private account: SyncAccount | null = null;
  /** Para testes: substitui o fetch global. */
  fetchImpl: typeof fetch | undefined;

  /** Liga a sincronização ao ciclo de vida do cofre (chamado por AppController.init). */
  init() {
    if (this.initialized) return;
    this.initialized = true;
    bus.on(Events.UNLOCKED, () => {
      this.onUnlocked().catch(e => this.fail(e));
    });
    bus.on(Events.LOCKED, () => this.stop());
  }

  // ---------------------------------------------------------------------------
  // Estado
  // ---------------------------------------------------------------------------
  private profileId(): string {
    const p = Vault.currentProfile;
    if (!p || !Vault.isUnlocked) throw new Error(MSG_LOCKED);
    return p.id;
  }

  async getAccount(): Promise<SyncAccount | null> {
    const p = Vault.currentProfile;
    if (!p) return null;
    const raw = await Security.secureGet(prefKey(p.id, 'syncAccount'));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private async saveAccount(acc: SyncAccount) {
    this.account = acc;
    await Security.secureSet(prefKey(this.profileId(), 'syncAccount'), JSON.stringify(acc));
  }

  async status(): Promise<SyncStatus> {
    const account = this.account || (await this.getAccount());
    const pending = this.engine && vaultDb.isOpen ? (await this.engine.pending().catch(() => [])).length : 0;
    return {
      connected: !!account,
      enabled: !!account && Vault.settings.syncEnabled,
      syncing: this.syncing,
      account,
      lastSyncAt: account?.lastSyncAt ?? null,
      lastError: this.lastError,
      offline: this.offline,
      lastResult: this.lastResult,
      pending,
    };
  }

  private publish() {
    bus.emit(SYNC_STATUS_EVENT);
  }

  private setError(e: unknown) {
    this.lastError = String((e as Error)?.message || e);
    this.offline = e instanceof SyncHttpError && (e.code === 'network' || e.code === 'timeout');
  }

  private fail(e: unknown) {
    this.setError(e);
    console.warn('[Sync]', this.lastError);
    this.publish();
  }

  // ---------------------------------------------------------------------------
  // Conexão
  // ---------------------------------------------------------------------------
  private makeClient(serverUrl: string, key: Uint8Array, deviceId: string, deviceName: string) {
    const { accountId, authSecret } = deriveSyncAccount(key);
    return new SyncHttpClient(serverUrl, { accountId, authSecret, device: { id: deviceId, name: deviceName } }, { fetch: this.fetchImpl });
  }

  private async connect(serverUrl: string, key: Uint8Array, deviceName: string, create: boolean): Promise<SyncAccount> {
    const profileId = this.profileId();
    if (await this.getAccount()) throw new Error('Este aparelho já está conectado. Desconecte antes de usar outra conta.');
    const url = validateServerUrl(serverUrl);
    const name = deviceName.trim().slice(0, 60) || defaultDeviceName();
    const deviceId = toHex(randomBytes(8));
    const client = this.makeClient(url, key, deviceId, name);
    await client.health();
    if (create) await client.register();
    await client.login();
    // Conectado: a chave só é gravada depois que o servidor aceitou a conta.
    await Security.secureSet(prefKey(profileId, 'syncKey'), toB64(key));
    const acc: SyncAccount = {
      accountId: deriveSyncAccount(key).accountId,
      deviceId,
      deviceName: name,
      serverUrl: url,
      connectedAt: new Date().toISOString(),
      lastSyncAt: null,
    };
    await this.saveAccount(acc);
    await Vault.updateSettings({ syncEnabled: true, serverUrl: url });
    this.lastError = null;
    this.offline = false;
    await this.start(acc, key, client);
    return acc;
  }

  /** Aparelho A: cria a conta de sincronização e devolve o código de pareamento. */
  async createAccount(serverUrl: string, deviceName = defaultDeviceName()): Promise<{ account: SyncAccount; pairingCode: string }> {
    const key = generateSyncKey();
    const pairingCode = encodePairingCode(key);
    const account = await this.connect(serverUrl, key, deviceName, true);
    // A primeira sincronização envia o cofre; uma falha aqui não desfaz a conta (fica no status da tela).
    await this.syncNow().catch(e => this.fail(e));
    return { account, pairingCode };
  }

  /** Aparelho B: entra na conta com o código de pareamento mostrado no aparelho A. */
  async pairDevice(serverUrl: string, code: string, deviceName = defaultDeviceName()): Promise<SyncAccount> {
    const key = decodePairingCode(code);
    let account: SyncAccount;
    try {
      account = await this.connect(serverUrl, key, deviceName, false);
    } catch (e) {
      wipe(key);
      throw e;
    }
    await this.syncNow();
    return account;
  }

  /** Código de pareamento da conta atual (para mostrar no aparelho A). */
  async pairingCode(): Promise<string> {
    const raw = await Security.secureGet(prefKey(this.profileId(), 'syncKey'));
    if (!raw) throw new Error(MSG_NOT_CONNECTED);
    const key = fromB64(raw);
    try {
      return encodePairingCode(key);
    } finally {
      wipe(key);
    }
  }

  private async loadKey(profileId: string): Promise<Uint8Array | null> {
    const raw = await Security.secureGet(prefKey(profileId, 'syncKey'));
    return raw ? fromB64(raw) : null;
  }

  // ---------------------------------------------------------------------------
  // Ciclo de vida
  // ---------------------------------------------------------------------------
  private async onUnlocked() {
    const profileId = this.profileId();
    const acc = await this.getAccount();
    if (!acc) return;
    const key = await this.loadKey(profileId);
    if (!key) return;
    // A sincronização grava no banco: espera a verificação de integridade do desbloqueio terminar,
    // senão o conteúdo muda no meio dela e o app acusa uma adulteração que não houve
    await afterIntegrityCheck();
    // Bloqueou (ou trocou de perfil) enquanto a chave era lida: a chave não pode ficar viva num cofre fechado
    if (!Vault.isUnlocked || Vault.currentProfile?.id !== profileId) {
      wipe(key);
      return;
    }
    await this.start(acc, key, this.makeClient(acc.serverUrl, key, acc.deviceId, acc.deviceName));
    if (Vault.settings.syncEnabled) await this.syncNow().catch(e => this.fail(e));
  }

  private async start(acc: SyncAccount, key: Uint8Array, client: SyncHttpClient) {
    this.stop();
    this.account = acc;
    this.key = key;
    this.client = client;
    const engine = new SyncEngine(vaultDb, client, key, new HybridClock(acc.deviceId));
    await engine.init();
    this.engine = engine;
    this.unsubscribe = vaultDb.onWrite(e => this.onLocalWrite(e));
    this.interval = setInterval(() => {
      if (Vault.isUnlocked && Vault.settings.syncEnabled) this.syncNow().catch(err => this.fail(err));
    }, AUTO_SYNC_MINUTES * 60 * 1000);
    this.publish();
  }

  private onLocalWrite(e: WriteEvent) {
    const engine = this.engine;
    if (!engine) return;
    engine
      .recordWrite(e)
      .then(changed => {
        if (changed) this.schedule();
      })
      .catch(err => this.fail(err));
  }

  private schedule() {
    if (!Vault.settings.syncEnabled) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.syncNow().catch(e => this.fail(e));
    }, WRITE_DEBOUNCE_MS);
  }

  /** Ao bloquear: para os temporizadores e apaga a chave da memória. */
  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.interval) clearInterval(this.interval);
    if (this.debounce) clearTimeout(this.debounce);
    this.interval = null;
    this.debounce = null;
    this.client?.forget();
    this.client = null;
    this.engine = null;
    if (this.key) wipe(this.key);
    this.key = null;
    this.account = null;
  }

  // ---------------------------------------------------------------------------
  // Operações
  // ---------------------------------------------------------------------------
  /** Sincroniza agora (pull + push). Lança o erro para a tela mostrar. */
  async syncNow(): Promise<SyncResult> {
    const engine = this.engine;
    if (!engine || !this.account) throw new Error(Vault.isUnlocked ? MSG_NOT_CONNECTED : MSG_LOCKED);
    this.syncing = true;
    this.publish();
    try {
      await engine.reconcile();
      const result = await engine.sync();
      if (this.engine !== engine) throw new Error(MSG_LOCKED);
      this.lastResult = result;
      this.lastError = result.warning;
      this.offline = false;
      await this.saveAccount({ ...this.account, lastSyncAt: new Date().toISOString() });
      if (result.applied) bus.emit(Events.DATA_CHANGED);
      return result;
    } catch (e) {
      await this.handleError(e);
      throw e;
    } finally {
      this.syncing = false;
      this.publish();
    }
  }

  private async handleError(e: unknown) {
    this.setError(e);
    if (e instanceof SyncHttpError && e.code === 'device_revoked') {
      // Revogado em outro aparelho: desliga a sincronização aqui e avisa nos alertas de segurança.
      await AlertService.raise({
        type: 'sync',
        severity: 'warning',
        title: 'Aparelho desconectado da sincronização',
        message: 'Outro aparelho removeu este da conta de sincronização. Os dados locais continuam aqui.',
      }).catch(() => null);
      await this.disconnect({ revoke: false }).catch(() => undefined);
      this.lastError = e.message;
    }
  }

  async listDevices(): Promise<RemoteDevice[]> {
    if (!this.client) throw new Error(MSG_NOT_CONNECTED);
    return this.client.devices();
  }

  async revokeDevice(deviceId: string): Promise<void> {
    if (!this.client || !this.account) throw new Error(MSG_NOT_CONNECTED);
    if (deviceId === this.account.deviceId) throw new Error('Para remover este aparelho, use "Desconectar este aparelho".');
    await this.client.revokeDevice(deviceId);
  }

  /** Liga/desliga a sincronização automática sem desconectar a conta. */
  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled && !(await this.getAccount())) throw new Error(MSG_NOT_CONNECTED);
    await Vault.updateSettings({ syncEnabled: enabled });
    this.publish();
    if (enabled) this.schedule();
  }

  /**
   * Desconecta este aparelho: revoga-o no servidor (quando possível), apaga a chave, a conta e os metadados.
   * Os dados do cofre continuam no aparelho. Com `deleteServerData`, apaga também a conta no servidor.
   */
  async disconnect(opts: { revoke?: boolean; deleteServerData?: boolean } = {}): Promise<void> {
    const profileId = this.profileId();
    const acc = await this.getAccount();
    const client = this.client;
    let remoteError: unknown = null;
    if (acc && client && opts.revoke !== false) {
      try {
        if (opts.deleteServerData) await client.deleteAccount();
        else await client.revokeDevice(acc.deviceId);
      } catch (e) {
        remoteError = e;
      }
    }
    const engine = this.engine;
    this.stop();
    if (engine) await engine.clear();
    else if (vaultDb.isOpen) await vaultDb.removeKvPrefix('sync:');
    await Security.secureRemove(prefKey(profileId, 'syncKey'));
    await Security.secureRemove(prefKey(profileId, 'syncAccount'));
    this.account = null;
    this.lastResult = null;
    this.lastError = null;
    this.offline = false;
    await Vault.updateSettings({ syncEnabled: false });
    this.publish();
    if (remoteError && opts.deleteServerData) {
      throw new Error(`Desconectado deste aparelho, mas não foi possível apagar os dados do servidor: ${String((remoteError as Error).message || remoteError)}`);
    }
  }
}

export const SyncService = new SyncServiceImpl();
