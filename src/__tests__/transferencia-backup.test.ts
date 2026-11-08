// Backup cifrado automático e restauração, com o banco e o módulo nativo em memória
import { Vault } from '../services/VaultService';
import { Repo, newCredential, newFolder } from '../services/Repository';
import { vaultDb } from '../db/Database';
import { AlertService } from '../services/AlertService';
import { BACKUP_DECRYPT_ERROR, BACKUP_EXT, BACKUP_INTEGRITY_ERROR, BACKUP_KEEP, BackupService, DRIVE_NOT_CONFIGURED_MSG, parseBackup } from '../services/BackupService';
import { __backupMock, BackupNative } from '../native/backup';
import { __queuePickedFile } from '../native/transfer';
import { fromB64, fromUtf8, toB64, utf8 } from '../crypto';

jest.setTimeout(180000);

const MASTER = 'Cofre#Seguro2026';
const DAY = 86400000;
let recoveryCode = '';

const readInternal = async (name: string) => fromUtf8(fromB64(await BackupNative.readDocument(name, 1e9)));

beforeAll(async () => {
  recoveryCode = (await Vault.createVault({ masterPassword: MASTER })).recoveryCode;
  const folder = newFolder('Bancos', null);
  await Repo.saveFolder(folder);
  await Repo.saveCredential(newCredential({ title: 'Nubank', username: 'lucas', password: 'Nu#Segura2026!', url: 'https://nubank.com.br', folderId: folder.id }));
  await Repo.saveCredential(newCredential({ title: 'Gmail', username: 'lucas@gmail.com', password: 'G#mail2026!', url: 'https://mail.google.com' }));
});

beforeEach(() => {
  __backupMock.reset();
  BackupService._reset();
});

describe('BDD: Backup criptografado', () => {
  it('Cenário: Exportar arquivo de backup local, "Criar Backup" com a senha mestra gera um arquivo criptografado (.custodia) salvo no armazenamento local', async () => {
    await expect(BackupService.createBackup('senha-errada')).rejects.toThrow('Senha mestra incorreta.');
    const r = await BackupService.createBackup(MASTER);
    expect(r.name.endsWith(BACKUP_EXT)).toBe(true);
    expect(r.destination).toBe('Armazenamento interno do app');
    const docs = await BackupService.list();
    expect(docs.map(d => d.name)).toEqual([r.name]);
    const text = await readInternal(r.name);
    // Criptografado: nada do cofre aparece no arquivo
    for (const secret of ['Nu#Segura2026!', 'G#mail2026!', 'lucas@gmail.com', 'Nubank', 'Bancos']) expect(text).not.toContain(secret);
    expect(parseBackup(text)).toMatchObject({ format: 'custodia-backup', version: 1, cipher: 'AES-256-GCM' });
    expect((await BackupService.status()).lastAt).toBeTruthy();
  });

  it('Cenário: Restaurar de um backup com senha incorreta, exibe "Falha na descriptografia. Senha inválida."', async () => {
    const { json } = await BackupService.build();
    // Novo celular: o arquivo chega pelo seletor do sistema e abre sem depender do Keystore deste aparelho
    __queuePickedFile({ name: 'meu.custodia', mime: 'application/octet-stream', size: json.length, base64: toB64(utf8(json)) });
    const file = await BackupService.pickFile();
    expect(file).not.toBeNull();
    await expect(BackupService.open(file!, 'SenhaMestraIncorreta1!')).rejects.toThrow(BACKUP_DECRYPT_ERROR);
    expect(BACKUP_DECRYPT_ERROR).toBe('Falha na descriptografia. Senha inválida.');
  });
});

