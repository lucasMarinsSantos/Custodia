// Conta: 2FA no desbloqueio, troca da DEK na recuperação,
// regras de segurança por pasta e perfis, com o banco em memória (jest/opSqliteMock.js).
import { Vault, BACKUP_CODE_COUNT, MAX_FAILURES, normalizePhrase, normalizeRecoveryCode, _test } from '../services/VaultService';
import { TotpService } from '../services/TotpService';
import { Repo, newCredential, newFolder } from '../services/Repository';
import { FolderRulesService } from '../services/FolderRulesService';
import { PolicyService } from '../services/PolicyService';
import { ClipboardService } from '../services/ClipboardService';
import { vaultDb } from '../db/Database';
import { Security } from '../native';
import { AuthAttemptEvent, bus, Events } from '../services/events';
import { toHex } from '../crypto';
import { encodeQr } from '../utils/qrcode';

jest.setTimeout(300000);

const MASTER = 'Cofre#Seguro2026';
const sqlite = require('@op-engineering/op-sqlite');

let now = Date.UTC(2026, 10, 3, 12, 0, 0);
const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
const advance = (ms: number) => {
  now += ms;
};

let secret = '';
let backup: string[] = [];
const attempts: AuthAttemptEvent[] = [];
bus.on(Events.AUTH_ATTEMPT, (e: AuthAttemptEvent) => attempts.push(e));

async function opensWith(profileId: string, dek: Uint8Array): Promise<boolean> {
  const db = sqlite.open({ name: `custodia_${profileId}.sqlite`, encryptionKey: toHex(dek) });
  try {
    await db.execute('SELECT count(*) FROM sqlite_master');
    return true;
  } catch {
    return false;
  }
}

const keysOf = async (id: string) => JSON.parse((await Security.secureGet(`p:${id}:keys`))!);

afterAll(async () => {
  clock.mockRestore();
  await ClipboardService.clearNow();
});

