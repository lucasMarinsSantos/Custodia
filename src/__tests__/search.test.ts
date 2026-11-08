// Pesquisa avançada: operadores booleanos, filtros e cenários BDD
import { localDayBound, parseQuery, SearchService } from '../services/SearchService';
import { newCredential, newFolder } from '../services/Repository';

const financas = newFolder('Finanças');
financas.id = 'f1';
const creds = [
  newCredential({ id: '1', title: 'Gmail', username: 'lucas@gmail.com', url: 'https://mail.google.com', category: 'email', notes: 'conta pessoal', favorite: true }),
  newCredential({ id: '2', title: 'Nubank', username: 'lucas', url: 'nubank.com.br', category: 'finance', notes: 'cartão', folderId: 'f1' }),
  newCredential({ id: '3', title: 'GitHub', username: 'lucasdev', url: 'github.com', category: 'development', customFields: [{ id: 'c', label: 'Token', value: 'ghp_abc', type: 'text' }] }),
  newCredential({ id: '4', title: 'Outlook trabalho', username: 'lucas@empresa.com', url: 'outlook.com', category: 'email', notes: 'trabalho' }),
  newCredential({ id: '5', title: 'Netflix', username: 'familia@gmail.com', url: 'netflix.com', category: 'entertainment', password: 'x9#Lq!v2Tz$8mWp&Rk4e', favorite: true }),
];
const ids = (q: string, f = {}) => SearchService.search(creds, q, f, [financas]).map(c => c.id);

describe('Pesquisa avançada', () => {
  it('BDD: digitar "Netf" encontra "Netflix"', () => {
    expect(ids('Netf')).toEqual(['5']);
  });
  it('BDD: termo inexistente não retorna resultados', () => {
    expect(ids('Asdfgh')).toEqual([]);
  });
  it('BDD: filtro "Apenas favoritos" combinado com termo de busca', () => {
    expect(ids('gmail', { onlyFavorites: true })).toEqual(['1', '5']);
    expect(ids('netflix', { onlyFavorites: true })).toEqual(['5']);
    expect(ids('nubank', { onlyFavorites: true })).toEqual([]);
  });
  it('AND implícito e explícito', () => {
    expect(ids('lucas email')).toEqual([]);
    expect(ids('gmail AND pessoal')).toEqual(['1']);
    expect(ids('gmail E pessoal')).toEqual(['1']);
  });
  it('OR / NOT / agrupamento / frase exata', () => {
    expect(ids('gmail OR nubank')).toEqual(['1', '2', '5']);
    expect(ids('categoria:email NOT trabalho')).toEqual(['1']);
    expect(ids('(gmail OU github) E -pessoal')).toEqual(['3', '5']);
    expect(ids('"outlook trabalho"')).toEqual(['4']);
    expect(ids('NÃO lucas')).toEqual(['5']);
  });
  it('campos específicos, incluindo personalizados, notas, pasta e categoria', () => {
    expect(ids('campo:ghp')).toEqual(['3']);
    expect(ids('notas:cartao')).toEqual(['2']);
    expect(ids('url:google')).toEqual(['1']);
    expect(ids('pasta:financas')).toEqual(['2']);
    expect(ids('categoria:finanças')).toEqual(['2']);
    expect(ids('usuario:lucasdev')).toEqual(['3']);
    expect(ids('titulo:nubank')).toEqual(['2']);
  });
  it('ignora acentos e maiúsculas', () => {
    expect(ids('CARTÃO')).toEqual(['2']);
  });
  it('filtros por categoria, pasta e força', () => {
    expect(ids('', { categories: ['finance'] })).toEqual(['2']);
    expect(ids('', { folderIds: ['f1'] })).toEqual(['2']);
    expect(ids('', { strengths: ['critical'] }).sort()).toEqual(['1', '2', '3', '4']);
    expect(ids('', { strengths: ['strong', 'very_strong'] })).toEqual(['5']);
  });
  it('consulta vazia retorna tudo e parênteses desbalanceados não quebram', () => {
    expect(ids('')).toHaveLength(5);
    expect(() => ids('(gmail OR')).not.toThrow();
    expect(() => ids(')) AND (')).not.toThrow();
  });
});

describe('Filtro por data de criação (fuso local)', () => {
  // Criada às 21:30 do dia 15 no horário local; em UTC pode cair no dia 16.
  const cred = newCredential({ title: 'Banco', username: 'eu', password: 'x' });
  cred.createdAt = new Date(2024, 0, 15, 21, 30, 0).toISOString();

  it('inclui item criado no fim do dia no filtro "até" do mesmo dia', () => {
    expect(SearchService.search([cred], '', { createdTo: '2024-01-15' }, [])).toHaveLength(1);
  });
  it('exclui item criado depois do limite', () => {
    expect(SearchService.search([cred], '', { createdTo: '2024-01-14' }, [])).toHaveLength(0);
  });
  it('filtro "de" usa o início do dia local', () => {
    expect(SearchService.search([cred], '', { createdFrom: '2024-01-15' }, [])).toHaveLength(1);
    expect(SearchService.search([cred], '', { createdFrom: '2024-01-16' }, [])).toHaveLength(0);
  });
  it('datas incompletas (digitando) são ignoradas em vez de esconder tudo', () => {
    expect(localDayBound('2024-0', true)).toBeNull();
    expect(SearchService.search([cred], '', { createdTo: '2024-0' }, [])).toHaveLength(1);
    // Datas impossíveis não são "corrigidas" pelo Date (31/02 viraria 03/03)
    expect(localDayBound('2024-02-31', false)).toBeNull();
    expect(localDayBound('2024-13-01', false)).toBeNull();
    expect(localDayBound('2024-02-29', false)).not.toBeNull();
  });
  it('consultas abusivas não travam nem derrubam o app', () => {
    const deep = '('.repeat(20000) + 'netflix';
    expect(() => parseQuery(deep)).not.toThrow();
    expect(() => parseQuery('NOT '.repeat(20000) + 'x')).not.toThrow();
    expect(() => parseQuery('a' + ' '.repeat(40000) + '"')).not.toThrow();
    const t0 = Date.now();
    SearchService.search(creds, 'a' + ' '.repeat(40000) + '"', {}, []);
    SearchService.search(creds, ')))((( OR AND NOT "', {}, []);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