describe('Restauração', () => {
  it('pré-visualiza sem gravar e restaura (mesclar) o que foi apagado', async () => {
    const { file } = await BackupService.build();
    const gmail = (await Repo.credentials()).find(c => c.title === 'Gmail')!;
    await Repo.deleteCredential(gmail.id);
    const preview = await BackupService.open(file, MASTER);
    expect(preview.counts).toMatchObject({ credentials: 2, folders: 1 });
    expect(preview.invalid).toBe(0);
    expect((await Repo.credentials()).some(c => c.title === 'Gmail')).toBe(false); // prévia não grava
    const r = await BackupService.restore(preview, 'merge');
    expect(r.written).toBeGreaterThanOrEqual(1);
    const back = (await Repo.credentials()).find(c => c.title === 'Gmail')!;
    expect(back).toMatchObject({ id: gmail.id, password: 'G#mail2026!' });
  });

  it('substituir deixa o cofre igual ao backup', async () => {
    const { file } = await BackupService.build();
    await Repo.saveCredential(newCredential({ title: 'Criada depois', username: 'x', password: 'Depois#2026' }));
    const r = await BackupService.restore(await BackupService.open(file, MASTER), 'replace');
    expect(r.removed).toBe(1);
    expect((await Repo.credentials()).map(c => c.title).sort()).toEqual(['Gmail', 'Nubank']);
  });

  it('o código de recuperação também abre o backup', async () => {
    const { file } = await BackupService.build();
    const preview = await BackupService.open(file, recoveryCode.toLowerCase());
    expect(preview.counts.credentials).toBe(2);
  });

  it('integridade: conteúdo, data ou cabeçalho alterados são recusados', async () => {
    const { file } = await BackupService.build();
    const bytes = fromB64(file.data);
    bytes[bytes.length - 5] = (bytes[bytes.length - 5] + 1) % 256;
    await expect(BackupService.open({ ...file, data: toB64(bytes) }, MASTER)).rejects.toThrow(BACKUP_INTEGRITY_ERROR);
    await expect(BackupService.open({ ...file, createdAt: '2020-01-01T00:00:00.000Z' }, MASTER)).rejects.toThrow(BACKUP_INTEGRITY_ERROR);
    expect(() => parseBackup('não é json')).toThrow('O arquivo não é um backup do Custódia.');
    expect(() => parseBackup(JSON.stringify({ ...file, version: 9 }))).toThrow(/Versão de backup não suportada/);
    // Abuso: iterações absurdas no envelope travariam o app (DoS) e são recusadas antes de derivar
    expect(() => parseBackup(JSON.stringify({ ...file, keys: { ...file.keys, master: { ...file.keys.master, iter: 1e9 } } }))).toThrow('Backup corrompido ou adulterado.');
  });

  it('abuso: documentos inválidos dentro do backup são descartados na prévia', async () => {
    const preview = await BackupService.previewPayload(new Date().toISOString(), {
      credentials: [{ id: 'ok', title: 'Válida', username: 'u', password: 'p' }, { title: 'sem id' }, { id: 'x'.repeat(500) }, 'texto'],
      folders: [{ id: 'f1', name: '' }, { id: 'f2', name: 'Pasta', color: 'url(javascript:alert(1))' }],
    });
    expect(preview.counts).toMatchObject({ credentials: 1, folders: 1 });
    expect(preview.invalid).toBe(4);
    expect(preview.payload.folders[0].color).toBe('#0D9488');
  });

  it('senha mestra trocada: o backup antigo abre com a senha do dia do backup', async () => {
    const { file } = await BackupService.build();
    const NEW = 'Nova#Senha2027!';
    await Vault.changeMasterPassword(MASTER, NEW);
    try {
      await expect(BackupService.open(file, NEW)).rejects.toThrow(BACKUP_DECRYPT_ERROR);
      await expect(BackupService.open(file, MASTER)).resolves.toBeTruthy();
    } finally {
      await Vault.changeMasterPassword(NEW, MASTER);
    }
  });
});