describe(': verificação em duas etapas (TOTP) para abrir o cofre', () => {
  let pid = '';

  it('ativação: segredo de 160 bits em QR Code otpauth:// e em Base32, confirmado com código e senha', async () => {
    pid = (await Vault.createVault({ name: 'Pessoal', masterPassword: MASTER })).profile.id;
    await Repo.saveCredential(newCredential({ title: 'Gmail', username: 'eu', password: 'Gm@il#Segura2026' }));
    const setup = await Vault.beginTwoFactorSetup();
    secret = setup.secret;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/); // 20 bytes = 160 bits
    expect(setup.uri).toBe(`otpauth://totp/Cust%C3%B3dia:Pessoal?secret=${secret}&issuer=Cust%C3%B3dia`);
    expect(encodeQr(setup.uri).size).toBeGreaterThan(21);
    const parsed = TotpService.parseUri(setup.uri);
    expect(parsed).toMatchObject({ secret, issuer: 'Custódia', account: 'Pessoal', digits: 6, period: 30 });

    await expect(Vault.confirmTwoFactorSetup(MASTER, '000000')).rejects.toThrow('Código de verificação inválido');
    await expect(Vault.confirmTwoFactorSetup('Errada#Senha2026', TotpService.generate(secret))).rejects.toThrow('Senha mestra incorreta');
    expect(await Vault.isTwoFactorEnabled(pid)).toBe(false);
    backup = await Vault.confirmTwoFactorSetup(MASTER, TotpService.generate(secret));
    expect(backup).toHaveLength(BACKUP_CODE_COUNT);
    expect(new Set(backup).size).toBe(BACKUP_CODE_COUNT);
    expect(await Vault.isTwoFactorEnabled(pid)).toBe(true);
    // O segredo e os códigos de reserva não ficam legíveis nas preferências: só cifrados com a DEK
    const raw = (await Security.secureGet(`p:${pid}:keys`))!;
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(backup[0]);
    expect(await Vault.getTwoFactorStatus()).toMatchObject({ enabled: true, backupCodesLeft: BACKUP_CODE_COUNT, allowBiometric: true });
  });

  it('a senha sozinha não abre: pede o código; recusa código errado e o código já usado (anti-replay)', async () => {
    await Vault.lock();
    const dek = await Vault.verifyPassword(pid, MASTER);
    expect(await Vault.completeUnlock(pid, dek, 'password')).toBe('second_factor');
    expect(Vault.isUnlocked).toBe(false);
    expect(Vault.pendingSecondFactorProfile).toBe(pid);
    attempts.length = 0;
    await expect(Vault.verifySecondFactor('123')).rejects.toThrow('inválido');
    // O código da ativação (mesma janela de 30 s) não vale de novo
    await expect(Vault.verifySecondFactor(TotpService.generate(secret))).rejects.toThrow('já foi usado');
    expect(attempts.every(a => a.method === 'totp' && !a.success)).toBe(true);
    advance(30_000);
    await Vault.verifySecondFactor(TotpService.generate(secret));
    expect(Vault.isUnlocked).toBe(true);
    expect(attempts[attempts.length - 1]).toMatchObject({ method: 'totp', success: true, profileId: pid });
    expect(await Repo.credentials()).toHaveLength(1);
  });

  it('janela de ±1 passo: aceita o código anterior e o seguinte, recusa dois passos de distância', async () => {
    await Vault.lock();
    advance(90_000);
    let dek = await Vault.verifyPassword(pid, MASTER);
    await Vault.completeUnlock(pid, dek);
    await expect(Vault.verifySecondFactor(TotpService.generate(secret, now - 60_000))).rejects.toThrow('inválido');
    await Vault.verifySecondFactor(TotpService.generate(secret, now + 30_000));
    await Vault.lock();
    advance(90_000);
    dek = await Vault.verifyPassword(pid, MASTER);
    await Vault.completeUnlock(pid, dek);
    await Vault.verifySecondFactor(TotpService.generate(secret, now - 30_000)); // ainda posterior ao último aceito
    expect(Vault.isUnlocked).toBe(true);
  });

  it('códigos de reserva são de uso único', async () => {
    await Vault.lock();
    let dek = await Vault.verifyPassword(pid, MASTER);
    await Vault.completeUnlock(pid, dek);
    await Vault.verifySecondFactor(backup[0].toLowerCase());
    expect(Vault.isUnlocked).toBe(true);
    expect((await Vault.getTwoFactorStatus()).backupCodesLeft).toBe(BACKUP_CODE_COUNT - 1);
    await Vault.lock();
    dek = await Vault.verifyPassword(pid, MASTER);
    await Vault.completeUnlock(pid, dek);
    await expect(Vault.verifySecondFactor(backup[0])).rejects.toThrow('inválido');
    Vault.cancelSecondFactor();
    expect(Vault.pendingSecondFactorProfile).toBeNull();
    await expect(Vault.verifySecondFactor(backup[1])).rejects.toThrow('expirou');
  });

  it('códigos errados contam no bloqueio temporário; ao bloquear, a senha volta a ser exigida', async () => {
    const dek = await Vault.verifyPassword(pid, MASTER);
    await Vault.completeUnlock(pid, dek);
    let tries = 0;
    for (; tries < MAX_FAILURES && Vault.pendingSecondFactorProfile; tries++) await expect(Vault.verifySecondFactor('999999')).rejects.toThrow();
    expect(tries).toBeGreaterThanOrEqual(MAX_FAILURES - 1);
    expect((await Vault.getLockout(pid)).lockedUntil).toBeGreaterThan(now);
    expect(Vault.pendingSecondFactorProfile).toBeNull();
    await expect(Vault.verifyPassword(pid, MASTER)).rejects.toThrow('Muitas tentativas');
    advance(31_000);
  });

  it('a etapa do código expira em 3 minutos', async () => {
    const dek = await Vault.verifyPassword(pid, MASTER);
    await Vault.completeUnlock(pid, dek);
    advance(3 * 60_000 + 1);
    await expect(Vault.verifySecondFactor(TotpService.generate(secret))).rejects.toThrow('expirou');
  });

  it('biometria dispensa o código por padrão; configurável para pedir o código também', async () => {
    const bioAvail = jest.spyOn(Security, 'biometricAvailable').mockResolvedValue({ available: true });
    advance(30_000);
    let dek = await Vault.verifyPassword(pid, MASTER);
    await Vault.completeUnlock(pid, dek);
    await Vault.verifySecondFactor(TotpService.generate(secret));
    await Vault.enableBiometric();
    await Vault.lock();
    // A DEK sem a prova do BiometricPrompt não dispensa o código
    dek = await Vault.verifyPassword(pid, MASTER);
    expect(await Vault.completeUnlock(pid, dek, 'biometric')).toBe('second_factor');
    Vault.cancelSecondFactor();
    expect(await Vault.completeUnlock(pid, await Vault.verifyBiometric(pid), 'biometric')).toBe('unlocked');
    await Vault.setTwoFactorBiometric(false);
    await Vault.lock();
    expect(await Vault.completeUnlock(pid, await Vault.verifyBiometric(pid), 'biometric')).toBe('second_factor');
    advance(30_000);
    await Vault.verifySecondFactor(TotpService.generate(secret));
    await Vault.setTwoFactorBiometric(true);
    bioAvail.mockRestore();
  });

  it('gerar novos códigos de reserva e desativar exigem senha + código', async () => {
    await expect(Vault.regenerateBackupCodes(MASTER, '000000')).rejects.toThrow('inválido');
    const fresh = await Vault.regenerateBackupCodes(MASTER, backup[2]);
    expect(fresh).toHaveLength(BACKUP_CODE_COUNT);
    expect((await Vault.getTwoFactorStatus()).backupCodesLeft).toBe(BACKUP_CODE_COUNT);
    await expect(Vault.disableTwoFactor('Errada#Senha2026', fresh[0])).rejects.toThrow('Senha mestra incorreta');
    backup = fresh;
  });
});

