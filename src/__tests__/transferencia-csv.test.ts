// parser CSV, detecção de formato dos gerenciadores e envelope cifrado (sem banco)
import fs from 'fs';
import path from 'path';
import { CsvError, detectDelimiter, neutralizeFormula, parseCsv, restoreFormula, toCsv } from '../services/transfer/csv';
import { ImportFormatError, parseCsvFile, parseJsonFile } from '../services/transfer/formats';
import { decryptEnvelope, encryptEnvelope, filePasswordError, generateTemporaryPassword } from '../services/transfer/envelope';
import { sanitizeCredential, sanitizeForm, sanitizeNote } from '../services/transfer/sanitize';
import { LIMITS } from '../services/Repository';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'import', name), 'utf8');

describe('Parser CSV robusto', () => {
  it('aspas, vírgulas, aspas duplicadas e quebra de linha dentro do campo, com CRLF', () => {
    const rows = parseCsv('a,b,c\r\n"1,5","diz ""oi""","linha 1\r\nlinha 2"\r\n');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['1,5', 'diz "oi"', 'linha 1\r\nlinha 2'],
    ]);
  });

  it('BOM, ponto e vírgula (Excel pt-BR), finais de linha CR e linha em branco no fim', () => {
    const text = '﻿título;senha\rGmail;"a;b"\r\r';
    expect(detectDelimiter(text)).toBe(';');
    expect(parseCsv(text)).toEqual([
      ['título', 'senha'],
      ['Gmail', 'a;b'],
    ]);
  });

  it('tabulação como separador e campo vazio no fim da linha', () => {
    expect(parseCsv('a\tb\n1\t\n')).toEqual([
      ['a', 'b'],
      ['1', ''],
    ]);
  });

  it('aspas no meio de campo sem aspas ficam como caractere comum', () => {
    expect(parseCsv('a,b\nx"y,z\n')).toEqual([
      ['a', 'b'],
      ['x"y', 'z'],
    ]);
  });

  it('abuso: aspas sem fechamento, campo gigante, colunas e linhas demais', () => {
    expect(() => parseCsv('a,b\n"aberto,1\n')).toThrow(CsvError);
    expect(() => parseCsv('a\n' + 'x'.repeat(50), { limits: { maxField: 10 } })).toThrow(/passa de 10 caracteres/);
    expect(() => parseCsv(Array(100).fill('c').join(','), { limits: { maxColumns: 64 } })).toThrow(/colunas demais/);
    expect(() => parseCsv('a\n' + '1\n'.repeat(20), { limits: { maxRows: 10 } })).toThrow(/limite de 10 linhas/);
  });

  it('exportação neutraliza fórmulas (=, +, -, @) e a reimportação recupera o valor', () => {
    for (const v of ['=HYPERLINK("http://x")', '+1', '-2+3', '@SUM(A1)', "'já tinha apóstrofo", '\tcmd']) {
      const n = neutralizeFormula(v);
      expect(n.startsWith("'")).toBe(true);
      expect(restoreFormula(n)).toBe(v);
    }
    expect(neutralizeFormula('normal')).toBe('normal');
    const csv = toCsv(['name', 'password'], [['=cmd|calc', 'a,b"c']]);
    expect(csv).toBe('name,password\r\n\'=cmd|calc,"a,b""c"\r\n');
    expect(parseCsv(csv)[1]).toEqual(["'=cmd|calc", 'a,b"c']);
  });
});

