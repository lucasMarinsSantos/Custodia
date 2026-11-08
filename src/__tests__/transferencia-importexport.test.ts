// (importação/exportação) e (inventário sem senhas) com o banco em memória
import fs from 'fs';
import path from 'path';
import { Vault } from '../services/VaultService';
import { Repo, newCredential, newFolder } from '../services/Repository';
import { vaultDb } from '../db/Database';
import { ImportService, IMPORT_SUCCESS, MAX_IMPORT_BYTES } from '../services/ImportService';
import { ExportService, inventoryEntries } from '../services/ExportService';
import { parseCsv } from '../services/transfer/csv';
import { safeUrl } from '../services/transfer/sanitize';
import { DefaultFolderPolicy, SecureNote } from '../types/models';
import { toB64, utf8 } from '../crypto';

jest.setTimeout(120000);

const MASTER = 'Cofre#Seguro2026';
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'import', name), 'utf8');
const fast = { iterations: 1000 };
const fastOpen = { minIterations: 1000 };

async function importText(text: string, strategy: 'skip' | 'replace' | 'keep_both' = 'skip') {
  const r = ImportService.read(text);
  if (r.kind !== 'parsed') throw new Error('esperava arquivo legível');
  const preview = await ImportService.preview(r.parsed);
  return { preview, result: await ImportService.apply(preview, strategy) };
}

beforeAll(async () => {
  await Vault.createVault({ masterPassword: MASTER });
});

describe('BDD: Importação/exportação', () => {
  it('Cenário: Importação de CSV válida, todas as credenciais do arquivo são adicionadas ao cofre', async () => {
    const before = (await Repo.credentials()).length;
    const csv = 'título,usuário,senha,URL\nGmail,lucas@gmail.com,G#mail2026!,https://mail.google.com\nNubank,lucas,Nu#2026!,nubank.com.br\n';
    const { preview, result } = await importText(csv);
    expect(preview.counts).toMatchObject({ total: 2, new: 2, duplicate: 0, error: 0 });
    expect(result.added).toBe(2);
    expect((await Repo.credentials()).length).toBe(before + 2);
    expect(IMPORT_SUCCESS).toBe('Importação concluída com sucesso');
    const gmail = (await Repo.credentials()).find(c => c.title === 'Gmail')!;
    expect(gmail).toMatchObject({ username: 'lucas@gmail.com', password: 'G#mail2026!', category: 'email' });
    // A importação fica registrada no histórico de versões
    expect((await Repo.versions(gmail.id))[0].changeType).toBe('import');
  });

  it('Cenário: Erro de formatação no CSV, aborta sem gravar nada', async () => {
    const before = (await Repo.credentials()).length;
    expect(() => ImportService.read(fixture('erro-delimitador.csv'))).toThrow(/^Erro de formatação/);
    expect((await Repo.credentials()).length).toBe(before);
  });
});

describe('Prévia e duplicadas', () => {
  it('a prévia não grava nada e conta novas, duplicadas e com erro', async () => {
    const before = (await Repo.credentials()).length;
    const csv = 'name,url,username,password\nGmail,https://mail.google.com,lucas@gmail.com,outra\nNovo,https://novo.com,eu,x\n,,,\n';
    const r = ImportService.read(csv);
    if (r.kind !== 'parsed') throw new Error();
    const p = await ImportService.preview(r.parsed, 'chrome.csv');
    expect(p.formatLabel).toBe('Chrome / Edge (CSV)');
    expect(p.counts).toMatchObject({ total: 3, new: 1, duplicate: 1, error: 1 });
    expect(p.items[2].error).toMatch(/Linha 4/);
    expect((await Repo.credentials()).length).toBe(before);
  });

  it('ignorar / substituir / manter as duas', async () => {
    const csv = 'name,url,username,password\nGmail,https://mail.google.com,lucas@gmail.com,Nova#Senha2026\n';
    const count = async () => (await Repo.credentials()).filter(c => c.title === 'Gmail').length;
    const skip = await importText(csv, 'skip');
    expect(skip.result).toMatchObject({ added: 0, skipped: 1 });
    expect(await count()).toBe(1);

    const rep = await importText(csv, 'replace');
    expect(rep.result).toMatchObject({ replaced: 1, added: 0 });
    const gmails = (await Repo.credentials()).filter(c => c.title === 'Gmail');
    expect(gmails).toHaveLength(1);
    expect(gmails[0].password).toBe('Nova#Senha2026');
    expect(gmails[0].category).toBe('email');

    const both = await importText(csv, 'keep_both');
    expect(both.result.added).toBe(1);
    expect(await count()).toBe(2);
  });

  it('linhas repetidas dentro do mesmo arquivo contam como duplicadas', async () => {
    const r = ImportService.read('name,url,username,password\nX,https://x.com,a,1\nX,https://x.com,a,1\n');
    if (r.kind !== 'parsed') throw new Error();
    expect((await ImportService.preview(r.parsed)).counts).toMatchObject({ new: 1, duplicate: 1 });
  });
});

