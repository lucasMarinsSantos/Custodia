// Exclusão segura: sobrescrita com dados aleatórios antes do DELETE + PRAGMA secure_delete.
// O banco de teste é o better-sqlite3 em memória (jest/opSqliteMock.js); `serialize()` devolve as páginas do arquivo,
// então dá para conferir byte a byte que nada do conteúdo apagado continua legível.
import { Vault } from '../services/VaultService';
import { Repo, newCredential } from '../services/Repository';
import { NoteService, newNote } from '../services/NoteService';
import { FormService, newFormItem } from '../services/FormService';
import { SECURE_DELETE_PASSES, VaultDatabase, vaultDb } from '../db/Database';
import { PaymentCard } from '../types/models';

jest.setTimeout(120000);

const MASTER = 'Cofre#Seguro2026';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

let profileId = '';
const fileBytes = (): Buffer => {
  const { __dbs } = require('@op-engineering/op-sqlite');
  return __dbs.get(VaultDatabase.fileName(profileId)).db.serialize();
};
const readable = (text: string) => fileBytes().includes(Buffer.from(text, 'utf8'));

/** Registra o conteúdo do documento logo depois de cada passe de sobrescrita (o "UPDATE intermediário"). */
function captureScrubPasses() {
  const db: any = (vaultDb as any).db;
  const original = db.execute;
  const passes: { id: string; data: string }[] = [];
  db.execute = async (sql: string, params?: any[]) => {
    const res = await original(sql, params);
    if (sql.startsWith('UPDATE docs SET data = substr(hex(randomblob')) {
      const row = (await original('SELECT data FROM docs WHERE collection = ? AND id = ?', params)).rows[0];
      if (row) passes.push({ id: String(params![1]), data: String(row.data) });
    }
    return res;
  };
  return { passes, restore: () => (db.execute = original) };
}

beforeAll(async () => {
  const r = await Vault.createVault({ masterPassword: MASTER });
  profileId = r.profile.id;
});

describe(' Exclusão segura', () => {
  it('o banco abre com PRAGMA secure_delete = ON', async () => {
    const res = await (vaultDb as any).db.execute('PRAGMA secure_delete');
    expect(Number(Object.values(res.rows[0])[0])).toBe(1);
  });

  it('credencial excluída: nem a senha, nem as versões, nem os passes intermediários ficam legíveis na tabela', async () => {
    const c = await Repo.saveCredential(newCredential({ title: 'Banco Secreto', username: 'usuario.unico.987', password: 'SenhaSuperSecreta#111' }));
    await Repo.saveCredential({ ...c, password: 'SenhaSuperSecreta#222' });
    expect(readable('SenhaSuperSecreta#111')).toBe(true);
    const versionIds = (await Repo.versions(c.id)).map(v => v.id);
    expect(versionIds).toHaveLength(2);

    const cap = captureScrubPasses();
    try {
      await Repo.deleteCredential(c.id);
    } finally {
      cap.restore();
    }
    // 3 passes para a credencial e para cada versão
    expect(cap.passes).toHaveLength(SECURE_DELETE_PASSES * 3);
    expect(new Set(cap.passes.map(p => p.id))).toEqual(new Set([c.id, ...versionIds]));
    // Cada passe tem dados aleatórios diferentes, do mesmo tamanho, sem o texto original
    const credPasses = cap.passes.filter(p => p.id === c.id).map(p => p.data);
    expect(new Set(credPasses).size).toBe(SECURE_DELETE_PASSES);
    expect(credPasses.every(d => /^[0-9A-F]+$/.test(d) && !d.includes('Secreta'))).toBe(true);

    for (const secret of ['SenhaSuperSecreta#111', 'SenhaSuperSecreta#222', 'usuario.unico.987', 'Banco Secreto']) expect(readable(secret)).toBe(false);
    for (const p of cap.passes) expect(readable(p.data.slice(0, 48))).toBe(false);
    expect(await Repo.credential(c.id)).toBeNull();
  });

  it('nota e anexos: anexo removido e nota excluída não deixam rastro no arquivo', async () => {
    const anexoA = b64('CONTEUDO-DO-ANEXO-A '.repeat(40));
    const anexoB = b64('CONTEUDO-DO-ANEXO-B '.repeat(40));
    let note = newNote({ title: 'Seed da carteira', content: 'palavra1 palavra2 frase-semente-unica' });
    note = NoteService.addAttachment(note, { name: 'a.txt', mime: 'text/plain', size: 0, base64: anexoA });
    note = NoteService.addAttachment(note, { name: 'b.txt', mime: 'text/plain', size: 0, base64: anexoB });
    note = await NoteService.save(note);
    expect(readable(anexoA.slice(0, 60))).toBe(true);

    // Remover um anexo: com secure_delete o conteúdo antigo da célula é zerado no UPDATE
    note = await NoteService.save(NoteService.removeAttachment(note, note.attachments[0].id));
    expect(readable(anexoA.slice(0, 60))).toBe(false);
    expect(readable(anexoB.slice(0, 60))).toBe(true);

    const cap = captureScrubPasses();
    try {
      await NoteService.remove(note.id);
    } finally {
      cap.restore();
    }
    expect(cap.passes).toHaveLength(SECURE_DELETE_PASSES);
    expect(readable('frase-semente-unica')).toBe(false);
    expect(readable(anexoB.slice(0, 60))).toBe(false);
    for (const p of cap.passes) expect(readable(p.data.slice(0, 48))).toBe(false);
    expect(await NoteService.get(note.id)).toBeNull();
  });

  it('formulário (cartão) excluído não deixa o número legível', async () => {
    const card = { ...(newFormItem('card') as PaymentCard), holder: 'Lucas M', number: '4111111111111111', expMonth: '12', expYear: '39', cvv: '123' };
    const saved = await FormService.save(card);
    expect(readable('4111111111111111')).toBe(true);
    await FormService.remove(saved.id);
    expect(readable('4111111111111111')).toBe(false);
    expect(await FormService.get(saved.id)).toBeNull();
  });
});

