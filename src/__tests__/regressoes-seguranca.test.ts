// Regressões de segurança entre os módulos
import { Vault } from '../services/VaultService';
import { Repo, newCredential } from '../services/Repository';
import { vaultDb } from '../db/Database';
import { BackupService } from '../services/BackupService';
import { ImportService } from '../services/ImportService';
import { __backupMock } from '../native/backup';

jest.setTimeout(180000);

const MASTER = 'Cofre#Seguro2026';

beforeAll(async () => {
  await Vault.createVault({ masterPassword: MASTER });
  await Repo.saveCredential(newCredential({ title: 'Gmail', username: 'a@gmail.com', password: 'G#mail2026!', url: 'https://mail.google.com' }));
});

beforeEach(() => {
  __backupMock.reset();
  BackupService._reset();
});

describe('Operações assíncronas × bloqueio/troca de perfil', () => {
  it('a restauração de backup não grava depois do bloqueio nem em outro perfil', async () => {
    const { name } = await BackupService.createBackup(MASTER);
    const preview = await BackupService.open(await BackupService.readDocument(name), MASTER);
    const before = (await vaultDb.all('credentials')).length;
    await Vault.lock('teste');
    await expect(BackupService.restore(preview, 'replace')).rejects.toThrow('Cofre bloqueado');
    // Outro perfil aberto: a prévia do primeiro não vale
    const other = await Vault.createProfile({ name: 'Trabalho', masterPassword: MASTER + 'x' });
    expect(other.profile.id).not.toBe(preview.profileId);
    await expect(BackupService.restore(preview, 'replace')).rejects.toThrow('Cofre bloqueado');
    expect((await vaultDb.all('credentials')).length).toBe(0);
    expect(before).toBeGreaterThan(0);
  });

  it('a importação não grava depois do bloqueio nem em outro perfil', async () => {
    const parsed = ImportService.read('name,url,username,password\nX,https://x.com,u,Senha#Forte2026!\n');
    if (parsed.kind !== 'parsed') throw new Error('esperado parsed');
    const preview = await ImportService.preview(parsed.parsed, 'x.csv');
    await Vault.lock('teste');
    await expect(ImportService.apply(preview, 'skip')).rejects.toThrow(/bloqueado/);
    const profiles = await Vault.listProfiles();
    expect(profiles.length).toBe(2);
  });
});

describe('Sincronização × bloqueio durante o desbloqueio', () => {
  it('bloquear enquanto a chave é lida não deixa a sincronização ativa nem a chave em memória', async () => {
    const { SyncService } = require('../services/SyncService');
    const { Security } = require('../native');
    const { toB64 } = require('../crypto');
    const profiles = await Vault.listProfiles();
    const id = profiles[0].id;
    const dek = await Vault.verifyPassword(id, MASTER);
    await Security.secureSet(`p:${id}:syncAccount`, JSON.stringify({ accountId: 'a', deviceId: 'd', deviceName: 'x', serverUrl: 'https://s.example', connectedAt: '', lastSyncAt: null }));
    await Security.secureSet(`p:${id}:syncKey`, toB64(new Uint8Array(32).fill(7)));
    expect(await Vault.completeUnlock(id, dek)).toBe('unlocked');
    SyncService.stop();
    const real = Security.secureGet.bind(Security);
    const spy = jest.spyOn(Security, 'secureGet').mockImplementation((async (k: string) => {
      const v = await real(k);
      if (k.endsWith(':syncKey')) await Vault.lock('teste');
      return v;
    }) as any);
    await SyncService.onUnlocked();
    spy.mockRestore();
    expect(SyncService.engine).toBeNull();
    expect(SyncService.key).toBeNull();
  });
});

describe('Preenchimento automático × bloqueio durante a montagem do índice', () => {
  it('o índice montado depois do bloqueio não é publicado no serviço nativo', async () => {
    const { AutofillService } = require('../services/AutofillService');
    const { __integrationMocks } = require('../native/integration');
    const id = (await Vault.listProfiles())[0].id;
    const dek = await Vault.verifyPassword(id, MASTER);
    await Vault.completeUnlock(id, dek);
    await Vault.updateSettings({ autofillEnabled: true });
    __integrationMocks.autofill.index = [];
    const spy = jest.spyOn(AutofillService, 'buildIndex').mockImplementation(async () => {
      await Vault.lock('teste');
      return [{ id: 'x', title: 'Banco secreto', hosts: ['banco.com'], associated: [], packages: [] }];
    });
    await AutofillService.syncIndex();
    spy.mockRestore();
    expect(__integrationMocks.autofill.index).toEqual([]);
  });
});

describe('Backup × perfis', () => {
  it('a retenção de um perfil não apaga nem lista os backups de outro perfil', async () => {
    const { BACKUP_KEEP } = require('../services/BackupService');
    const { BackupNative } = require('../native/backup');
    const first = (await Vault.listProfiles())[0].id;
    const dek = await Vault.verifyPassword(first, MASTER);
    await Vault.completeUnlock(first, dek);
    const mine = await BackupService.run();
    await Vault.createProfile({ name: 'Outro perfil', masterPassword: MASTER + 'y' });
    for (let i = 0; i < BACKUP_KEEP + 1; i++) await BackupService.run();
    const listed = (await BackupService.list()).map((d: any) => d.name);
    expect(listed).not.toContain(mine.name);
    expect(listed.length).toBe(BACKUP_KEEP);
    // O arquivo do primeiro perfil continua no armazenamento
    expect((await BackupNative.listInternal()).map((d: any) => d.name)).toContain(mine.name);
  });
});