describe(': recuperar troca a DEK e recifra o banco', () => {
  let pid = '';
  let code = '';
  let phrase = '';

  it('recuperação com 2FA exige o código; troca a DEK; envelope antigo + segredo antigo não abre mais', async () => {
    pid = Vault.currentProfile!.id;
    code = await Vault.regenerateRecoveryCode();
    phrase = await Vault.setRecoveryPhrase();
    const oldKeys = await keysOf(pid);
    const oldDek = await Vault.verifyPassword(pid, MASTER);
    await Vault.lock();

    await expect(Vault.recover(pid, 'code', code, 'Nova#SenhaMestra9')).rejects.toThrow('código de verificação');
    advance(30_000);
    const r = await Vault.recover(pid, 'code', code, 'Nova#SenhaMestra9', TotpService.generate(secret));
    expect(r.newRecoveryCode).toMatch(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){5}$/);
    expect(r.dropped).toEqual([]);
    expect(Vault.isUnlocked).toBe(true);
    expect((await Repo.credentials()).map(c => c.title)).toEqual(['Gmail']);
    // A DEK antiga não abre mais o banco
    const newDek = await Vault.verifyPassword(pid, 'Nova#SenhaMestra9');
    expect(toHex(newDek)).not.toBe(toHex(oldDek));
    expect(await opensWith(pid, oldDek)).toBe(false);
    expect(await opensWith(pid, newDek)).toBe(true);
    // Envelope antigo (cópia das preferências) + código antigo: só chega à DEK antiga, que não abre o banco
    const rk = await _test.unwrapKey(normalizeRecoveryCode(code), oldKeys.recoveryCode);
    expect(rk).not.toBeNull();
    expect(await opensWith(pid, _test.dekFromRk(oldKeys, 'code', rk!)!)).toBe(false);
    // Com o envelope novo, o código antigo não serve
    await Vault.lock();
    await expect(Vault.recover(pid, 'code', code, 'Outra#Senha2026', backup[3])).rejects.toThrow('incorretos');
    // Restaurar a cópia antiga das preferências (atacante) também não abre: o banco já foi recifrado
    const current = await Security.secureGet(`p:${pid}:keys`);
    await Security.secureSet(`p:${pid}:keys`, JSON.stringify(oldKeys));
    await expect(Vault.recover(pid, 'phrase', phrase, 'Outra#Senha2026', backup[3])).rejects.toThrow();
    expect(Vault.isUnlocked).toBe(false);
    expect(vaultDb.isOpen).toBe(false);
    await Security.secureSet(`p:${pid}:keys`, current!);
    code = r.newRecoveryCode!;
  });

  it('a frase ainda válida continua valendo depois da troca; trocar a frase invalida a antiga', async () => {
    advance(31_000);
    await Vault.recover(pid, 'phrase', phrase, 'Frase#Semente2026', backup[4]);
    expect(Vault.isUnlocked).toBe(true);
    const beforeNewPhrase = await keysOf(pid);
    const newPhrase = await Vault.setRecoveryPhrase();
    // Envelope da frase antiga copiado + frase antiga: a RK liberada não está mais ligada à DEK atual
    const oldRk = await _test.unwrapKey(normalizePhrase(phrase), beforeNewPhrase.phrase);
    expect(_test.dekFromRk(await keysOf(pid), 'phrase', oldRk!)).toBeNull();
    await Vault.lock();
    await expect(Vault.recover(pid, 'phrase', phrase, 'Outra#Senha2026', backup[5])).rejects.toThrow('incorretos');
    await Vault.recover(pid, 'phrase', newPhrase, MASTER, backup[5]);
    expect(Vault.isUnlocked).toBe(true);
  });

  it('falha do PRAGMA rekey: nada muda e o cofre continua abrindo como antes', async () => {
    await Vault.lock();
    sqlite.__mock.failNextRekey = true;
    await expect(Vault.recover(pid, 'code', code, 'Outra#Senha2026', backup[6])).rejects.toThrow('Nada foi alterado');
    expect(await Security.secureGet(`p:${pid}:rekey`)).toBeNull();
    const dek = await Vault.verifyPassword(pid, MASTER);
    expect(await opensWith(pid, dek)).toBe(true);
  });

  it('cofre da versão 0.1 (sem ligações): troca a DEK, gera código novo e descarta perguntas antigas', async () => {
    const dek = await Vault.verifyPassword(pid, MASTER);
    const keys = await keysOf(pid);
    const legacyCode = 'ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2-34567';
    const legacyPhrase = 'casa bola gato pato rato sapo dado fado lado mato nado pago';
    keys.version = 1;
    delete keys.links;
    delete keys.twoFactor;
    keys.recoveryCode = await _test.wrapKey(normalizeRecoveryCode(legacyCode), dek);
    keys.phrase = await _test.wrapKey(normalizePhrase(legacyPhrase), dek);
    keys.questions = { ...(await _test.wrapKey('a|b|c', dek)), items: ['P1', 'P2', 'P3'] };
    await Security.secureSet(`p:${pid}:keys`, JSON.stringify(keys));
    const r = await Vault.recover(pid, 'phrase', legacyPhrase, 'Legado#Senha2026');
    expect(r.newRecoveryCode).toBeTruthy();
    expect(r.dropped).toEqual(['questions']);
    expect(await opensWith(pid, dek)).toBe(false);
    expect(await Vault.getRecoveryOptions(pid)).toEqual({ questions: null, phrase: true });
    await Vault.lock();
    await expect(Vault.recover(pid, 'code', legacyCode, MASTER)).rejects.toThrow('incorretos');
    await Vault.recover(pid, 'phrase', legacyPhrase, MASTER);
    expect(Vault.isUnlocked).toBe(true);
  });
});

