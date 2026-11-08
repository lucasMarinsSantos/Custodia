// Testes de integração do cofre e do CRUD
// O banco SQLCipher é simulado com better-sqlite3 (jest/opSqliteMock.js): uma chave errada não abre o arquivo.
import { MAX_FAILURES, Vault, generateRecoveryCode, normalizeAnswer } from '../services/VaultService';
import { MAX_FOLDER_DEPTH, Repo, newCredential, newFolder, ValidationError } from '../services/Repository';
import { IntegrityService } from '../services/IntegrityService';
import { sortCredentials } from '../services/SortService';
import { vaultDb } from '../db/Database';
import { Security } from '../native';
import { bus, Events } from '../services/events';

jest.setTimeout(120000);

const MASTER = 'Cofre#Seguro2026';
const tick = () => new Promise(r => setTimeout(r, 20));

async function unlock(password = MASTER) {
  const p = (await Vault.getProfile())!;
  const dek = await Vault.verifyPassword(p.id, password);
  await Vault.completeUnlock(p.id, dek, 'password');
  return p;
}

describe('Cofre, autenticação e CRUD', () => {
  let recovery = '';
  let profileId = '';

  it('rejeita senha mestra fraca, curta ou comum', async () => {
    expect(await Vault.hasVault()).toBe(false);
    await expect(Vault.createVault({ masterPassword: 'Ab1!xy' })).rejects.toThrow('A senha deve conter pelo menos 12 caracteres');
    await expect(Vault.createVault({ masterPassword: 'semmaiusculas123!' })).rejects.toThrow(/maiúsculas/);
    expect(await Vault.hasVault()).toBe(false);
  });

  it('cria o cofre, envelopa a chave no Keystore e abre o banco cifrado', async () => {
    const events: any[] = [];
    const off = bus.on(Events.UNLOCKED, p => events.push(p));
    const r = await Vault.createVault({ masterPassword: MASTER, hint: 'frase da faculdade' });
    off();
    recovery = r.recoveryCode;
    profileId = r.profile.id;
    expect(recovery).toMatch(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){5}$/);
    expect(events[0]).toEqual({ recoveryCode: recovery });
    expect(Vault.isUnlocked).toBe(true);
    expect(vaultDb.isOpen).toBe(true);
    // Os envelopes ficam nas preferências cifradas pelo Keystore e não contêm a senha em claro
    const keys = (await Security.secureGet(`p:${profileId}:keys`))!;
    expect(keys).toBeTruthy();
    expect(keys).not.toContain(MASTER);
    expect(await Vault.getHint(profileId)).toBe('frase da faculdade');
    await expect(Vault.createVault({ masterPassword: MASTER })).rejects.toThrow('Já existe um cofre');
  });

  it('o banco só abre com a chave correta', async () => {
    const { open } = require('@op-engineering/op-sqlite');
    const wrong = open({ name: `custodia_${profileId}.sqlite`, encryptionKey: '00'.repeat(32) });
    await expect(wrong.execute('SELECT 1')).rejects.toThrow('file is not a database');
  });

  it('título obrigatório; adicionar, visualizar, editar e excluir', async () => {
    await expect(Repo.saveCredential(newCredential({ title: '  ', username: 'eu', password: 'x' }))).rejects.toThrow(ValidationError);
    await expect(Repo.saveCredential(newCredential({ title: '', username: 'eu', password: 'x' }))).rejects.toThrow('O título é obrigatório');
    expect(await Repo.credentials()).toHaveLength(0);

    const fb = await Repo.saveCredential(newCredential({ title: 'Facebook', username: 'lucas', password: 'Primeira#Senha1', url: 'facebook.com', category: 'social' }));
    expect((await Repo.credentials()).map(c => c.title)).toEqual(['Facebook']);
    const read = await Repo.credential(fb.id);
    expect(read?.username).toBe('lucas');
    expect(read?.password).toBe('Primeira#Senha1');

    await Repo.saveCredential({ ...read!, notes: 'conta antiga', customFields: [{ id: 'c1', label: 'PIN', value: '1234', type: 'hidden' }] });
    expect((await Repo.credential(fb.id))?.customFields[0].label).toBe('PIN');

    await Repo.deleteCredential(fb.id);
    expect(await Repo.credential(fb.id)).toBeNull();
    expect(await Repo.versions(fb.id)).toHaveLength(0);
  });

  it('histórico vazio após criar; restaurar versão anterior da senha', async () => {
    const c = await Repo.saveCredential(newCredential({ title: 'Gmail', username: 'eu@gmail.com', password: 'Antiga#Senha123', url: 'gmail.com' }));
    expect(await Repo.versions(c.id)).toHaveLength(1); // só a criação → "Nenhuma alteração registrada"
    await new Promise(r => setTimeout(r, 5));
    const changed = await Repo.saveCredential({ ...c, password: 'Nova#Senha456!' });
    expect(changed.passwordChangedAt >= c.passwordChangedAt).toBe(true);
    const versions = await Repo.versions(c.id);
    expect(versions.map(v => v.changeType)).toEqual(['password', 'create']);
    expect(versions[0].summary).toContain('senha');
    await Repo.restoreVersion(versions[1]);
    expect((await Repo.credential(c.id))?.password).toBe('Antiga#Senha123');
    expect((await Repo.versions(c.id))[0].changeType).toBe('restore');
  });

  it('cria pastas e subpastas, move credenciais e impede ciclos', async () => {
    const fin = newFolder('Finanças');
    await Repo.saveFolder(fin);
    const bancos = newFolder('Bancos', fin.id);
    await Repo.saveFolder(bancos);
    await expect(Repo.saveFolder(newFolder('finanças'))).rejects.toThrow('Já existe uma pasta');
    await expect(Repo.saveFolder({ ...fin, parentId: bancos.id })).rejects.toThrow('dentro de si mesma');
    await expect(Repo.saveFolder(newFolder('  '))).rejects.toThrow('Informe o nome');

    const bb = await Repo.saveCredential(newCredential({ title: 'Banco do Brasil', username: 'ag1234', password: 'Bb#2026!segura' }));
    await Repo.moveCredential(bb.id, bancos.id);
    const folders = await Repo.folders();
    expect((await Repo.credential(bb.id))?.folderId).toBe(bancos.id);
    expect(Repo.folderPath(folders, bancos.id)).toBe('Finanças › Bancos');
    expect(Repo.countInFolder(folders, await Repo.credentials(), fin.id)).toBe(1);
    expect((await Repo.versions(bb.id))[0].changeType).toBe('move');
  });

  it('excluir pasta com credenciais → mover para a raiz ou excluir também', async () => {
    const folders = await Repo.folders();
    const fin = folders.find(f => f.name === 'Finanças')!;
    const bb = (await Repo.credentials()).find(c => c.title === 'Banco do Brasil')!;
    await Repo.deleteFolder(fin.id, 'move');
    expect(await Repo.folders()).toHaveLength(0); // subpasta também removida
    expect((await Repo.credential(bb.id))?.folderId).toBeNull();

    const trab = newFolder('Trabalho');
    await Repo.saveFolder(trab);
    const slack = await Repo.saveCredential(newCredential({ title: 'Slack', password: 'x', folderId: trab.id }));
    await Repo.deleteFolder(trab.id, 'delete');
    expect(await Repo.credential(slack.id)).toBeNull();
    await Repo.deleteFolder('inexistente');
  });

  it('contador de uso e ordenação inteligente / recentes / A–Z', async () => {
    const all = await Repo.credentials();
    const gmail = all.find(c => c.title === 'Gmail')!;
    await Repo.recordUsage(gmail.id);
    await Repo.recordUsage(gmail.id);
    await Repo.touch(gmail.id);
    const list = await Repo.credentials();
    expect(list.find(c => c.id === gmail.id)?.usageCount).toBe(2);
    expect(sortCredentials(list, 'usage')[0].title).toBe('Gmail');
    expect(sortCredentials(list, 'smart')[0].title).toBe('Gmail');
    expect(sortCredentials(list, 'recent')[0].title).toBe('Gmail');
    expect(sortCredentials(list, 'alpha').map(c => c.title)).toEqual(['Banco do Brasil', 'Gmail']);
  });

  it('verificação de integridade detecta alteração externa do conteúdo', async () => {
    IntegrityService.start();
    await IntegrityService.flush();
    expect((await IntegrityService.checkAfterUnlock()).ok).toBe(true);
    expect((await IntegrityService.lastResult())?.ok).toBe(true);
    // Adulteração direta no banco, sem passar pelo app
    await (vaultDb as any).req().execute("UPDATE docs SET data = replace(data, 'Gmail', 'Gmai1') WHERE collection = 'credentials'");
    const r = await IntegrityService.checkAfterUnlock();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/alterado externamente/);
    // Usuário reconhece: novo hash registrado
    await IntegrityService.flush();
    expect((await IntegrityService.checkAfterUnlock()).ok).toBe(true);
    IntegrityService.stop();
  });

  it('bloqueio apaga a chave da memória; senha errada é rejeitada e conta tentativas', async () => {
    await Vault.updateSettings({ autoLockMinutes: 10, secureKeyboard: false });
    await Vault.lock('manual');
    expect(Vault.isUnlocked).toBe(false);
    expect(vaultDb.isOpen).toBe(false);
    await expect(Repo.credentials()).rejects.toThrow('Cofre bloqueado');
    await expect(Vault.verifyPassword(profileId, 'errada')).rejects.toThrow('Senha mestra incorreta');
    expect((await Vault.getLockout(profileId)).failures).toBe(1);
    await unlock();
    expect(Vault.isUnlocked).toBe(true);
    expect((await Vault.getLockout(profileId)).failures).toBe(0);
    // Configurações persistem entre sessões
    expect(Vault.settings.autoLockMinutes).toBe(10);
    expect(Vault.settings.secureKeyboard).toBe(false);
    expect((await Repo.credentials()).length).toBe(2);
  });

  it(`bloqueio temporário após ${MAX_FAILURES} senhas erradas`, async () => {
    await Vault.lock();
    for (let i = 0; i < MAX_FAILURES; i++) await expect(Vault.verifyPassword(profileId, 'errada')).rejects.toThrow();
    await expect(Vault.verifyPassword(profileId, MASTER)).rejects.toThrow(/Muitas tentativas/);
    const lo = await Vault.getLockout(profileId);
    expect(lo.lockedUntil).toBeGreaterThan(Date.now());
    const now = Date.now;
    Date.now = () => now() + 31000;
    try {
      await unlock();
    } finally {
      Date.now = now;
    }
    expect(Vault.isUnlocked).toBe(true);
  });

  it('biometria com fallback para a senha mestra', async () => {
    // Sem sensor biométrico: não ativa
    await expect(Vault.enableBiometric()).rejects.toThrow();
    const avail = jest.spyOn(Security, 'biometricAvailable').mockResolvedValue({ available: true });
    await Vault.enableBiometric();
    expect(Vault.settings.biometricEnabled).toBe(true);
    await Vault.lock();
    // Leitura correta → desbloqueia com a DEK guardada pela chave biométrica do Keystore
    const dek = await Vault.verifyBiometric(profileId);
    await Vault.completeUnlock(profileId, dek, 'biometric');
    expect(Vault.isUnlocked).toBe(true);
    await Vault.lock();

    const unlockSpy = jest.spyOn(Security, 'biometricUnlock');
    unlockSpy.mockRejectedValueOnce(Object.assign(new Error('Não foi possível reconhecer a biometria'), { code: 'E_NOT_RECOGNIZED' }));
    await expect(Vault.verifyBiometric(profileId)).rejects.toThrow('Não foi possível reconhecer a biometria');
    // Erro do sensor que não é leitura errada: avisa, mas não conta para o bloqueio
    unlockSpy.mockRejectedValueOnce(Object.assign(new Error('Sensor ocupado'), { code: 'E_BIOMETRIC' }));
    await expect(Vault.verifyBiometric(profileId)).rejects.toThrow('Não foi possível usar a biometria (Sensor ocupado)');
    unlockSpy.mockRejectedValueOnce(Object.assign(new Error('cancelled: Usar senha mestra'), { code: 'E_CANCELLED' }));
    await expect(Vault.verifyBiometric(profileId)).rejects.toThrow('cancelada');
    // 5 falhas consecutivas → o Android devolve ERROR_LOCKOUT → biometria desativada temporariamente
    unlockSpy.mockRejectedValueOnce(Object.assign(new Error('lockout: Muitas tentativas'), { code: 'E_LOCKOUT' }));
    await expect(Vault.verifyBiometric(profileId)).rejects.toThrow('desativada temporariamente');
    expect(await Vault.biometricLockedUntil(profileId)).toBeGreaterThan(Date.now());
    await expect(Vault.verifyBiometric(profileId)).rejects.toThrow('desativada temporariamente');
    // Fallback: a senha mestra continua funcionando
    await unlock();
    expect(Vault.isUnlocked).toBe(true);
    unlockSpy.mockRestore();
    avail.mockRestore();
    await Vault.disableBiometric();
    expect(Vault.settings.biometricEnabled).toBe(false);
  });

  it('perguntas de segurança e frase semente redefinem a senha mestra', async () => {
    await expect(Vault.setSecurityQuestions([{ question: 'Só uma?', answer: 'sim' }])).rejects.toThrow('ao menos 3 perguntas');
    // Respostas curtas demais ou repetidas são recusadas (fáceis de adivinhar)
    await expect(
      Vault.setSecurityQuestions([
        { question: 'A?', answer: 'ab' },
        { question: 'B?', answer: 'Campinas' },
        { question: 'C?', answer: 'Juca' },
      ]),
    ).rejects.toThrow('3 ou mais caracteres');
    await expect(
      Vault.setSecurityQuestions([
        { question: 'A?', answer: 'Rex' },
        { question: 'B?', answer: 'rex' },
        { question: 'C?', answer: 'Juca' },
      ]),
    ).rejects.toThrow('respostas diferentes');
    await Vault.setSecurityQuestions([
      { question: 'Primeiro animal?', answer: 'Totó' },
      { question: 'Cidade natal?', answer: 'São Paulo' },
      { question: 'Apelido?', answer: 'Juca' },
    ]);
    const phrase = await Vault.setRecoveryPhrase();
    expect(phrase.split(' ')).toHaveLength(12);
    expect(await Vault.getRecoveryOptions(profileId)).toEqual({ questions: ['Primeiro animal?', 'Cidade natal?', 'Apelido?'], phrase: true });
    await Vault.lock();

    await expect(Vault.recover(profileId, 'questions', ['toto', 'rio', 'juca'], 'Outra#Senha2026')).rejects.toThrow('incorretos');
    // Entrada malformada (não é lista) não quebra nada: apenas conta como tentativa errada
    await expect(Vault.recover(profileId, 'questions', 'toto', 'Outra#Senha2026')).rejects.toThrow('incorretos');
    // Respostas sem acento/maiúsculas também valem
    const q = await Vault.recover(profileId, 'questions', ['TOTO', '  sao   paulo ', 'JUCA'], 'Perguntas#Ok2026');
    expect(q.newRecoveryCode).toBeNull();
    expect(Vault.isUnlocked).toBe(true);
    await Vault.lock();
    await unlock('Perguntas#Ok2026');
    await Vault.lock();

    await Vault.recover(profileId, 'phrase', phrase.toUpperCase().replace(/ /g, '  '), 'Frase#Semente2026');
    await Vault.lock();
    await unlock('Frase#Semente2026');
    expect(normalizeAnswer('  Ação  ÁGUA ')).toBe('acao agua');
  });

  it('restauração de emergência com código de uso único', async () => {
    await Vault.lock();
    await expect(Vault.recover(profileId, 'code', recovery, 'fraca')).rejects.toThrow('12 caracteres');
    const r = await Vault.recover(profileId, 'code', recovery.toLowerCase(), 'Nova#SenhaMestra9');
    expect(Vault.isUnlocked).toBe(true);
    expect(r.newRecoveryCode).toMatch(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){5}$/);
    expect((await Repo.credentials()).length).toBe(2); // dados preservados
    await Vault.lock();
    // O código antigo não serve mais (uso único); o novo serve
    await expect(Vault.recover(profileId, 'code', recovery, 'Outra#Senha2026')).rejects.toThrow('incorretos');
    await Vault.recover(profileId, 'code', r.newRecoveryCode!, 'Final#Senha2026');
    await Vault.lock();
    await unlock('Final#Senha2026');
    expect(Vault.isUnlocked).toBe(true);
  });

  it('altera a senha mestra (a antiga deixa de funcionar)', async () => {
    await expect(Vault.changeMasterPassword('errada', 'Trocada#Senha2026')).rejects.toThrow('Senha atual incorreta');
    await expect(Vault.changeMasterPassword('Final#Senha2026', 'curta')).rejects.toThrow();
    expect(await Vault.verifyCurrentPassword('Final#Senha2026')).toBe(true);
    await Vault.changeMasterPassword('Final#Senha2026', 'Trocada#Senha2026');
    const code = await Vault.regenerateRecoveryCode();
    expect(code).not.toBe(generateRecoveryCode());
    await Vault.lock();
    await expect(Vault.verifyPassword(profileId, 'Final#Senha2026')).rejects.toThrow();
    await unlock('Trocada#Senha2026');
    expect(Vault.isUnlocked).toBe(true);
    await tick();
  });
  describe('Segurança: tentativas de abuso', () => {
    const PW = 'Trocada#Senha2026';
    const reset = async () => {
      const now = Date.now;
      Date.now = () => now() + 31 * 60 * 1000;
      try {
        if (!Vault.isUnlocked) await unlock(PW);
      } finally {
        Date.now = now;
      }
    };

    it('tentativas em paralelo não escapam do limite de falhas', async () => {
      await Vault.lock();
      const results = await Promise.allSettled(Array.from({ length: 12 }, () => Vault.verifyPassword(profileId, 'chute-errado')));
      expect(results.every(r => r.status === 'rejected')).toBe(true);
      const messages = results.map(r => String((r as PromiseRejectedResult).reason?.message));
      // Só as 5 primeiras chegam a testar a senha; o resto já encontra o cofre bloqueado
      expect(messages.filter(m => m.includes('incorreta'))).toHaveLength(MAX_FAILURES);
      expect(messages.filter(m => /Muitas tentativas/.test(m))).toHaveLength(12 - MAX_FAILURES);
      // Mesmo a senha certa é recusada durante o bloqueio
      await expect(Vault.verifyPassword(profileId, PW)).rejects.toThrow(/Muitas tentativas/);
      await reset();
      expect((await Vault.getLockout(profileId)).failures).toBe(0);
    });

    it('a falha é registrada antes da derivação de chave (encerrar o app no meio não zera o contador)', async () => {
      await Vault.lock();
      const before = (await Vault.getLockout(profileId)).failures;
      // Simula a derivação lenta: a verificação fica "em andamento" até liberarmos
      let release: (v: string | null) => void = () => {};
      const kdf = jest.spyOn(Security, 'pbkdf2').mockImplementationOnce(() => new Promise<string | null>(r => (release = r)));
      const pending = Vault.verifyPassword(profileId, 'outro-chute').catch((e: Error) => e);
      await tick();
      // Durante a verificação a tentativa já está contada: matar o app agora não apagaria a falha
      expect((await Vault.getLockout(profileId)).failures).toBe(before + 1);
      release(null); // segue pela implementação JS
      expect(String((await pending as Error).message)).toContain('incorreta');
      kdf.mockRestore();
      await unlock(PW);
      expect((await Vault.getLockout(profileId)).failures).toBe(0);
    });

    it('reverificar a senha dentro do cofre também conta tentativas', async () => {
      for (let i = 0; i < MAX_FAILURES; i++) expect(await Vault.verifyCurrentPassword('chute')).toBe(false);
      await expect(Vault.verifyCurrentPassword(PW)).rejects.toThrow(/Muitas tentativas/);
      await expect(Vault.changeMasterPassword(PW, 'Outra#Senha20266')).rejects.toThrow(/Muitas tentativas/);
      await Vault.lock();
      await reset();
      expect(await Vault.verifyCurrentPassword(PW)).toBe(true);
    });

    it('atrasar o relógio não prende o usuário por mais de 30 min nem libera antes', async () => {
      await Vault.lock();
      for (let i = 0; i < MAX_FAILURES; i++) await expect(Vault.verifyPassword(profileId, 'x')).rejects.toThrow();
      const now = Date.now;
      const base = now();
      Date.now = () => base - 7 * 24 * 3600 * 1000; // uma semana para trás
      try {
        await expect(Vault.verifyPassword(profileId, PW)).rejects.toThrow(/Aguarde 1800s/);
      } finally {
        Date.now = now;
      }
      await reset();
    });

    it('as falhas de senha não desativam a biometria do dono', async () => {
      const avail = jest.spyOn(Security, 'biometricAvailable').mockResolvedValue({ available: true });
      await Vault.enableBiometric();
      await Vault.lock();
      for (let i = 0; i < MAX_FAILURES; i++) await expect(Vault.verifyPassword(profileId, 'x')).rejects.toThrow();
      const dek = await Vault.verifyBiometric(profileId);
      await Vault.completeUnlock(profileId, dek, 'biometric');
      expect(Vault.isUnlocked).toBe(true);
      await Vault.disableBiometric();
      avail.mockRestore();
    });

    it('5 leituras biométricas não reconhecidas desativam a biometria; um acerto zera a contagem', async () => {
      await reset();
      const avail = jest.spyOn(Security, 'biometricAvailable').mockResolvedValue({ available: true });
      await Vault.enableBiometric();
      await Vault.lock();
      const unlockSpy = jest.spyOn(Security, 'biometricUnlock');
      const notRecognized = () => unlockSpy.mockRejectedValueOnce(Object.assign(new Error('Não foi possível reconhecer a biometria'), { code: 'E_NOT_RECOGNIZED' }));
      for (let i = 0; i < MAX_FAILURES - 1; i++) {
        notRecognized();
        await expect(Vault.verifyBiometric(profileId)).rejects.toThrow('Não foi possível reconhecer a biometria');
      }
      // Um acerto antes da 5ª falha zera o contador
      const dek = await Vault.verifyBiometric(profileId);
      expect(dek.length).toBe(32);
      for (let i = 0; i < MAX_FAILURES - 1; i++) {
        notRecognized();
        await expect(Vault.verifyBiometric(profileId)).rejects.toThrow('Não foi possível reconhecer a biometria');
      }
      expect(await Vault.biometricLockedUntil(profileId)).toBe(0);
      // Entrar com a senha mestra também zera a contagem ("5 seguidas")
      await unlock(PW);
      await Vault.lock();
      for (let i = 0; i < MAX_FAILURES - 1; i++) {
        notRecognized();
        await expect(Vault.verifyBiometric(profileId)).rejects.toThrow('Não foi possível reconhecer a biometria');
      }
      expect(await Vault.biometricLockedUntil(profileId)).toBe(0);
      notRecognized();
      await expect(Vault.verifyBiometric(profileId)).rejects.toThrow('desativada temporariamente');
      expect(await Vault.biometricLockedUntil(profileId)).toBeGreaterThan(Date.now());
      // A senha mestra continua funcionando
      await unlock(PW);
      unlockSpy.mockRestore();
      await Vault.disableBiometric();
      avail.mockRestore();
    });

    it('alterações simultâneas das chaves de recuperação não se sobrescrevem', async () => {
      await reset();
      const [phrase, code] = await Promise.all([Vault.setRecoveryPhrase(), Vault.regenerateRecoveryCode()]);
      await Vault.lock();
      // A frase e o código gerados ao mesmo tempo continuam valendo
      await Vault.recover(profileId, 'phrase', phrase, 'Frase#Paralela2026');
      await Vault.lock();
      await Vault.recover(profileId, 'code', code, PW);
      await Vault.lock();
      await unlock(PW);
      expect(Vault.isUnlocked).toBe(true);
    });

    it('bloquear durante a geração da frase não grava um envelope com a chave zerada', async () => {
      await reset();
      const pending = Vault.setRecoveryPhrase();
      await Vault.lock('segundo plano');
      await expect(pending).rejects.toThrow(/bloqueado/i);
      // A frase anterior continua sendo a única válida e a senha mestra segue funcionando
      await unlock(PW);
      expect(Vault.isUnlocked).toBe(true);
    });

    it('mover para uma pasta que não existe mais é recusado', async () => {
      await reset();
      const c = await Repo.saveCredential(newCredential({ title: 'Órfã', username: 'eu', password: 'Orfa#Senha2026x' }));
      await expect(Repo.moveCredential(c.id, 'pasta-apagada')).rejects.toThrow('não existe');
      expect((await Repo.credential(c.id))!.folderId ?? null).toBeNull();
      await Repo.deleteCredential(c.id);
    });

    it('favoritar não cria versão no histórico e pastas têm profundidade máxima', async () => {
      await reset();
      const c = await Repo.saveCredential(newCredential({ title: 'Favoritável', username: 'eu', password: 'Fav#Senha2026x' }));
      const before = (await Repo.versions(c.id)).length;
      await Promise.all([Repo.setFavorite(c.id, true), Repo.setFavorite(c.id, true)]);
      expect((await Repo.credential(c.id))!.favorite).toBe(true);
      expect((await Repo.versions(c.id)).length).toBe(before);
      await Repo.deleteCredential(c.id);

      let parentId: string | null = null;
      for (let i = 0; i < MAX_FOLDER_DEPTH; i++) {
        const f = newFolder(`Nível ${i + 1}`, parentId);
        await Repo.saveFolder(f);
        parentId = f.id;
      }
      await expect(Repo.saveFolder(newFolder('Fundo demais', parentId))).rejects.toThrow(`${MAX_FOLDER_DEPTH} níveis`);
    });

    it('limites de tamanho nos campos e no nome da pasta', async () => {
      const big = 'x'.repeat(20001);
      await expect(Repo.saveCredential({ ...newCredential(), title: 'Ok', notes: big })).rejects.toThrow(ValidationError);
      await expect(Repo.saveCredential({ ...newCredential(), title: 'y'.repeat(500) })).rejects.toThrow('até');
      const fields = Array.from({ length: 31 }, (_, i) => ({ id: String(i), label: 'c' + i, value: 'v', type: 'text' as const }));
      await expect(Repo.saveCredential({ ...newCredential(), title: 'Ok', customFields: fields })).rejects.toThrow('no máximo');
      await expect(Repo.saveFolder({ ...newFolder('p'.repeat(61)) })).rejects.toThrow('até 60');
    });
  });
});
