// Verificação de integridade: hash do arquivo cifrado antes do desbloqueio e digest do conteúdo depois
import { AppController } from '../services/AppController';
import { IntegrityService } from '../services/IntegrityService';
import { Vault } from '../services/VaultService';
import { Repo, newCredential } from '../services/Repository';
import { Security } from '../native';
import { bus, Events } from '../services/events';

jest.setTimeout(60000);

const MASTER = 'Integridade#2026';
let fileHash = 'hash-1';
let profileId = '';

beforeAll(async () => {
  jest.spyOn(Security, 'sha256File').mockImplementation(async () => fileHash);
  AppController.init();
  AppController.init(); // idempotente
  profileId = (await Vault.createVault({ masterPassword: MASTER })).profile.id;
  await new Promise(r => setTimeout(r, 50));
});

async function unlock() {
  const checked = new Promise(r => {
    const off = bus.on(Events.INTEGRITY_CHECKED, () => {
      off();
      r(null);
    });
  });
  await Vault.completeUnlock(profileId, await Vault.verifyPassword(profileId, MASTER));
  await checked;
}

it('arquivo inalterado → "ok"; o hash é registrado ao bloquear (banco fechado)', async () => {
  await Repo.saveCredential(newCredential({ title: 'Gmail', password: 'x' }));
  await Vault.lock();
  expect(await Security.secureGet(`p:${profileId}:dbhash`)).toBe('hash-1');
  expect(await IntegrityService.checkFile(profileId)).toBe('ok');
  await unlock();
  expect((await IntegrityService.lastResult())?.ok).toBe(true);
  expect((await IntegrityService.lastResult())?.fileStatus).toBe('ok');
});

it('arquivo alterado com conteúdo íntegro → aviso, sem falha', async () => {
  await Vault.lock();
  fileHash = 'hash-2';
  expect(await IntegrityService.checkFile(profileId)).toBe('mismatch');
  await unlock();
  const r = await IntegrityService.lastResult();
  expect(r?.ok).toBe(true);
  expect(r?.message).toMatch(/conteúdo confere/);
});

it('sem registro anterior → "unknown"', async () => {
  await Vault.lock();
  await Security.secureRemove(`p:${profileId}:dbhash`);
  expect(await IntegrityService.checkFile(profileId)).toBe('unknown');
  await unlock();
  expect(Vault.isUnlocked).toBe(true);
  await Vault.lock();
});