describe(': regras de segurança por pasta', () => {
  it('normaliza a entrada do editor, herda para subpastas e recusa senha abaixo da força mínima', async () => {
    expect(() => FolderRulesService.normalize({ maxAgeDays: '0' })).toThrow('entre 1 e 3650');
    expect(() => FolderRulesService.normalize({ clipboardSeconds: 9999 })).toThrow('entre 5 e 600');
    expect(() => FolderRulesService.normalize({ minStrength: 'mega' as any })).toThrow('Força mínima inválida');
    const bank = newFolder('Bancos');
    await Repo.saveFolder(bank);
    const sub = newFolder('Cartões', bank.id);
    await Repo.saveFolder(sub);
    await FolderRulesService.save(bank.id, { requireReauth: true, minStrength: 'strong', clipboardSeconds: '15', maxAgeDays: '60' });
    const folders = await Repo.folders();
    const eff = PolicyService.effective(folders, sub.id);
    expect(eff).toMatchObject({ requireReauth: true, minStrength: 'strong', clipboardSeconds: 15, maxAgeDays: 60 });
    expect(FolderRulesService.inherited(folders, sub.id).requireReauth).toBe(true);
    expect(FolderRulesService.passwordError(folders, sub.id, '123456')).toMatch(/^A pasta "Bancos › Cartões" exige senha no mínimo Forte\. A senha informada é /);
    expect(FolderRulesService.passwordError(folders, sub.id, 'x9#Lq!v2Tz$8mWp&Rk4e')).toBeNull();
    expect(FolderRulesService.passwordError(folders, null, '123456')).toBeNull();
    expect(FolderRulesService.clipboardSeconds(eff, 30)).toBe(15);
    expect(FolderRulesService.clipboardSeconds({ ...eff, clipboardSeconds: 120 }, 30)).toBe(30);
    expect(FolderRulesService.describe(eff)).toContain('Reautenticar para ver/copiar');
    // Regra vazia é removida da pasta
    await FolderRulesService.save(bank.id, {});
    expect((await Repo.folders()).find(f => f.id === bank.id)!.policy).toBeUndefined();
  });

  it('reautenticação: senha correta/errada e biometria que precisa ser do cofre aberto', async () => {
    expect(await Vault.reauthenticate('password', MASTER)).toBe(true);
    expect(await Vault.reauthenticate('password', 'Errada#Senha2026')).toBe(false);
    await Security.biometricEnroll(`bio_${Vault.currentProfile!.id}`, Buffer.from(new Uint8Array(32)).toString('base64'), '', '');
    expect(await Vault.reauthenticate('biometric')).toBe(false);
  });

  it('a área de transferência usa o tempo da pasta', async () => {
    jest.useFakeTimers({ doNotFake: ['Date'] });
    await ClipboardService.copy('segredo', 'Senha', true, 15);
    expect(ClipboardService.state!.expiresAt - now).toBe(15_000);
    jest.advanceTimersByTime(15_000);
    expect(ClipboardService.state).toBeNull();
    jest.useRealTimers();
  });
});