describe(' Arquivos temporários (FilesModule)', () => {
  const { Files, __mockTempFiles, __resetMockFiles } = require('../native/files');
  afterEach(() => __resetMockFiles());

  it('apaga com segurança só dentro da pasta privada do app', async () => {
    const dir = await Files.tempPath();
    __mockTempFiles.set(`${dir}/export.json`, 'conteudo');
    expect(await Files.secureDelete(`${dir}/export.json`)).toBe(true);
    expect(__mockTempFiles.size).toBe(0);
    await expect(Files.secureDelete('/sdcard/Download/qualquer.txt')).rejects.toThrow('Caminho fora da área do aplicativo');
    await expect(Files.secureDelete(`${dir}/../../databases/custodia.sqlite`)).rejects.toThrow('Caminho fora da área do aplicativo');
  });

  it('os temporários são apagados no desbloqueio (restos de uma sessão encerrada à força)', async () => {
    const { AppController } = require('../services/AppController');
    const { IntegrityService } = require('../services/IntegrityService');
    const { SessionService } = require('../services/SessionService');
    const { ExpiryService } = require('../services/ExpiryService');
    const dir = await Files.tempPath();
    __mockTempFiles.set(`${dir}/ocr.jpg`, 'x');
    __mockTempFiles.set(`${dir}/backup.tmp`, 'y');
    const wipe = jest.spyOn(Files, 'wipeTemp');
    const mocks = [
      jest.spyOn(SessionService, 'start').mockImplementation(() => {}),
      jest.spyOn(IntegrityService, 'start').mockImplementation(() => {}),
      jest.spyOn(IntegrityService, 'checkAfterUnlock').mockResolvedValue(undefined),
    ];
    try {
      await AppController.onUnlocked();
      expect(wipe).toHaveBeenCalled();
      expect(__mockTempFiles.size).toBe(0);
    } finally {
      ExpiryService.stopDaily();
      [wipe, ...mocks].forEach(m => m.mockRestore());
    }
  });
});
