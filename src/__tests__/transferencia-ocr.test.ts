// Importação por foto/OCR: o parser do texto reconhecido roda em JS e é testado aqui
import { interpret, labeledPairs, MAX_OCR_TEXT, OCR_DARK_MESSAGE, OCR_NOTHING_FOUND, OcrService, parseOcrText, toPrefill } from '../services/OcrService';
import { __queueOcrResult } from '../native/ocr';
import { LIMITS } from '../services/Repository';

const ok = (text: string) => ({ text, confidence: 85, brightness: 140 });

describe('BDD: Importação por OCR', () => {
  it('Cenário: Captura bem-sucedida de texto impresso, "Usuário: admin / Senha: 123" preenche os campos respectivos', async () => {
    __queueOcrResult(ok('Usuário: admin / Senha: 123'));
    const out = await OcrService.fromCamera();
    expect(out!.problem).toBeNull();
    expect(out!.candidates).toHaveLength(1);
    const prefill = toPrefill(out!.candidates[0]);
    expect(prefill).toMatchObject({ username: 'admin', password: '123' });
    expect(prefill.title).toBeTruthy();
  });

  it('Cenário: Foto em ambiente sem luz, sugere "Ative o flash ou melhore a iluminação para reconhecer os caracteres"', async () => {
    __queueOcrResult({ text: '~ ,. ', confidence: 12, brightness: 18 });
    const out = await OcrService.fromCamera();
    expect(out!.problem).toBe(OCR_DARK_MESSAGE);
    expect(OCR_DARK_MESSAGE).toBe('Ative o flash ou melhore a iluminação para reconhecer os caracteres');
  });
});

describe('Parser do texto reconhecido', () => {
  it('vários rótulos na mesma linha, em português e inglês', () => {
    expect(labeledPairs('Usuário: admin / Senha: 123')).toEqual([
      { field: 'username', value: 'admin' },
      { field: 'password', value: '123' },
    ]);
    const [c] = parseOcrText('Site: https://portal.empresa.com.br\nLogin = joao.silva\nPassword: Abc#2026');
    expect(c).toMatchObject({ url: 'https://portal.empresa.com.br', username: 'joao.silva', password: 'Abc#2026', title: 'Portal' });
  });

  it('cartão de Wi-Fi: a rede vira o usuário e o título', () => {
    const [c] = parseOcrText('Rede Wi-Fi: CasaLucas_5G\nSenha do Wi-Fi: minha senha forte');
    expect(c).toMatchObject({ wifi: true, username: 'CasaLucas_5G', password: 'minhasenhaforte', title: 'Wi-Fi CasaLucas_5G' });
    expect(toPrefill(c).notes).toBe('Rede Wi-Fi reconhecida por foto');
  });

  it('captura de tela com uma lista de contas (sem rótulos)', () => {
    const list = parseOcrText('netflix.com | ana@gmail.com | Filmes#2026\nspotify.com | ana@gmail.com | Musica#2026\n');
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ url: 'netflix.com', username: 'ana@gmail.com', password: 'Filmes#2026' });
    expect(list[1]).toMatchObject({ url: 'spotify.com', password: 'Musica#2026' });
  });

  it('rótulo repetido começa um novo registro e repetidos são removidos', () => {
    const list = parseOcrText('Usuário: a\nSenha: 1\nUsuário: b\nSenha: 2\nUsuário: b\nSenha: 2');
    expect(list.map(c => `${c.username}:${c.password}`)).toEqual(['a:1', 'b:2']);
  });

  it('espaços falsos inseridos pelo OCR são removidos da senha, usuário e URL', () => {
    const [c] = parseOcrText('E-mail: lucas @ gmail.com\nSenha: Ab c#20 26');
    expect(c).toMatchObject({ username: 'lucas@gmail.com', password: 'Abc#2026', title: 'Gmail' });
  });

  it('texto sem credenciais não gera sugestão', () => {
    expect(parseOcrText('Lista de compras\narroz\nfeijão')).toEqual([]);
    expect(interpret(ok('Lista de compras'))).toEqual({ candidates: [], problem: OCR_NOTHING_FOUND });
  });

  it('foto escura com texto reconhecido ainda devolve as sugestões', () => {
    const out = interpret({ text: 'Senha: 123456', confidence: 30, brightness: 20 });
    expect(out.problem).toBeNull();
    expect(out.candidates[0].password).toBe('123456');
  });
});

describe('Abusos (texto de OCR é entrada externa)', () => {
  it('texto gigante é cortado e não trava o parser', () => {
    const huge = 'Senha: x\n'.repeat(200000);
    const start = Date.now();
    const list = parseOcrText(huge);
    expect(Date.now() - start).toBeLessThan(3000);
    expect(list.length).toBeLessThanOrEqual(50);
    expect(huge.length).toBeGreaterThan(MAX_OCR_TEXT);
  });

  it('campos longos demais são cortados nos limites do cadastro', () => {
    const [c] = parseOcrText(`Usuário: ${'u'.repeat(5000)}\nSenha: ${'p'.repeat(5000)}`);
    expect(c.username.length).toBeLessThanOrEqual(LIMITS.username);
    expect(c.password.length).toBeLessThanOrEqual(LIMITS.password);
  });

  it('linha sem quebra com muitos rótulos não explode (regex sem retrocesso catastrófico)', () => {
    const line = 'senha: senha: senha: '.repeat(3000);
    const start = Date.now();
    parseOcrText(line);
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it('nada é salvo: o resultado só pré-preenche o cadastro', async () => {
    __queueOcrResult(null);
    await expect(OcrService.fromGallery()).resolves.toBeNull(); // cancelado
  });
});
