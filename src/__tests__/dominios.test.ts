// Domínios e regras por pasta: funções puras, sem banco
import { analyzeDomain, credentialsFor, editDistance, matchCredential, normalizeAssociated, verifyBeforeFill } from '../services/DomainService';
import { PolicyService } from '../services/PolicyService';
import { newCredential, newFolder } from '../services/Repository';

const cred = (url: string, extra: any = {}) => newCredential({ title: url, url, ...extra });

describe('Associação de credenciais a sites e apps', () => {
  it('casa o mesmo host e subdomínios do site salvo', () => {
    expect(matchCredential(cred('https://empresa.com'), { url: 'https://empresa.com/login' })).toBe('exact');
    expect(matchCredential(cred('empresa.com'), { url: 'https://mail.empresa.com' })).toBe('subdomain');
  });

  it('não preenche em subdomínio irmão sem associação, mas aceita "*.dominio" associado', () => {
    const c = cred('https://mail.empresa.com');
    expect(matchCredential(c, { url: 'https://rh.empresa.com' })).toBeNull();
    c.associatedDomains = ['*.empresa.com'];
    expect(matchCredential(c, { url: 'https://rh.empresa.com' })).toBe('associated');
    expect(matchCredential(c, { url: 'https://empresa.com.golpe.io' })).toBeNull();
  });

  it('casa o pacote Android associado e ignora credenciais inativas', () => {
    const a = cred('https://banco.com.br', { androidPackages: ['br.com.banco.app'] });
    const b = cred('https://banco.com.br', { inactive: true });
    const list = credentialsFor([b, a], { packageName: 'br.com.banco.app', url: 'https://banco.com.br' });
    expect(list.map(x => x.cred.id)).toEqual([a.id]);
  });

  it('normaliza domínios associados digitados pelo usuário', () => {
    expect(normalizeAssociated(' https://Portal.Empresa.com/x ')).toBe('portal.empresa.com');
    expect(normalizeAssociated('*.empresa.com')).toBe('*.empresa.com');
    expect(normalizeAssociated('sem ponto')).toBe('');
  });
});

describe('Verificação de URL antes de preencher', () => {
  it('aponta domínio parecido com um conhecido (typosquatting e homóglifos)', () => {
    expect(analyzeDomain('https://paypai.com').level).toBe('danger');
    expect(analyzeDomain('https://faceb00k.com').similarTo).toBe('facebook.com');
    expect(analyzeDomain('https://paypal.com.conta-segura.io/login').level).toBe('danger');
  });

  it('avisa HTTP sem TLS, IP e punycode, e aceita o domínio legítimo', () => {
    expect(analyzeDomain('http://example.org').reasons.join()).toMatch(/HTTP/);
    expect(analyzeDomain('https://192.168.0.10').level).toBe('warning');
    expect(analyzeDomain('https://xn--pypal-4ve.com').level).not.toBe('ok');
    expect(analyzeDomain('https://www.facebook.com/login').level).toBe('ok');
  });

  it('bloqueia o preenchimento em phishing mesmo que o site "pareça" o salvo', () => {
    const c = cred('https://nubank.com.br');
    expect(verifyBeforeFill(c, { url: 'https://nubank.com.br/entrar' }, ['nubank.com.br']).allowed).toBe(true);
    expect(verifyBeforeFill(c, { url: 'https://nubamk.com.br' }, ['nubank.com.br']).allowed).toBe(false);
  });

  it('distância de edição limitada', () => {
    expect(editDistance('google', 'gooogle')).toBe(1);
    expect(editDistance('a', 'abcdefgh', 2)).toBe(3);
  });
});

describe('Regras por pasta', () => {
  it('a subpasta herda a regra mais rígida das pastas acima', () => {
    const banco = newFolder('Bancos');
    banco.policy = { requireReauth: true, minStrength: 'strong', maxAgeDays: 90, blockAutofill: false, blockExport: true, clipboardSeconds: 15 };
    const sub = newFolder('Cartões', banco.id);
    sub.policy = { requireReauth: false, minStrength: 'medium', maxAgeDays: 30, blockAutofill: true, blockExport: false, clipboardSeconds: null };
    const p = PolicyService.effective([banco, sub], sub.id);
    expect(p).toEqual({ requireReauth: true, minStrength: 'strong', maxAgeDays: 30, blockAutofill: true, blockExport: true, clipboardSeconds: 15 });
    expect(PolicyService.isEmpty(PolicyService.effective([banco, sub], null))).toBe(true);
    expect(PolicyService.meetsStrength('medium', 'strong')).toBe(false);
  });
});