describe('Importação dos gerenciadores', () => {
  it('Bitwarden JSON cria pastas aninhadas, notas e formulários', async () => {
    const { result } = await importText(fixture('bitwarden.json'));
    expect(result).toMatchObject({ added: 5, failed: 0 });
    const folders = await Repo.folders();
    const trabalho = folders.find(f => f.name === 'Trabalho' && !f.parentId)!;
    const clientes = folders.find(f => f.name === 'Clientes')!;
    expect(clientes.parentId).toBe(trabalho.id);
    const portal = (await Repo.credentials()).find(c => c.title === 'Portal do Cliente')!;
    expect(portal.folderId).toBe(clientes.id);
    expect((await vaultDb.all<SecureNote>('notes')).map(n => n.title)).toContain('Chave da carteira');
    expect((await vaultDb.all<any>('forms')).map(f => f.kind).sort()).toEqual(['card', 'identity']);
  });

  it('reimportar o mesmo arquivo reaproveita as pastas e detecta tudo como duplicado', async () => {
    const foldersBefore = (await Repo.folders()).length;
    const r = ImportService.read(fixture('bitwarden.json'));
    if (r.kind !== 'parsed') throw new Error();
    const p = await ImportService.preview(r.parsed);
    expect(p.counts).toMatchObject({ new: 0, duplicate: 5 });
    await ImportService.apply(p, 'keep_both');
    expect((await Repo.folders()).length).toBe(foldersBefore);
  });

  it.each(['chrome.csv', 'firefox.csv', 'bitwarden.csv', 'lastpass.csv', '1password.csv', 'keepassxc.csv', 'keepass2.csv', 'generico-ptbr.csv', 'custodia.json'])(
    '%s importa sem erros',
    async file => {
      const { result } = await importText(fixture(file), 'keep_both');
      expect(result.failed).toBe(0);
      expect(result.added).toBeGreaterThan(0);
    },
  );

  it('JSON do Custódia preserva histórico de senhas, domínios e caminho de pastas', async () => {
    const inter = (await Repo.credentials()).find(c => c.title === 'Inter')!;
    expect(inter.passwordHistory[0].password).toBe('Antiga#Senha1');
    expect(inter.associatedDomains).toEqual(['bancointer.com.br']);
    expect(Repo.folderPath(await Repo.folders(), inter.folderId)).toBe('Finanças › Bancos');
  });

  it('abuso: arquivo acima do limite e excesso de itens são recusados antes de ler', async () => {
    const big = { name: 'x.csv', mime: 'text/csv', size: MAX_IMPORT_BYTES + 1, base64: '' };
    expect(() => ImportService.decodeFile(big)).toThrow(/passa de 10 MB/);
    const many = 'name,url,username,password\n' + 'a,https://a.com,u,p\n'.repeat(5001);
    expect(() => ImportService.read(many)).toThrow(/limite de 5000 linhas/);
    const json = JSON.stringify({ format: 'custodia-export', version: 1, credentials: Array(5001).fill({ title: 'a', password: 'b' }) });
    expect(() => ImportService.read(json)).toThrow(/limite de 5000 itens/);
  });

  it('abuso: nomes de pasta gigantes e profundos demais são cortados', async () => {
    const deep = Array.from({ length: 15 }, (_, i) => `N${i}${'x'.repeat(100)}`).join('/');
    const csv = `folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n${deep},,login,Profunda,,,0,https://deep.com,u,p,\n`;
    const { result } = await importText(csv);
    expect(result.failed).toBe(0);
    const c = (await Repo.credentials()).find(x => x.title === 'Profunda')!;
    const folders = await Repo.folders();
    expect(Repo.folderPath(folders, c.folderId).split(' › ')).toHaveLength(10);
    expect(folders.every(f => f.name.length <= 60)).toBe(true);
  });
});