describe(': perfis pessoal e profissional', () => {
  let personal = '';
  let work = '';
  const WORK_PW = 'Trabalho#Seguro2026';

  it('BDD "Trocar do perfil pessoal para profissional": a lista mostra só as senhas do trabalho', async () => {
    personal = Vault.currentProfile!.id;
    await expect(Vault.createProfile({ name: 'pessoal', masterPassword: WORK_PW })).rejects.toThrow('Já existe um perfil com esse nome');
    const created = await Vault.createProfile({ name: 'Profissional', type: 'professional', masterPassword: WORK_PW });
    work = created.profile.id;
    expect(created.recoveryCode).toBeTruthy();
    expect(Vault.currentProfile!.id).toBe(work);
    await Repo.saveCredential(newCredential({ title: 'Slack da empresa', username: 'lucas@empresa', password: 'Sl@ck#Empresa2026' }));
    expect((await Repo.credentials()).map(c => c.title)).toEqual(['Slack da empresa']);

    // Troca: bloqueia o atual e deixa o outro escolhido na tela de login
    await Vault.switchProfile(personal);
    expect(Vault.isUnlocked).toBe(false);
    expect((await Vault.getProfile())!.id).toBe(personal);
    await Vault.selectProfile(work);
    const dek = await Vault.verifyPassword(work, WORK_PW);
    expect(await Vault.completeUnlock(work, dek)).toBe('unlocked'); // o 2FA do pessoal não vale para o profissional
    expect((await Repo.credentials()).map(c => c.title)).toEqual(['Slack da empresa']);
    // Senha do pessoal não abre o profissional (chaves separadas)
    await Vault.lock();
    await expect(Vault.verifyPassword(work, MASTER)).rejects.toThrow('Senha mestra incorreta');
  });

  it('renomear valida o nome; a lista corrompida é tratada', async () => {
    const renamed = await Vault.renameProfile(work, { name: '  Escritório  ' });
    expect(renamed.name).toBe('Escritório');
    await expect(Vault.renameProfile(work, { name: '' })).rejects.toThrow('Informe o nome');
    await expect(Vault.renameProfile(work, { name: 'x'.repeat(31) })).rejects.toThrow('até 30');
    await expect(Vault.renameProfile('nao-existe', { name: 'A' })).rejects.toThrow('Perfil não encontrado');
    const saved = (await Security.secureGet('profiles'))!;
    await Security.secureSet('profiles', '{corrompido');
    await expect(Vault.listProfiles()).rejects.toThrow('corrompida');
    await Security.secureSet('profiles', JSON.stringify([...JSON.parse(saved), { id: '' }, null]));
    expect(await Vault.listProfiles()).toHaveLength(2); // entradas inválidas são ignoradas
    await Security.secureSet('profiles', saved);
  });

  it('excluir exige a senha do perfil (e o 2FA dele) e apaga banco e chaves', async () => {
    await expect(Vault.deleteProfile(work, MASTER)).rejects.toThrow('Senha mestra incorreta');
    await Vault.deleteProfile(work, WORK_PW);
    expect((await Vault.listProfiles()).map(p => p.id)).toEqual([personal]);
    expect(sqlite.__dbs.has(`custodia_${work}.sqlite`)).toBe(false);
    expect(await Security.secureKeys(`p:${work}:`)).toEqual([]);
    await expect(Vault.deleteProfile(personal, MASTER)).rejects.toThrow('único perfil');
  });
});