describe('Backup automático, destino e retenção', () => {
  it(`mantém só os ${BACKUP_KEEP} mais recentes`, async () => {
    for (let i = 0; i < BACKUP_KEEP + 2; i++) await BackupService.run();
    expect((await BackupService.list()).length).toBe(BACKUP_KEEP);
  });

  it('vence a cada 7 dias (configurável) e roda no desbloqueio', async () => {
    await BackupService.run();
    const last = Date.parse((await BackupService.lastBackupAt())!);
    expect(await BackupService.isDue(last + 6 * DAY)).toBe(false);
    expect(await BackupService.isDue(last + 7 * DAY)).toBe(true);
    await Vault.updateSettings({ backupIntervalDays: 3 });
    expect(await BackupService.isDue(last + 3 * DAY)).toBe(true);
    await Vault.updateSettings({ autoBackup: false });
    expect(await BackupService.isDue(last + 30 * DAY)).toBe(false);
    await Vault.updateSettings({ autoBackup: true, backupIntervalDays: 7 });
    await vaultDb.setKv('backup:lastAt', new Date(Date.now() - 8 * DAY).toISOString());
    expect(await BackupService.autoBackupIfDue()).toBe(true);
    expect(await BackupService.autoBackupIfDue()).toBe(false); // acabou de fazer
  });

  it('falha no backup automático vira alerta e não lança', async () => {
    await vaultDb.setKv('backup:lastAt', new Date(Date.now() - 8 * DAY).toISOString());
    __backupMock.failWrites(true);
    await expect(BackupService.autoBackupIfDue()).resolves.toBe(false);
    const alerts = await AlertService.list();
    expect(alerts.some(a => a.type === 'backup' && a.title === 'Falha no backup automático')).toBe(true);
    expect((await BackupService.status()).lastError).toMatch(/Falha ao gravar/);
  });

  it('pasta escolhida pelo usuário (SAF) e volta ao armazenamento interno', async () => {
    __backupMock.nextFolder({ uri: 'content://tree/backups', name: 'Backups' });
    expect(await BackupService.chooseFolder()).toBe(true);
    const r = await BackupService.run();
    expect(r.destination).toBe('Backups');
    expect(__backupMock.folderFiles('content://tree/backups')).toEqual([r.name]);
    __backupMock.revoke('content://tree/backups');
    await expect(BackupService.run()).rejects.toThrow(/Escolha a pasta novamente/);
    await BackupService.selectInternal();
    expect((await BackupService.status()).destination).toBe('internal');
  });
});

describe('Google Drive (escopo drive.file)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('sem OAuth configurado: o backup local é feito e o Drive fica "não configurado"', async () => {
    await Vault.updateSettings({ googleDriveBackup: true });
    const r = await BackupService.run();
    expect(r.drive).toBe('not_configured');
    expect((await BackupService.list()).length).toBe(1);
    expect((await BackupService.status()).drive).toMatchObject({ state: 'not_configured', error: DRIVE_NOT_CONFIGURED_MSG });
    await Vault.updateSettings({ googleDriveBackup: false });
  });

  it('envia por upload multipart com o token, só por HTTPS e sem dados do cofre na URL', async () => {
    __backupMock.setDriveToken('tok-123');
    const calls: { url: string; init: any }[] = [];
    global.fetch = jest.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      if (init?.method === 'POST') return { ok: true, status: 200, json: async () => ({ id: 'abc' }) } as any;
      return { ok: true, status: 200, json: async () => ({ files: [] }) } as any;
    }) as any;
    await Vault.updateSettings({ googleDriveBackup: true });
    const r = await BackupService.run();
    await Vault.updateSettings({ googleDriveBackup: false });
    expect(r.drive).toBe('ok');
    const upload = calls.find(c => c.init?.method === 'POST')!;
    expect(upload.url).toBe('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id');
    expect(upload.init.headers.Authorization).toBe('Bearer tok-123');
    expect(upload.init.headers['Content-Type']).toMatch(/^multipart\/related; boundary=/);
    expect(upload.init.body).toContain(r.name);
    expect(upload.init.body).not.toContain('Nu#Segura2026!');
    for (const c of calls) {
      expect(c.url.startsWith('https://')).toBe(true);
      expect(c.url).not.toContain('Nubank');
    }
  });

  it('erro do Drive gera alerta, mas o backup local continua valendo', async () => {
    __backupMock.setDriveToken('tok-123');
    global.fetch = jest.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as any;
    await Vault.updateSettings({ googleDriveBackup: true });
    const r = await BackupService.run();
    await Vault.updateSettings({ googleDriveBackup: false });
    expect(r.drive).toBe('error');
    expect((await BackupService.list()).length).toBe(1);
    expect((await AlertService.list()).some(a => a.title === 'Falha ao enviar o backup ao Google Drive')).toBe(true);
  });

  it('salvar uma cópia pelo seletor do Android (SAF) exige a senha mestra', async () => {
    await expect(BackupService.saveCopy('errada')).rejects.toThrow('Senha mestra incorreta.');
    // Sem módulo nativo (Jest), o seletor devolve false (cancelado)
    await expect(BackupService.saveCopy(MASTER)).resolves.toBe(false);
  });
});