describe('Abuso: esquemas de URL perigosos no arquivo importado', () => {
  it('intent://, file://, content:// e javascript: são descartados; androidapp:// vira o app associado', () => {
    expect(safeUrl('intent://scan/#Intent;scheme=zxing;package=com.evil;end')).toEqual({ url: '', androidPackage: null });
    expect(safeUrl('file:///data/data/com.custodia/databases/x').url).toBe('');
    expect(safeUrl('content://com.evil.provider/x').url).toBe('');
    expect(safeUrl(['javascript', 'alert(1)'].join(':')).url).toBe('');
    expect(safeUrl('androidapp://com.nu.production')).toEqual({ url: '', androidPackage: 'com.nu.production' });
    expect(safeUrl('https://nubank.com.br').url).toBe('https://nubank.com.br');
    expect(safeUrl('nubank.com.br').url).toBe('nubank.com.br');
    expect(safeUrl('intranet.local:8080/login').url).toBe('intranet.local:8080/login');
    expect(safeUrl('localhost:3000').url).toBe('localhost:3000');
  });

  it('na importação, o endereço perigoso some e o app Android do Bitwarden é associado', async () => {
    const csv = 'name,url,username,password\nMalicioso,intent://x#Intent;end,ana,Ana#2026senha\nNubank App,androidapp://com.nu.production,ana,Nu#2026senha\n';
    const { result } = await importText(csv);
    expect(result.added).toBe(2);
    const all = await Repo.credentials();
    expect(all.find(c => c.title === 'Malicioso')!.url).toBe('');
    expect(all.find(c => c.title === 'Nubank App')!.androidPackages).toEqual(['com.nu.production']);
  });
});

describe('Exportação', () => {
  it('exportar exige reautenticação recente (senha mestra)', async () => {
    ExportService._resetReauth();
    await expect(ExportService.build('csv')).rejects.toThrow(/Confirme sua identidade/);
    await expect(ExportService.confirmIdentity({ method: 'password', password: 'errada' })).rejects.toThrow('Senha mestra incorreta.');
    await ExportService.confirmIdentity({ method: 'password', password: MASTER });
    await expect(ExportService.build('csv')).resolves.toBeTruthy();
  });

  it('biometria desativada não serve como reautenticação', async () => {
    await expect(ExportService.confirmIdentity({ method: 'biometric' })).rejects.toThrow(/biometria não está ativada/);
  });

  it('CSV legível neutraliza fórmulas e volta igual ao reimportar (formato Custódia)', async () => {
    await Repo.saveCredential(newCredential({ title: '=HYPERLINK("http://evil")', username: '@admin', password: '-1+1', url: 'https://formula.com' }));
    const file = await ExportService.build('csv');
    expect(file.name).toMatch(/\.csv$/);
    const rows = parseCsv(file.content);
    expect(rows[0]).toEqual(['name', 'url', 'username', 'password', 'note', 'folder', 'category', 'favorite', 'totp']);
    const evil = rows.find(r => r[2] === "'@admin")!;
    expect(evil[0]).toBe('\'=HYPERLINK("http://evil")');
    expect(evil[3]).toBe("'-1+1");
    const parsed = ImportService.read(file.content);
    if (parsed.kind !== 'parsed') throw new Error();
    expect(parsed.parsed.format).toBe('custodia_csv');
    const back = parsed.parsed.items.find(i => i.credential?.username === '@admin')!;
    expect(back.credential).toMatchObject({ title: '=HYPERLINK("http://evil")', password: '-1+1' });
  });

  it('JSON legível inclui credenciais, pastas, notas e formulários', async () => {
    const file = await ExportService.build('json');
    const json = JSON.parse(file.content);
    expect(json.format).toBe('custodia-export');
    expect(json.credentials.length).toBeGreaterThan(5);
    expect(json.notes.length).toBeGreaterThan(0);
    expect(json.forms.length).toBeGreaterThan(0);
    expect(json.folders.length).toBeGreaterThan(0);
  });

  it('JSON cifrado com senha temporária: ilegível sem a senha e reimportável com ela', async () => {
    await expect(ExportService.build('json_encrypted', { password: 'curta' })).rejects.toThrow(/12 caracteres/);
    const file = await ExportService.build('json_encrypted', { password: 'ABCD-EFGH-JKLM-NPQR-STUV-WXYZ', ...fast });
    expect(file.content).not.toContain('Nova#Senha2026');
    const r = ImportService.read(file.content);
    expect(r.kind).toBe('encrypted');
    if (r.kind !== 'encrypted') throw new Error();
    await expect(ImportService.unlock(r.envelope, 'errada', fastOpen)).rejects.toThrow('Falha na descriptografia. Senha inválida.');
    const parsed = await ImportService.unlock(r.envelope, 'ABCD-EFGH-JKLM-NPQR-STUV-WXYZ', fastOpen);
    expect(parsed.format).toBe('custodia_json');
    const p = await ImportService.preview(parsed);
    expect(p.counts.new).toBe(0); // tudo já está no cofre
  });

  it('respeita "Bloquear exportação" da pasta (e das subpastas)', async () => {
    const secreta = { ...newFolder('Secreta'), policy: { ...DefaultFolderPolicy, blockExport: true } };
    await Repo.saveFolder(secreta);
    const sub = newFolder('Sub', secreta.id);
    await Repo.saveFolder(sub);
    await Repo.saveCredential(newCredential({ title: 'Cofre da empresa', password: 'Segredo#Bloqueado1', folderId: sub.id }));
    const csv = await ExportService.build('csv');
    expect(csv.content).not.toContain('Segredo#Bloqueado1');
    expect(csv.omitted).toBe(1);
    const json = JSON.parse((await ExportService.build('json')).content);
    expect(json.folders.map((f: any) => f.name)).not.toContain('Secreta');
    const inv = await ExportService.buildInventory('csv');
    expect(inv.content).not.toContain('Cofre da empresa');
  });

  it('bloquear o cofre cancela a reautenticação', async () => {
    const { bus, Events } = require('../services/events');
    bus.emit(Events.LOCKED, 'teste');
    await expect(ExportService.build('csv')).rejects.toThrow(/Confirme sua identidade/);
    await ExportService.confirmIdentity({ method: 'password', password: MASTER });
  });
});

