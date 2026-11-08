// Notas seguras (com anexos) e Formulários (cartões, endereços e identidades), parte de cadastro.
import { Vault } from '../services/VaultService';
import { NOTE_LIMITS, NoteService, base64Size, headBytes, newNote, resolveMime, safeFileName, sniffMime } from '../services/NoteService';
import {
  FormService,
  birthDateValid,
  cepValid,
  cpfValid,
  detectCardBrand,
  expiryError,
  formTitle,
  formatCardNumber,
  formatCep,
  formatCpf,
  lookupCep,
  luhnValid,
  maskCardNumber,
  maskCpf,
  newFormItem,
} from '../services/FormService';
import { Repo, ValidationError, newFolder } from '../services/Repository';
import { VaultDatabase, vaultDb } from '../db/Database';
import { Files, __queueMockFile, __resetMockFiles } from '../native/files';
import { Address, Identity, PaymentCard } from '../types/models';

jest.setTimeout(120000);

const MASTER = 'Cofre#Seguro2026';
const b64 = (bytes: number[] | string) => Buffer.from(bytes as any).toString('base64');
const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const PDF = b64('%PDF-1.7 conteudo do documento');
const EXE = b64([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

let profileId = '';
beforeAll(async () => {
  const r = await Vault.createVault({ masterPassword: MASTER });
  profileId = r.profile.id;
});

afterEach(() => __resetMockFiles());

const card = (patch: Partial<PaymentCard> = {}): PaymentCard => ({ ...(newFormItem('card') as PaymentCard), holder: 'Lucas Marins', number: '4111 1111 1111 1111', expMonth: '12', expYear: '39', cvv: '123', ...patch });
const address = (patch: Partial<Address> = {}): Address => ({ ...(newFormItem('address') as Address), zipCode: '01310-100', street: 'Avenida Paulista', number: '1000', city: 'São Paulo', state: 'sp', ...patch });
const identity = (patch: Partial<Identity> = {}): Identity => ({ ...(newFormItem('identity') as Identity), fullName: 'Lucas Marins', cpf: '529.982.247-25', email: 'Lucas@Exemplo.com', ...patch });

// =============================================================================
// Notas seguras
// =============================================================================
describe('BDD Notas seguras', () => {
  beforeEach(() => vaultDb.clearCollection('notes'));

  it('Cenário: Criar nota segura, a nota fica armazenada de forma criptografada', async () => {
    const note = await NoteService.save(newNote({ title: 'Chave de recuperação - Carteira', content: 'abandon ability able about above absent', category: 'recovery_key' }));
    expect((await NoteService.get(note.id))!.content).toContain('abandon ability');
    // Fica no banco do cofre (SQLCipher, chave = DEK); com outra chave o arquivo não abre
    const { __dbs } = require('@op-engineering/op-sqlite');
    const entry = __dbs.get(VaultDatabase.fileName(profileId));
    expect(entry.db.prepare("SELECT count(*) AS n FROM docs WHERE collection = 'notes'").get().n).toBe(1);
    const { open } = require('@op-engineering/op-sqlite');
    await expect(open({ name: VaultDatabase.fileName(profileId), encryptionKey: 'chave-errada' }).execute('SELECT 1')).rejects.toThrow('file is not a database');
  });

  it('Cenário: Edição de nota existente, as alterações são salvas com sucesso', async () => {
    const note = await NoteService.save(newNote({ title: 'Wi-Fi Casa', content: 'Rede: Casa', category: 'wifi' }));
    const edited = await NoteService.save({ ...note, content: `${note.content}\nSenha: banana-azul-42` });
    const read = (await NoteService.get(note.id))!;
    expect(read.content).toBe('Rede: Casa\nSenha: banana-azul-42');
    expect(read.createdAt).toBe(note.createdAt);
    expect(edited.updatedAt >= note.updatedAt).toBe(true);
  });

  it('título obrigatório e limites de tamanho', async () => {
    await expect(NoteService.save(newNote({ title: '  ' }))).rejects.toThrow('O título é obrigatório');
    await expect(NoteService.save(newNote({ title: 'x'.repeat(NOTE_LIMITS.title + 1) }))).rejects.toThrow(`até ${NOTE_LIMITS.title} caracteres`);
    await expect(NoteService.save(newNote({ title: 'Grande', content: 'x'.repeat(NOTE_LIMITS.content + 1) }))).rejects.toThrow(ValidationError);
  });

  it('busca sem acentos por título, texto, categoria e nome de anexo; categorias e favoritas', async () => {
    await NoteService.save(newNote({ title: 'Agência e conta', content: 'Banco Itaú ag 1234', category: 'bank_info' }));
    await NoteService.save(newNote({ title: 'Wi-Fi do escritório', content: 'senha do roteador', category: 'wifi', favorite: true }));
    const withFile = NoteService.addAttachment(newNote({ title: 'Passaporte' }), { name: 'passaporte.pdf', mime: 'application/pdf', size: 0, base64: PDF });
    await NoteService.save(withFile);
    const all = await NoteService.list();
    expect(all[0].title).toBe('Wi-Fi do escritório'); // favorita primeiro
    expect(NoteService.search(all, 'itau').map(n => n.title)).toEqual(['Agência e conta']);
    expect(NoteService.search(all, 'dados bancarios').map(n => n.title)).toEqual(['Agência e conta']);
    expect(NoteService.search(all, 'ESCRITORIO roteador')).toHaveLength(1);
    expect(NoteService.search(all, 'passaporte.pdf')).toHaveLength(1);
    expect(NoteService.search(all, 'inexistente')).toHaveLength(0);
    expect(NoteService.search(all, '   ')).toHaveLength(3);
    expect(NoteService.categories()).toContain('recovery_key');
    expect(NoteService.preview('linha 1\n\n linha 2')).toBe('linha 1 linha 2');
  });

  it('limite de quantidade de notas (importação/sincronização em massa)', async () => {
    const all = jest.spyOn(vaultDb, 'all').mockResolvedValueOnce(new Array(NOTE_LIMITS.notes).fill({}));
    try {
      await expect(NoteService.save(newNote({ title: 'Mais uma' }))).rejects.toThrow(`Use no máximo ${NOTE_LIMITS.notes} notas`);
    } finally {
      all.mockRestore();
    }
  });

  it('pasta inexistente é descartada; categoria desconhecida vira "Outros"', async () => {
    const f = newFolder('Pessoal');
    await Repo.saveFolder(f);
    const ok = await NoteService.save(newNote({ title: 'Na pasta', folderId: f.id }));
    expect(ok.folderId).toBe(f.id);
    const bad = await NoteService.save({ ...newNote({ title: 'Pasta falsa', folderId: 'nao-existe' }), category: 'hack' as any });
    expect(bad.folderId).toBeNull();
    expect(bad.category).toBe('other');
  });
});

describe('Anexos das notas', () => {
  it('limite por anexo, quantidade e total', () => {
    // base64 com `bytes` bytes (múltiplo de 3 → sem "=")
    const ofSize = (bytes: number) => 'A'.repeat(Math.ceil(bytes / 3) * 4);
    const big = ofSize(NOTE_LIMITS.attachmentBytes + 3);
    expect(base64Size(big)).toBeGreaterThan(NOTE_LIMITS.attachmentBytes);
    expect(() => NoteService.addAttachment(newNote({ title: 'n' }), { name: 'grande.bin', mime: 'application/octet-stream', size: 0, base64: big })).toThrow('Cada anexo pode ter até 5,0 MB');

    let note = newNote({ title: 'n' });
    for (let i = 0; i < NOTE_LIMITS.attachments; i++) note = NoteService.addAttachment(note, { name: `${i}.txt`, mime: 'text/plain', size: 0, base64: b64('oi') });
    expect(() => NoteService.addAttachment(note, { name: 'x.txt', mime: 'text/plain', size: 0, base64: b64('oi') })).toThrow(`no máximo ${NOTE_LIMITS.attachments} anexos`);

    // Soma acima do total (cada um dentro do limite individual)
    const four = ofSize(4 * 1024 * 1024);
    let heavy = newNote({ title: 'pesada' });
    heavy = NoteService.addAttachment(heavy, { name: '1.bin', mime: '', size: 0, base64: four });
    heavy = NoteService.addAttachment(heavy, { name: '2.bin', mime: '', size: 0, base64: four });
    heavy = NoteService.addAttachment(heavy, { name: '3.bin', mime: '', size: 0, base64: four });
    expect(() => NoteService.addAttachment(heavy, { name: '4.bin', mime: '', size: 0, base64: four })).toThrow('podem somar até 15,0 MB');
  });

  it('MIME validado pelo conteúdo: imagem falsa (executável renomeado) é recusada', () => {
    expect(sniffMime(PNG)).toBe('image/png');
    expect(sniffMime(PDF)).toBe('application/pdf');
    expect(headBytes(PNG, 4)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(() => resolveMime('image/png', EXE, 'foto.png')).toThrow('O conteúdo de "foto.png" não corresponde ao tipo do arquivo');
    expect(() => resolveMime('application/pdf', b64('texto'), 'doc.pdf')).toThrow('não corresponde');
    // Declarado genérico, conteúdo PNG: vale o detectado
    expect(resolveMime('application/octet-stream', PNG, 'x')).toBe('image/png');
    // Tipo fora da lista (ex.: script) vira binário genérico, nunca pré-visualizado
    expect(resolveMime('text/html', b64('<script>alert(1)</script>'), 'x.html')).toBe('application/octet-stream');
    expect(resolveMime('text/plain; charset=utf-8', b64('ola'), 'a.txt')).toBe('text/plain');
    expect(() => NoteService.addAttachment(newNote({ title: 'n' }), { name: 'foto.jpg', mime: 'image/jpeg', size: 0, base64: EXE })).toThrow('não corresponde');
  });

  it('base64 corrompido e nomes de arquivo perigosos', () => {
    expect(base64Size('abc')).toBe(-1);
    expect(base64Size('@@@@')).toBe(-1);
    expect(() => NoteService.addAttachment(newNote({ title: 'n' }), { name: 'x', mime: 'text/plain', size: 0, base64: 'não é base64' })).toThrow('está corrompido');
    expect(safeFileName('../../databases/custodia.sqlite')).toBe('_.._databases_custodia.sqlite');
    expect(safeFileName('a\u0000b\nc.txt')).toBe('a_b_c.txt');
    expect(safeFileName('')).toBe('anexo');
    expect(safeFileName('.oculto')).toBe('oculto');
    expect(safeFileName('x'.repeat(300))).toHaveLength(NOTE_LIMITS.attachmentName);
  });

  it('o tamanho gravado é o real (o informado pelo seletor é ignorado) e o anexo removido sai da nota', async () => {
    let note = NoteService.addAttachment(newNote({ title: 'Com anexo' }), { name: 'a.png', mime: 'image/png', size: 1, base64: PNG });
    expect(note.attachments[0]).toMatchObject({ name: 'a.png', mime: 'image/png', size: 16 });
    note = await NoteService.save(note);
    note = await NoteService.save(NoteService.removeAttachment(note, note.attachments[0].id));
    expect((await NoteService.get(note.id))!.attachments).toEqual([]);
  });

  it('registro adulterado (sincronização/importação) com anexo gigante ou campos extras não é salvo como veio', async () => {
    const forged: any = { ...newNote({ title: 'Forjada' }), extra: 'x'.repeat(1000), attachments: [{ id: 'a', name: '../x', mime: 'image/png', size: 1, data: EXE }] };
    await expect(NoteService.save(forged)).rejects.toThrow('não corresponde');
    forged.attachments = [];
    const saved: any = await NoteService.save(forged);
    expect(saved.extra).toBeUndefined();
  });

  it('seletor de arquivos: cancelado devolve null; erro do nativo chega à tela', async () => {
    __queueMockFile(null);
    expect(await Files.pickFile(NOTE_LIMITS.attachmentBytes)).toBeNull();
    __queueMockFile(new Error('O anexo passa do limite de 5 MB'));
    await expect(Files.pickFile(NOTE_LIMITS.attachmentBytes)).rejects.toThrow('passa do limite');
  });
});

// =============================================================================
// Formulários
// =============================================================================
describe('Cartões', () => {
  beforeEach(() => vaultDb.clearCollection('forms'));

  it('Luhn e bandeira (Visa, Mastercard 2-série, Amex, Elo, Hipercard, Diners)', () => {
    expect(luhnValid('4111 1111 1111 1111')).toBe(true);
    expect(luhnValid('4111 1111 1111 1112')).toBe(false);
    expect(luhnValid('1234')).toBe(false);
    expect(detectCardBrand('4111111111111111')).toBe('visa');
    expect(detectCardBrand('5555555555554444')).toBe('mastercard');
    expect(detectCardBrand('2221000000000009')).toBe('mastercard');
    expect(detectCardBrand('378282246310005')).toBe('amex');
    expect(detectCardBrand('6362970000457013')).toBe('elo');
    expect(detectCardBrand('4011780000000000')).toBe('elo');
    expect(detectCardBrand('6062825624254001')).toBe('hipercard');
    expect(detectCardBrand('30569309025904')).toBe('diners');
    expect(detectCardBrand('9999')).toBe('other');
    expect(formatCardNumber('378282246310005')).toBe('3782 822463 10005');
    expect(formatCardNumber('4111111111111111')).toBe('4111 1111 1111 1111');
    expect(maskCardNumber('4111111111111111')).toBe('•••• 1111');
  });

  it('validade e CVV', () => {
    const now = new Date(2026, 10, 3);
    expect(expiryError('11', '26', now)).toBeNull();
    expect(expiryError('10', '26', now)).toBe('Cartão vencido');
    expect(expiryError('13', '30', now)).toBe('Mês da validade inválido');
    expect(expiryError('1', '30', now)).toBe('Informe a validade no formato MM/AA');
    expect(FormService.validate(card({ number: '378282246310005', cvv: '123' })).cvv).toBe('O CVV tem 4 dígitos');
    expect(FormService.validate(card({ cvv: '' })).cvv).toBeUndefined();
  });

  it('salva só dígitos, recalcula a bandeira e recusa número inválido', async () => {
    await expect(FormService.save(card({ number: '4111 1111 1111 1112' }))).rejects.toThrow('Número de cartão inválido');
    const saved = (await FormService.save(card({ brand: 'amex' }))) as PaymentCard;
    expect(saved).toMatchObject({ number: '4111111111111111', brand: 'visa', holder: 'LUCAS MARINS' });
    expect(formTitle(saved)).toBe('Visa final 1111');
    expect(FormService.fieldsForAutofill(saved)).toEqual([
      { field: 'cc-number', value: '4111111111111111' },
      { field: 'cc-name', value: 'LUCAS MARINS' },
      { field: 'cc-exp-month', value: '12' },
      { field: 'cc-exp-year', value: '2039' },
      { field: 'cc-csc', value: '123' },
    ]);
  });
});

describe('Endereços (telas 09/10)', () => {
  beforeEach(() => vaultDb.clearCollection('forms'));

  it('CEP com 8 dígitos e estado válido; só um endereço principal', async () => {
    expect(cepValid('01310-100')).toBe(true);
    expect(cepValid('01310100')).toBe(true);
    expect(cepValid('0131-0100')).toBe(false);
    expect(formatCep('01310100')).toBe('01310-100');
    await expect(FormService.save(address({ zipCode: '123' }))).rejects.toThrow('O CEP deve ter 8 dígitos');
    await expect(FormService.save(address({ state: 'XX' }))).rejects.toThrow('Estado inválido');
    const a = await FormService.save(address({ label: 'Casa', isPrimary: true, reference: 'Perto do metrô' }));
    expect(a).toMatchObject({ state: 'SP', country: 'Brasil', reference: 'Perto do metrô' });
    const b = await FormService.save(address({ label: 'Trabalho', isPrimary: true }));
    const list = (await FormService.list('address')) as Address[];
    expect(list.map(x => [x.label, x.isPrimary])).toEqual([
      ['Trabalho', true],
      ['Casa', false],
    ]);
    expect(FormService.fieldsForAutofill(b).find(p => p.field === 'street-address')!.value).toBe('Avenida Paulista, 1000');
  });

  it('ViaCEP: HTTPS, preenche os campos e valida a resposta', async () => {
    const calls: string[] = [];
    const fake: any = async (url: string) => {
      calls.push(url);
      return { ok: true, text: async () => JSON.stringify({ cep: '01310-100', logradouro: 'Avenida Paulista', bairro: 'Bela Vista', localidade: 'São Paulo', uf: 'SP', complemento: 'de 612 a 1510 - lado par' }) };
    };
    const r = await lookupCep('01310-100', fake);
    expect(calls).toEqual(['https://viacep.com.br/ws/01310100/json/']);
    expect(r).toEqual({ street: 'Avenida Paulista', neighborhood: 'Bela Vista', city: 'São Paulo', state: 'SP', complement: 'de 612 a 1510 - lado par' });
    // CEP inválido não chega a consultar
    expect(await lookupCep('abc', fake)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('ViaCEP offline, lento, com erro ou resposta adulterada: devolve null e o cadastro segue manual', async () => {
    const offline: any = async () => {
      throw new TypeError('Network request failed');
    };
    expect(await lookupCep('01310100', offline)).toBeNull();
    const slow: any = () => new Promise(() => {});
    const t0 = Date.now();
    expect(await lookupCep('01310100', slow, 50)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
    const notFound: any = async () => ({ ok: true, text: async () => '{"erro": true}' });
    expect(await lookupCep('99999999', notFound)).toBeNull();
    const http500: any = async () => ({ ok: false, text: async () => '' });
    expect(await lookupCep('01310100', http500)).toBeNull();
    const huge: any = async () => ({ ok: true, text: async () => 'x'.repeat(10000) });
    expect(await lookupCep('01310100', huge)).toBeNull();
    const badUf: any = async () => ({ ok: true, text: async () => JSON.stringify({ localidade: 'X', uf: 'ZZ' }) });
    expect(await lookupCep('01310100', badUf)).toBeNull();
    const notJson: any = async () => ({ ok: true, text: async () => '<html>' });
    expect(await lookupCep('01310100', notJson)).toBeNull();
    const control: any = async () => ({ ok: true, text: async () => JSON.stringify({ localidade: 'São\u0000 Paulo', uf: 'SP', logradouro: 'Rua\u001b[31m A' }) });
    expect(await lookupCep('01310100', control)).toMatchObject({ city: 'São Paulo', street: 'Rua[31m A' });
  });
});

describe('Identidades', () => {
  beforeEach(() => vaultDb.clearCollection('forms'));

  it('CPF com dígito verificador, e-mail, telefone e data de nascimento', async () => {
    expect(cpfValid('529.982.247-25')).toBe(true);
    expect(cpfValid('52998224724')).toBe(false);
    expect(cpfValid('111.111.111-11')).toBe(false);
    expect(cpfValid('123')).toBe(false);
    expect(formatCpf('52998224725')).toBe('529.982.247-25');
    expect(maskCpf('52998224725')).toBe('***.982.247-**');
    expect(birthDateValid('29/02/2000')).toBe(true);
    expect(birthDateValid('29/02/2001')).toBe(false);
    expect(birthDateValid('01/01/2999')).toBe(false);
    await expect(FormService.save(identity({ cpf: '529.982.247-24' }))).rejects.toThrow('CPF inválido');
    await expect(FormService.save(identity({ email: 'sem-arroba' }))).rejects.toThrow('E-mail inválido');
    await expect(FormService.save(identity({ fullName: '' }))).rejects.toThrow('Informe o nome completo');
    await expect(FormService.save(identity({ birthDate: '31/04/1990' }))).rejects.toThrow('Data de nascimento inválida');
    const saved = (await FormService.save(identity({ cpf: '52998224725' }))) as Identity;
    expect(saved).toMatchObject({ cpf: '529.982.247-25', email: 'lucas@exemplo.com' });
    expect(FormService.fieldsForAutofill(saved).map(p => p.field)).toEqual(['name', 'email', 'cpf']);
  });

  it('registro adulterado: tipo inválido, campos extras e valores que não são texto', async () => {
    await expect(FormService.save({ ...identity(), kind: 'hack' } as any)).rejects.toThrow('Tipo de formulário inválido');
    const forged: any = { ...identity(), company: { $gt: '' }, extra: 'x'.repeat(5000) };
    const saved: any = await FormService.save(forged);
    expect(saved.extra).toBeUndefined();
    expect(saved.company).toBe('');
    await expect(FormService.save(identity({ company: 'x'.repeat(500) }))).rejects.toThrow('Use até 200 caracteres');
  });

  it('a exclusão remove o formulário', async () => {
    const saved = await FormService.save(identity());
    await FormService.remove(saved.id);
    expect(await FormService.list('identity')).toEqual([]);
  });
});
