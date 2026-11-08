// Segurança: funções puras (sem banco)
//  • teste de dicionário (gerador, cadastro e lista de senhas comuns nas credenciais salvas)
//  • duplicatas e classificação por risco (inclui a ordenação "Maior risco")
//  • metadados do painel
//  • verificação de URL/SSL (com a checagem TLS nativa simulada)
import { DictionaryService } from '../services/DictionaryService';
import { AnalysisService, analyzeCached, strengthOf } from '../services/AnalysisService';
import { PasswordService } from '../services/PasswordService';
import { DuplicateService, passwordBase } from '../services/DuplicateService';
import { RISK_POINTS, RiskService, has2faMarker, riskLevel } from '../services/RiskService';
import { sortCredentials } from '../services/SortService';
import { MetadataService } from '../services/MetadataService';
import { HTTPS_REQUIRED, UrlCheckService, UrlInputError, isInternalHost, parseTarget } from '../services/UrlCheckService';
import { __setNetMocks, TlsInfo } from '../native/net';
import { newCredential, newFolder } from '../services/Repository';
import { sha1Hex } from '../services/BreachService';
import { Credential } from '../types/models';

const DAY = 86400000;
const NOW = Date.parse('2026-11-03T12:00:00Z');
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const cred = (p: Partial<Credential>) => newCredential({ title: 'Conta', createdAt: ago(1), passwordChangedAt: ago(1), ...p });