describe(' Inventário sem senhas', () => {
  it('CSV só com metadados: sem senha, notas, histórico ou campos ocultos', async () => {
    const c = await Repo.saveCredential(
      newCredential({
        title: 'Inventariado',
        username: 'inv',
        password: 'NaoPodeAparecer#2026',
        url: 'https://inv.com',
        notes: 'nota secreta',
        customFields: [{ id: '1', label: 'PIN', value: 'pin-secreto', type: 'hidden' }],
        expiresAt: '2020-01-01T00:00:00.000Z',
      }),
    );
    await Repo.recordUsage(c.id);
    const file = await ExportService.buildInventory('csv');
    for (const secret of ['NaoPodeAparecer#2026', 'nota secreta', 'pin-secreto', 'Antiga#Senha1']) expect(file.content).not.toContain(secret);
    const rows = parseCsv(file.content);
    expect(rows[0]).toEqual(['Título', 'Usuário', 'Site', 'Categoria', 'Pasta', 'Criada em', 'Atualizada em', 'Senha trocada em', 'Força', 'Idade da senha (dias)', 'Vence em', 'Situação', 'Vezes utilizada', 'Último uso']);
    const row = rows.find(r => r[0] === 'Inventariado')!;
    expect(row[11]).toBe('Vencida');
    expect(row[12]).toBe('1');
    expect(row[8]).toMatch(/Forte|Muito forte|Média/);
  });

  it('JSON do inventário e campos de cada conta', async () => {
    const file = await ExportService.buildInventory('json');
    const json = JSON.parse(file.content);
    expect(json.format).toBe('custodia-inventory');
    const keys = Object.keys(json.accounts[0]).sort();
    expect(keys).toEqual(['category', 'createdAt', 'expiresAt', 'folder', 'lastUsedAt', 'passwordAgeDays', 'passwordChangedAt', 'status', 'strength', 'title', 'updatedAt', 'url', 'usageCount', 'username']);
    expect(file.content).not.toMatch(/"password"/);
    expect(inventoryEntries([newCredential({ title: 'x', password: '' })], [])[0].strength).toBe('Sem senha');
  });

  it('senha opcional: o inventário cifrado abre só com a senha e não é importável', async () => {
    const file = await ExportService.buildInventory('csv', { password: 'Inventario#Senha2026', ...fast });
    expect(file.content).not.toContain('Inventariado');
    const r = ImportService.read(file.content);
    if (r.kind !== 'encrypted') throw new Error();
    await expect(ImportService.unlock(r.envelope, 'Inventario#Senha2026', fastOpen)).rejects.toThrow(/inventário/);
    await expect(ExportService.openInventory(r.envelope, 'errada', fastOpen)).rejects.toThrow('Falha na descriptografia. Senha inválida.');
    const open = await ExportService.openInventory(r.envelope, 'Inventario#Senha2026', fastOpen);
    expect(open.mime).toBe('text/csv');
    expect(open.content).toContain('Inventariado');
  });

  it('salvar usa o seletor do sistema (SAF); sem módulo nativo devolve false', async () => {
    expect(await ExportService.save({ name: 'a.csv', mime: 'text/csv', content: 'x' })).toBe(false);
    expect(ImportService.decodeFile({ name: 'a.csv', mime: 'text/csv', size: 3, base64: toB64(utf8('ção')) })).toBe('ção');
  });
});