describe('Detecção dos formatos dos gerenciadores (fixtures realistas)', () => {
  const cases: [string, string, number][] = [
    ['chrome.csv', 'chrome_csv', 3],
    ['edge.csv', 'chrome_csv', 1],
    ['firefox.csv', 'firefox_csv', 2],
    ['bitwarden.csv', 'bitwarden_csv', 3],
    ['lastpass.csv', 'lastpass_csv', 3],
    ['1password.csv', 'onepassword_csv', 2],
    ['keepassxc.csv', 'keepass_csv', 2],
    ['keepass2.csv', 'keepass_csv', 1],
    ['generico-ptbr.csv', 'generic_csv', 2],
  ];
  it.each(cases)('%s → %s', (file, format, count) => {
    const p = parseCsvFile(fixture(file), 5000);
    expect(p.format).toBe(format);
    expect(p.items).toHaveLength(count);
    expect(p.items.every(i => !i.error)).toBe(true);
  });

  it('Chrome: senha com vírgula e aspas, nota com quebra de linha', () => {
    const [, gh, nu] = parseCsvFile(fixture('chrome.csv'), 5000).items;
    expect(gh.credential).toMatchObject({ title: 'github.com', username: 'lucasmarins', password: 'gh,pass"quote', notes: 'Conta pessoal' });
    expect(nu.credential!.notes).toBe('Cartão roxo\r\nsegunda linha da nota');
  });

  it('Firefox: título a partir do site e datas em milissegundos', () => {
    const [nf] = parseCsvFile(fixture('firefox.csv'), 5000).items;
    expect(nf.credential).toMatchObject({ title: 'netflix.com', username: 'familia@exemplo.com', password: 'Netfl1x!Casa#22' });
    expect(nf.credential!.createdAt).toBe('2024-01-01T00:00:00.000Z');
  });

  it('Bitwarden CSV: pasta aninhada, favorito, TOTP, campos extras e nota segura', () => {
    const [itau, , note] = parseCsvFile(fixture('bitwarden.csv'), 5000).items;
    expect(itau.folderPath).toEqual(['Finanças', 'Bancos']);
    expect(itau.credential).toMatchObject({ title: 'Itaú', favorite: true, password: 'It@u#2026Seguro' });
    expect(itau.credential!.customFields!.map(f => f.label)).toEqual(['TOTP', 'Agência', 'Conta']);
    expect(note).toMatchObject({ kind: 'note', folderPath: ['Pessoal'], note: { title: 'Wi-Fi de casa' } });
  });

  it('LastPass: grupo com barra invertida e "http://sn" vira nota segura', () => {
    const [fb, tw, sn] = parseCsvFile(fixture('lastpass.csv'), 5000).items;
    expect(fb.credential).toMatchObject({ title: 'Facebook', favorite: true });
    expect(tw.folderPath).toEqual(['Social', 'Antigas']);
    expect(tw.credential!.notes).toBe('nota com, vírgula');
    expect(sn.kind).toBe('note');
    expect(sn.note!.content).toContain('Hostname:192.168.0.10');
  });

  it('KeePassXC: o grupo raiz é descartado do caminho de pastas; KeePass 2 usa Account/Login Name', () => {
    const [gmail, ssh] = parseCsvFile(fixture('keepassxc.csv'), 5000).items;
    expect(gmail.folderPath).toEqual([]);
    expect(ssh.folderPath).toEqual(['Trabalho', 'Servidores']);
    const [bb] = parseCsvFile(fixture('keepass2.csv'), 5000).items;
    expect(bb.credential).toMatchObject({ title: 'Banco do Brasil', username: 'lucasbb', url: 'https://www.bb.com.br', notes: 'Conta corrente' });
  });

  it('CSV genérico com ";", BOM e campo entre aspas contendo ";"', () => {
    const [, escola] = parseCsvFile(fixture('generico-ptbr.csv'), 5000).items;
    expect(escola.credential).toMatchObject({ title: 'Escola; portal', password: 'Esc0la;Senha' });
  });

  it('Bitwarden JSON: login, nota, cartão e identidade; pasta "Trabalho/Clientes"', () => {
    const p = parseJsonFile(JSON.parse(fixture('bitwarden.json')));
    expect(p.format).toBe('bitwarden_json');
    expect(p.items.map(i => i.kind)).toEqual(['credential', 'credential', 'note', 'form', 'form']);
    expect(p.items[1].folderPath).toEqual(['Trabalho', 'Clientes']);
    expect(p.items[0].credential!.customFields!.find(f => f.label === 'PIN')!.type).toBe('hidden');
    expect(p.items[3].form).toMatchObject({ kind: 'card', number: '5555444433331111', cvv: '123' });
    expect(p.items[4].form).toMatchObject({ kind: 'identity', fullName: 'Lucas Marins', cpf: '123.456.789-00' });
  });

  it('JSON do Custódia: credenciais com caminho de pastas, notas e formulários', () => {
    const p = parseJsonFile(JSON.parse(fixture('custodia.json')));
    expect(p.format).toBe('custodia_json');
    expect(p.items.find(i => i.kind === 'credential')!.folderPath).toEqual(['Finanças', 'Bancos']);
    expect(p.items.map(i => i.kind).sort()).toEqual(['credential', 'form', 'note']);
  });
});