describe(': teste da senha contra dicionário', () => {
  it('reconhece senhas comuns, palavras e as variações de um ataque de dicionário', () => {
    expect(DictionaryService.check('123456')).toMatchObject({ found: true, source: 'common' });
    expect(DictionaryService.check('Flamengo')).toMatchObject({ found: true });
    // leetspeak
    const leet = DictionaryService.check('P@ssw0rd');
    expect(leet).toMatchObject({ found: true, base: 'password' });
    if (leet.found) expect(leet.reason).toContain('troca de letras por números');
    // sufixo numérico e símbolos
    const suf = DictionaryService.check('senha123!2026');
    expect(suf.found).toBe(true);
    if (suf.found) expect(suf.reason).toMatch(/^Encontrada em dicionário: /);
    // prefixo
    expect(DictionaryService.check('2026dragon').found).toBe(true);
    // duas palavras coladas
    expect(DictionaryService.check('amorbrasil')).toMatchObject({ found: true, source: 'combo' });
    // acentos não escondem a palavra
    expect(DictionaryService.check('Família2024').found).toBe(true);
  });

  it('não acusa senhas aleatórias, vazias ou absurdamente longas', () => {
    expect(DictionaryService.check('x9#Lq!v2Tz$8mWp&Rk4e').found).toBe(false);
    expect(DictionaryService.check('').found).toBe(false);
    expect(DictionaryService.check('senha'.repeat(20)).found).toBe(false);
    // Entrada hostil grande não trava a verificação
    const t0 = Date.now();
    DictionaryService.check('1'.repeat(64));
    DictionaryService.check('a!'.repeat(32));
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('o gerador nunca devolve uma senha de dicionário, mesmo pronunciável', () => {
    const opts = { length: 8, uppercase: false, lowercase: true, numbers: false, symbols: false, avoidAmbiguous: false, pronounceable: true };
    for (let i = 0; i < 30; i++) expect(DictionaryService.isDictionary(DictionaryService.generate(opts))).toBe(false);
    expect(DictionaryService.generate()).toHaveLength(16);
  });

  it('a lista de senhas comuns volta a valer para as credenciais salvas', () => {
    // "trustno1" passa nos testes de padrão, mas está entre as 10 mil mais usadas
    expect(PasswordService.isCommon('trustno1')).toBe(true);
    expect(['critical', 'weak']).toContain(strengthOf('trustno1'));
    // senha "longa" de dicionário fica no máximo fraca
    expect(['critical', 'weak']).toContain(strengthOf('Corinthians2024!'));
    expect(analyzeCached('Corinthians2024!').dictionary).toMatch(/Encontrada em dicionário/);
    expect(strengthOf('x9#Lq!v2Tz$8mWp&Rk4e')).toMatch(/strong/);
  });

  it('BDD "Identificação de senha fraca": "123456" recebe o aviso "Senha Fraca"', () => {
    const c = cred({ title: 'Banco', password: '123456' });
    const report = AnalysisService.report([c]);
    expect(report.weak.map(x => x.id)).toEqual([c.id]);
    expect(report.recommendations[0].message).toMatch(/^Senha Fraca: /);
  });
});

describe(': credenciais duplicadas', () => {
  it('BDD "Senhas repetidas encontradas": Facebook e Instagram com a mesma senha aparecem em "Senhas Reutilizadas"', () => {
    const fb = cred({ title: 'Facebook', url: 'facebook.com', username: 'lucas', password: 'Mesma#Senha2026' });
    const ig = cred({ title: 'Instagram', url: 'instagram.com', username: 'lucas', password: 'Mesma#Senha2026' });
    const other = cred({ title: 'Gmail', url: 'gmail.com', password: 'Outra#Senha!x9' });
    const groups = DuplicateService.find([fb, ig, other]);
    const same = groups.find(g => g.kind === 'same_password')!;
    expect(same.items.map(c => c.title)).toEqual(['Facebook', 'Instagram']);
    expect(same.label).not.toContain('Mesma#Senha2026');
    expect(AnalysisService.report([fb, ig, other]).reused[0].map(c => c.title).sort()).toEqual(['Facebook', 'Instagram']);
  });

  it('BDD "Alteração de senha repetida": trocar por uma senha única tira o alerta daquela credencial', () => {
    const fb = cred({ title: 'Facebook', url: 'facebook.com', password: 'Mesma#Senha2026' });
    const ig = cred({ title: 'Instagram', url: 'instagram.com', password: 'Mesma#Senha2026' });
    const fb2 = { ...fb, password: 'Nova#Unica!2026xz' };
    expect(DuplicateService.find([fb2, ig]).filter(g => g.kind === 'same_password')).toHaveLength(0);
    const recs = AnalysisService.report([fb2, ig]).recommendations;
    expect(recs.some(r => r.id === `reuse:${fb.id}`)).toBe(false);
    const ctx = RiskService.context([fb2, ig], { breaches: {}, now: NOW });
    expect(RiskService.score(fb2, ctx).factors.some(f => f.key === 'reuse')).toBe(false);
  });

  it('acha a mesma conta (site + usuário) e senhas parecidas', () => {
    const a = cred({ title: 'Nubank', url: 'https://app.nubank.com.br', username: 'Lucas', password: 'Flamengo2023!' });
    const b = cred({ title: 'Nubank 2', url: 'nubank.com.br', username: 'lucas ', password: 'Flamengo2024!' });
    const c = cred({ title: 'Nubank', url: '', username: 'outro', password: 'z' });
    const groups = DuplicateService.find([a, b, c]);
    expect(groups.find(g => g.kind === 'same_account')!.items.map(x => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(groups.find(g => g.kind === 'similar_password')!.items).toHaveLength(2);
    expect(passwordBase('Fl@mengo!2024')).toBe('flamengo');
    expect(DuplicateService.findSameAccount([a, c], { id: 'novo', title: 'Outro título', username: 'LUCAS', url: 'nubank.com.br/login' })?.id).toBe(a.id);
    expect(DuplicateService.findSameAccount([a], { id: a.id, title: a.title, username: a.username, url: a.url })).toBeNull();
  });

  it('a mesclagem completa os campos vazios e guarda a outra senha no histórico', () => {
    const keep = cred({ title: 'Gmail', username: '', password: 'Senha#Atual2026', usageCount: 2, associatedDomains: ['mail.google.com'] });
    const other = cred({ title: 'Gmail', username: 'lucas@gmail.com', password: 'Senha#Antiga2020', notes: 'conta pessoal', usageCount: 3, favorite: true, associatedDomains: ['accounts.google.com'] });
    const m = DuplicateService.mergeInto(keep, [other]);
    expect(m.username).toBe('lucas@gmail.com');
    expect(m.password).toBe('Senha#Atual2026');
    expect(m.passwordHistory[0].password).toBe('Senha#Antiga2020');
    expect(m.usageCount).toBe(5);
    expect(m.favorite).toBe(true);
    expect(m.notes).toBe('conta pessoal');
    expect(m.associatedDomains.sort()).toEqual(['accounts.google.com', 'mail.google.com']);
    // o original não é alterado
    expect(keep.customFields).not.toBe(m.customFields);
  });
});

describe(': classificação por risco e ordenação "Maior risco"', () => {
  it('pontua de 0 a 100 combinando força, dicionário, reutilização, vazamento, idade e validade', () => {
    const weak = cred({ title: 'Fraca', password: '123456', category: 'finance' });
    const strong = cred({ title: 'Forte', password: 'x9#Lq!v2Tz$8mWp&Rk4e' });
    const old = cred({ title: 'Antiga', password: 'Q7!mZp#4vLx@2RkT', passwordChangedAt: ago(400) });
    const expired = cred({ title: 'Vencida', password: 'W3$nT!8pXq@5LzMv', expiresAt: ago(2) });
    const breached = cred({ title: 'Vazada', password: 'H6&kR!2wPz#9QmXt' });
    const breaches = { [breached.id]: { prefix: sha1Hex(breached.password).slice(0, 5), checkedAt: ago(1), pwChangedAt: breached.passwordChangedAt, count: 42 } };
    const all = [weak, strong, old, expired, breached];
    const ctx = RiskService.context(all, { breaches, maxAgeDays: 90, now: NOW });

    const w = RiskService.score(weak, ctx);
    expect(w.factors.map(f => f.key)).toEqual(expect.arrayContaining(['strength', 'dictionary']));
    expect(w.score).toBe(Math.round((RISK_POINTS.critical + RISK_POINTS.dictionary) * 1.2));
    expect(RiskService.score(strong, ctx)).toMatchObject({ score: 0, level: 'low' });
    expect(RiskService.score(old, ctx).factors[0]).toMatchObject({ key: 'age', points: RISK_POINTS.veryOld });
    expect(RiskService.score(expired, ctx).factors.map(f => f.key)).toContain('expired');
    const b = RiskService.score(breached, ctx);
    expect(b.factors[0].label).toBe('Senha vazada (encontrada 42 vezes)');
    expect(b.level).toBe('high');
    for (const c of all) {
      const s = RiskService.score(c, ctx).score;
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }
    // o cache de vazamento de uma senha antiga não vale para a senha nova
    const changed = { ...breached, password: 'Outra!Nova#2026zz', passwordChangedAt: ago(0) };
    expect(RiskService.score(changed, ctx).factors.some(f => f.key === 'breach')).toBe(false);

    const ranked = RiskService.rank(all, ctx);
    expect(ranked[0].cred.title).toBe('Fraca');
    expect(ranked[ranked.length - 1].cred.title).toBe('Forte');
    expect(RiskService.summary(ranked).low).toBeGreaterThanOrEqual(1);
  });

  it('níveis, 2FA e domínio suspeito', () => {
    expect([riskLevel(80), riskLevel(50), riskLevel(25), riskLevel(5)]).toEqual(['critical', 'high', 'medium', 'low']);
    expect(has2faMarker({ customFields: [{ id: '1', label: 'TOTP', value: 'x', type: 'hidden' }], notes: '' })).toBe(true);
    expect(has2faMarker({ customFields: [], notes: 'sem nada' })).toBe(false);
    const phishing = cred({ title: 'Banco', url: 'https://paypa1.com', password: 'x9#Lq!v2Tz$8mWp&Rk4e' });
    const ctx = RiskService.context([phishing], { breaches: {}, now: NOW });
    expect(RiskService.score(phishing, ctx).factors.map(f => f.key)).toContain('domain');
  });

  it('a ordenação "Maior risco" coloca a credencial mais arriscada primeiro', () => {
    const a = cred({ title: 'A forte', password: 'x9#Lq!v2Tz$8mWp&Rk4e' });
    const b = cred({ title: 'B fraca', password: 'senha123' });
    const c = cred({ title: 'C média', password: 'Abcdef12' });
    const sorted = sortCredentials([a, c, b], 'risk', NOW, RiskService.context([a, b, c], { breaches: {}, now: NOW }));
    expect(sorted.map(x => x.title)).toEqual(['B fraca', 'C média', 'A forte']);
    // sem contexto, calcula sobre a própria lista
    expect(sortCredentials([a, b], 'risk', NOW)[0].title).toBe('B fraca');
  });
});

describe(': metadados do cofre', () => {
  it('conta por categoria, faixa de idade, força e uso, sem expor senhas', () => {
    const f = newFolder('Trabalho');
    const creds = [
      cred({ title: 'Banco', category: 'finance', password: '123456', passwordChangedAt: ago(10), usageCount: 9, folderId: f.id }),
      cred({ title: 'Cartão', category: 'finance', password: 'x9#Lq!v2Tz$8mWp&Rk4e', passwordChangedAt: ago(100), usageCount: 3 }),
      cred({ title: 'Gmail', category: 'email', password: 'Q7!mZp#4vLx@2RkT', passwordChangedAt: ago(500), favorite: true }),
      cred({ title: 'Data ruim', category: 'other', password: '', passwordChangedAt: 'xx', createdAt: 'xx' }),
    ];
    const s = MetadataService.stats({ creds, folders: [f], notes: [{ category: 'wifi' }], forms: [{ kind: 'card' }, { kind: 'card' }] }, NOW);
    expect(s.totals).toMatchObject({ credentials: 4, folders: 1, notes: 1, forms: 2, favorites: 1, neverUsed: 2 });
    expect(s.byCategory[0]).toEqual({ key: 'finance', label: 'Finanças', count: 2 });
    expect(s.ages.map(a => a.count)).toEqual([2, 0, 1, 0, 1]);
    expect(s.oldest).toMatchObject({ title: 'Gmail', days: 500 });
    expect(s.mostUsed.map(m => m.title)).toEqual(['Banco', 'Cartão']);
    expect(s.strength.critical + s.strength.weak).toBe(1);
    expect(s.byFolder).toEqual([{ key: f.id, label: 'Trabalho', count: 1 }]);
    expect(s.withoutFolder).toBe(3);
    expect(s.forms.card).toBe(2);
    expect(JSON.stringify(s)).not.toContain('123456');
  });

  it('cofre vazio não quebra', () => {
    const s = MetadataService.stats({ creds: [] }, NOW);
    expect(s.averageAgeDays).toBe(0);
    expect(s.oldest).toBeNull();
  });
});

describe(': verificação de URL/SSL', () => {
  const okTls = (host: string, extra: Partial<TlsInfo> = {}): TlsInfo => ({
    reachable: true,
    valid: true,
    host,
    issuer: "Let's Encrypt • R11",
    validFrom: NOW - 30 * DAY,
    validTo: NOW + 60 * DAY,
    protocol: 'TLSv1.3',
    hsts: true,
    ...extra,
  });
  const seen: string[] = [];
  afterEach(() => __setNetMocks({ tls: null }));
  beforeEach(() => {
    seen.length = 0;
  });

  it('valida a entrada do usuário', () => {
    expect(() => parseTarget('')).toThrow('Digite ou cole o endereço do site');
    expect(() => parseTarget(['javascript', 'alert(1)'].join(':'))).toThrow(UrlInputError);
    expect(() => parseTarget('ftp://site.com')).toThrow('Só endereços de sites');
    expect(() => parseTarget('site .com')).toThrow('espaços');
    expect(() => parseTarget('a'.repeat(3000))).toThrow('2048');
    expect(parseTarget('Exemplo.com.br:8443/x')).toMatchObject({ scheme: 'https', host: 'exemplo.com.br', port: 8443 });
  });

  it('certificado válido: mostra o emissor e o veredito "Seguro"', async () => {
    __setNetMocks({ tls: async h => {
      seen.push(h);
      return okTls(h);
    } });
    const r = await UrlCheckService.check('https://www.nubank.com.br/entrar?x=1', [], NOW);
    expect(seen).toEqual(['www.nubank.com.br']); // só o host vai para o nativo, nunca o caminho ou a consulta
    expect(r.level).toBe('safe');
    expect(r.reasons[0].text).toBe("Certificado válido, emitido por Let's Encrypt • R11");
  });

  it('certificado perto de vencer, vencido, inválido e protocolo antigo', async () => {
    __setNetMocks({ tls: async h => okTls(h, { validTo: NOW + 3 * DAY, protocol: 'TLSv1' }) });
    let r = await UrlCheckService.check('nubank.com.br', [], NOW);
    expect(r.level).toBe('warning');
    expect(r.reasons.map(x => x.text).join(' ')).toMatch(/vence em 3 dias.*Protocolo antigo/);
    __setNetMocks({ tls: async h => okTls(h, { validTo: NOW - DAY }) });
    r = await UrlCheckService.check('nubank.com.br', [], NOW);
    expect(r.level).toBe('danger');
    __setNetMocks({ tls: async h => ({ reachable: true, valid: false, host: h, error: 'O certificado não pertence a este endereço' }) });
    r = await UrlCheckService.check('nubank.com.br', [], NOW);
    expect(r.reasons[0].text).toBe('Certificado SSL inválido: O certificado não pertence a este endereço');
  });

  it('HTTPS obrigatório: HTTP é perigo, ou atenção quando o site também tem HTTPS', async () => {
    __setNetMocks({ tls: async h => ({ reachable: true, valid: false, host: h, error: 'sem TLS' }) });
    let r = await UrlCheckService.check('http://loja-exemplo.com', [], NOW);
    expect(r.level).toBe('danger');
    expect(r.reasons[0].text).toBe(HTTPS_REQUIRED);
    expect(r.reasons.some(x => /HTTP sem cadeado/.test(x.text))).toBe(false);
    __setNetMocks({ tls: async h => okTls(h) });
    r = await UrlCheckService.check('http://nubank.com.br', [], NOW);
    expect(r.level).toBe('warning');
    expect(r.reasons[0].text).toContain('use https://nubank.com.br');
  });

  it('domínio parecido, punycode, IP e "@": perigo sem consultar a rede local', async () => {
    __setNetMocks({ tls: async h => {
      seen.push(h);
      return okTls(h);
    } });
    const look = await UrlCheckService.check('https://nubamk.com.br', [], NOW);
    expect(look.level).toBe('danger');
    expect(look.similarTo).toBe('nubank.com.br');
    const puny = await UrlCheckService.check('https://xn--pypal-4ve.com', [], NOW);
    expect(puny.reasons.some(x => /punycode/.test(x.text))).toBe(true);
    const at = await UrlCheckService.check('https://nubank.com.br@golpe.io', [], NOW);
    expect(at.level).toBe('danger');
    expect(at.host).toBe('golpe.io');
    seen.length = 0;
    for (const host of ['http://192.168.0.1', 'https://127.1', 'https://0x7f.0.0.1', 'https://intranet', 'https://impressora.local', 'https://[::1]', 'https://2130706433']) {
      const r = await UrlCheckService.check(host, [], NOW);
      expect(r.tls).toBeNull();
      expect(r.level).not.toBe('safe');
    }
    expect(seen).toEqual([]); // nenhum host interno chegou à checagem TLS (sem SSRF)
    expect(isInternalHost('exemplo.com')).toBe(false);
  });

  it('sem rede ou sem módulo nativo: o veredito sai da análise do domínio, sem erro', async () => {
    __setNetMocks({ tls: async h => ({ reachable: false, valid: false, host: h, error: 'Tempo esgotado ao conectar ao site' }) });
    const r = await UrlCheckService.check('nubank.com.br', [], NOW);
    expect(r.level).toBe('warning');
    expect(r.reasons[0].text).toContain('Tempo esgotado');
    __setNetMocks({ tls: async () => Promise.reject(new Error('E_HOST')) });
    const r2 = await UrlCheckService.check('nubank.com.br', [], NOW);
    expect(r2.tlsSkipped).toBe('E_HOST');
    expect((await UrlCheckService.check('nubank.com.br:8080', [], NOW)).tlsSkipped).toMatch(/porta 8080/);
  });
});