describe('BDD: Erro de formatação no CSV', () => {
  it.each(['erro-colunas.csv', 'erro-delimitador.csv', 'erro-aspas.csv'])('%s: exibe "Erro de formatação" e aborta', file => {
    expect(() => parseCsvFile(fixture(file), 5000)).toThrow(/^Erro de formatação/);
  });

  it('colunas desconhecidas junto com as conhecidas também abortam', () => {
    expect(() => parseCsvFile('título,senha,coluna_estranha\nA,b,c\n', 5000)).toThrow(/colunas desconhecidas: coluna_estranha/);
  });

  it('linhas que não seguem o cabeçalho: a maioria aborta, poucas viram erro na prévia', () => {
    expect(() => parseCsvFile('name,url,username,password\na,b\nc,d\n', 5000)).toThrow(ImportFormatError);
    const p = parseCsvFile('name,url,username,password\na,u,x,y\nb,u,x,y\nc,d\n', 5000);
    expect(p.items[2].error).toMatch(/Linha 4: número de colunas/);
  });

  it('JSON: exportação cifrada do Bitwarden, inventário e formato desconhecido', () => {
    expect(() => parseJsonFile(JSON.parse(fixture('bitwarden-encrypted.json')))).toThrow(/exportação cifrada do Bitwarden/);
    expect(() => parseJsonFile({ format: 'custodia-inventory' })).toThrow(/inventário/);
    expect(() => parseJsonFile({ foo: 1 })).toThrow(/formato JSON desconhecido/);
  });
});

describe('Validação dos campos importados (entrada hostil)', () => {
  it('respeita LIMITS do Repository', () => {
    expect(() => sanitizeCredential({ title: 'x', password: 'a'.repeat(LIMITS.password + 1) })).toThrow(/senha passa de/);
    expect(() => sanitizeCredential({ title: 'x'.repeat(LIMITS.title + 1), password: 'a' })).toThrow(/título/);
    expect(() => sanitizeCredential({ title: 'x', password: 'a', customFields: Array(LIMITS.customFields + 1).fill({ label: 'a', value: 'b' }) })).toThrow(/campos personalizados/);
    expect(() => sanitizeCredential({ title: '', password: '' })).toThrow(/sem título/);
  });

  it('descarta campos desconhecidos, ícone com URL externa e datas futuras', () => {
    const c: any = sanitizeCredential({ title: 'x', password: 'a', icon: { kind: 'image', image: 'https://evil.example/pixel.png' }, createdAt: '2999-01-01T00:00:00Z', evil: 1 } as any);
    expect(c.icon).toEqual({ kind: 'auto' });
    expect(c.evil).toBeUndefined();
    expect(Date.parse(c.createdAt)).toBeLessThanOrEqual(Date.now());
  });

  it('notas e formulários: anexos limitados, tipos conhecidos e campos com tamanho máximo', () => {
    expect(() => sanitizeNote({ title: 'n', attachments: Array(11).fill({ name: 'a', data: '' }) } as any)).toThrow(/anexos/);
    expect(() => sanitizeNote({ title: 'n', attachments: [{ name: 'a', data: '<script>' }] } as any)).toThrow(/inválido/);
    expect(() => sanitizeForm({ kind: 'malware' } as any)).toThrow(/tipo desconhecido/);
    expect(() => sanitizeForm({ kind: 'card', label: 'c', number: '1'.repeat(300) } as any)).toThrow(/passa de/);
  });
});

describe('Envelope cifrado com senha temporária (AES-256-GCM + PBKDF2)', () => {
  it('senha temporária forte e validação da senha definida pelo usuário', () => {
    const a = generateTemporaryPassword();
    expect(a).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){5}$/);
    expect(generateTemporaryPassword()).not.toBe(a);
    expect(filePasswordError('curta')).toMatch(/12 caracteres/);
    expect(filePasswordError('Uma senha bem longa 2026')).toBeNull();
  });

  it('cifra e decifra; senha errada e cabeçalho adulterado falham', async () => {
    const env = await encryptEnvelope('{"segredo":1}', 'Senha#Temporaria1', 'export', 1000);
    expect(JSON.stringify(env)).not.toContain('segredo');
    expect(await decryptEnvelope(env, 'Senha#Temporaria1', { minIterations: 1000 })).toBe('{"segredo":1}');
    await expect(decryptEnvelope(env, 'errada', { minIterations: 1000 })).rejects.toThrow('Falha na descriptografia. Senha inválida.');
    await expect(decryptEnvelope({ ...env, kind: 'inventory' }, 'Senha#Temporaria1', { minIterations: 1000 })).rejects.toThrow('Falha na descriptografia');
  });

  it('abuso: iterações rebaixadas ou absurdas no arquivo são recusadas', async () => {
    const env = await encryptEnvelope('x', 'Senha#Temporaria1', 'export', 1000);
    await expect(decryptEnvelope(env, 'Senha#Temporaria1')).rejects.toThrow(/derivação/);
    await expect(decryptEnvelope({ ...env, kdf: { ...env.kdf, iterations: 1e9 } }, 'x')).rejects.toThrow(/derivação/);
    await expect(decryptEnvelope({ ...env, cipher: 'ROT13' as any }, 'x')).rejects.toThrow(/formato desconhecido/);
  });
});
