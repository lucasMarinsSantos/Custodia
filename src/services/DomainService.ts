// Domínios: associação de credenciais a sites/apps e verificação contra phishing
//  •: qual credencial serve para um site, subdomínio ou app Android
//  •: domínio parecido com um conhecido (lookalike, homóglifos, punycode), HTTP sem TLS, IP no lugar do nome
// Usado pelo preenchimento automático (antes de preencher) e pela tela de verificação de URL.

import { KNOWN_DOMAINS } from '../data/domains';
import { Credential } from '../types/models';
import { hostnameOf, registrableDomain } from '../utils';

export type MatchKind = 'exact' | 'subdomain' | 'associated' | 'package';

export interface FillTarget {
  /** Endereço da página (navegador) ou host já extraído. */
  url?: string | null;
  /** Pacote do app Android que pediu o preenchimento. */
  packageName?: string | null;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Host de um domínio associado digitado pelo usuário: aceita "*.empresa.com", URL completa ou só o host. */
export function normalizeAssociated(entry: string): string {
  const raw = entry.trim().toLowerCase();
  if (!raw) return '';
  const wildcard = raw.startsWith('*.');
  const host = hostnameOf(wildcard ? raw.slice(2) : raw);
  if (!isValidHost(host)) return '';
  return wildcard ? `*.${host}` : host;
}

/** Hostname sintaticamente válido (rótulos de 1 a 63 caracteres, ao menos um ponto, sem espaços). */
export function isValidHost(host: string): boolean {
  if (!host || host.length > 253 || !host.includes('.')) return false;
  return host.split('.').every(l => /^[a-z0-9-]{1,63}$/.test(l) && !l.startsWith('-') && !l.endsWith('-'));
}

/** true quando `host` é igual a `base` ou um subdomínio dele (login.empresa.com ⊂ empresa.com). */
export function isSameOrSubdomain(host: string, base: string): boolean {
  return !!host && !!base && (host === base || host.endsWith('.' + base));
}

/**
 * Diz se a credencial serve para o alvo e por quê. A regra é conservadora (evita preencher no site errado):
 *  • exact: mesmo host;
 *  • subdomain: o alvo é subdomínio do host salvo (salvo "empresa.com", alvo "mail.empresa.com");
 *  • associated: o alvo bate com um domínio associado (com "*.dominio" valendo para todos os subdomínios);
 *  • package: o app Android está associado à credencial.
 * Um subdomínio irmão (salvo "mail.empresa.com", alvo "rh.empresa.com") só vale se o usuário associar "*.empresa.com".
 */
export function matchCredential(cred: Pick<Credential, 'url' | 'associatedDomains' | 'androidPackages'>, target: FillTarget): MatchKind | null {
  const pkg = (target.packageName || '').trim().toLowerCase();
  if (pkg && (cred.androidPackages || []).some(p => p.toLowerCase() === pkg)) return 'package';
  const host = hostnameOf(target.url || '');
  if (!host) return null;
  const saved = hostnameOf(cred.url || '');
  if (saved && host === saved) return 'exact';
  if (saved && isSameOrSubdomain(host, saved)) return 'subdomain';
  return (cred.associatedDomains || []).some(entry => matchesAssociated(host, entry)) ? 'associated' : null;
}

function matchesAssociated(host: string, entry: string): boolean {
  const a = normalizeAssociated(entry);
  if (!a) return false;
  return a.startsWith('*.') ? isSameOrSubdomain(host, a.slice(2)) : host === a;
}

const MATCH_RANK: Record<MatchKind, number> = { exact: 0, package: 1, subdomain: 2, associated: 3 };

/** Credenciais compatíveis com o alvo, da melhor correspondência para a pior; inativas ficam de fora. */
export function credentialsFor<T extends Credential>(creds: T[], target: FillTarget): { cred: T; match: MatchKind }[] {
  const out: { cred: T; match: MatchKind }[] = [];
  for (const cred of creds) {
    if (cred.inactive) continue;
    const match = matchCredential(cred, target);
    if (match) out.push({ cred, match });
  }
  return out.sort((a, b) => MATCH_RANK[a.match] - MATCH_RANK[b.match] || (b.cred.usageCount || 0) - (a.cred.usageCount || 0));
}

// -----------------------------------------------------------------------------
// Detecção de domínios parecidos (phishing)
// -----------------------------------------------------------------------------

/** Distância de edição (Levenshtein) limitada: para cedo quando passa de `max`. */
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      best = Math.min(best, v);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Troca caracteres que se parecem (0→o, 1→l, rn→m, vv→w…) para comparar com marcas conhecidas. */
export function skeleton(label: string): string {
  return deconfuse(label)
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/cl/g, 'd')
    .replace(/[0]/g, 'o')
    .replace(/[1|!]/g, 'l')
    .replace(/[3]/g, 'e')
    .replace(/[4@]/g, 'a')
    .replace(/[5$]/g, 's')
    .replace(/[7]/g, 't')
    .replace(/i/g, 'l')
    .replace(/-/g, '');
}

/**
 * Letras de outros alfabetos idênticas às latinas (homóglifos): "pаypal" com "а" cirílico vira "paypal".
 * Cobre as trocas mais usadas em golpes (cirílico e grego).
 */
const CONFUSABLES: Record<string, string> = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ԁ': 'd', 'ѕ': 's', 'ԛ': 'q',
  'һ': 'h', 'ӏ': 'l', 'ո': 'n', 'ɡ': 'g', 'α': 'a', 'ο': 'o', 'ρ': 'p', 'ν': 'v', 'κ': 'k', 'τ': 't', 'ι': 'i', 'ω': 'w',
};

export function deconfuse(label: string): string {
  let out = '';
  for (const ch of label) out += CONFUSABLES[ch] ?? ch;
  return out;
}

/** Parte "nome" do domínio registrável (itau.com.br → itau). */
const brandOf = (domain: string) => domain.split('.')[0];

export interface DomainVerdict {
  host: string;
  domain: string;
  /** 'ok': nada suspeito; 'warning': confirme antes de usar; 'danger': provável fraude. */
  level: 'ok' | 'warning' | 'danger';
  reasons: string[];
  /** Domínio legítimo com o qual o endereço se parece. */
  similarTo?: string;
}

/**
 * Analisa um endereço sem acessar a rede: protocolo, IP, punycode, marca conhecida em domínio de terceiros
 * e semelhança com domínios conhecidos ou já salvos no cofre (`trusted`).
 */
export function analyzeDomain(url: string, trusted: string[] = []): DomainVerdict {
  const host = hostnameOf(url);
  const domain = registrableDomain(host);
  if (!host) return { host, domain, level: 'danger', reasons: ['Endereço inválido'] };
  const findings: Finding[] = [...transportFindings(url, host), ...disguiseFindings(url, host)];
  const known = new Set([...Object.keys(KNOWN_DOMAINS), ...trusted.map(t => registrableDomain(t)).filter(Boolean)]);
  const look = known.has(domain) ? null : lookalikeFinding(host, domain, known) || sameBrandFinding(domain, known);
  if (look) findings.push(look);
  const level = findings.some(f => f.level === 'danger') ? 'danger' : findings.length ? 'warning' : 'ok';
  return { host, domain, level, reasons: findings.map(f => f.why), similarTo: look?.similarTo };
}

interface Finding {
  level: 'warning' | 'danger';
  why: string;
  similarTo?: string;
}

function transportFindings(url: string, host: string): Finding[] {
  const out: Finding[] = [];
  if (/^http:\/\//i.test(url.trim())) out.push({ level: 'warning', why: 'A conexão não é segura (HTTP sem cadeado)' });
  if (IPV4.test(host) || host.startsWith('[')) out.push({ level: 'warning', why: 'O endereço usa um número IP em vez de um nome' });
  if (host.split('.').some(l => l.startsWith('xn--'))) {
    out.push({ level: 'warning', why: 'O endereço usa caracteres especiais (punycode), comum em golpes' });
  }
  return out;
}

/**
 * Disfarces no próprio endereço:
 *  • "https://banco.com.br@golpe.io": tudo antes do "@" é ignorado pelo navegador, o site real é golpe.io;
 *  • letras de outros alfabetos no nome (homóglifos), que o navegador pode mostrar iguais às latinas.
 */
function disguiseFindings(url: string, host: string): Finding[] {
  const out: Finding[] = [];
  const authority = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0];
  if (authority.includes('@')) out.push({ level: 'danger', why: `O endereço esconde o destino real com "@": o site de verdade é ${host}` });
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(host)) out.push({ level: 'warning', why: 'O endereço usa letras de outros alfabetos, que imitam as normais (comum em golpes)' });
  return out;
}

/** Terminações usadas legitimamente pelas marcas além da principal (google.com e google.com.br). */
const COMMON_TLDS = new Set(['com', 'net', 'org', 'br', 'com.br', 'net.br', 'org.br', 'pt', 'com.pt', 'co.uk', 'de', 'fr', 'es', 'it', 'ca', 'com.ar', 'com.mx', 'com.au', 'co.jp', 'jp']);

/**
 * Mesmo nome de uma marca conhecida, mas com outra terminação pouco usada por ela (paypal.co, nubank.app):
 * golpe comum que a comparação por semelhança não pega, porque o nome é idêntico.
 */
function sameBrandFinding(domain: string, known: Set<string>): Finding | null {
  const brand = brandOf(domain);
  const tld = domain.slice(brand.length + 1);
  if (brand.length < 4 || !tld || COMMON_TLDS.has(tld)) return null;
  for (const k of known) {
    if (brandOf(k) === brand && k !== domain) return { level: 'warning', why: `Usa o nome "${brand}", mas o domínio conhecido é ${k}`, similarTo: k };
  }
  return null;
}

/** Nome a 1 letra (2 em nomes longos) de distância, ou igual depois de trocar caracteres parecidos. */
function looksLike(brand: string, brandSkeleton: string, knownBrand: string): boolean {
  const d = editDistance(brand, knownBrand, 2);
  return (d > 0 && d <= (knownBrand.length >= 8 ? 2 : 1)) || brandSkeleton === skeleton(knownBrand);
}

/** Compara o domínio com cada domínio conhecido e devolve a primeira semelhança suspeita. */
function lookalikeFinding(host: string, domain: string, known: Set<string>): Finding | null {
  const brand = brandOf(domain);
  const sk = skeleton(brand);
  for (const k of known) {
    const kb = brandOf(k);
    if (kb.length < 4 || brand === kb) continue;
    // Marca conhecida usada como subdomínio de outro domínio: paypal.com.conta-segura.io
    if (host.startsWith(kb + '.') || host.includes('.' + kb + '.')) {
      return { level: 'danger', why: `Usa o nome "${kb}" mas pertence a outro domínio (${domain})`, similarTo: k };
    }
    if (looksLike(brand, sk, kb)) {
      return { level: 'danger', why: `Parece com ${k}, mas é ${domain}`, similarTo: k };
    }
    // Marca dentro do nome com hífen ou palavras extras: itau-seguranca.com
    if (brand.includes(kb) && /-|seguro|login|conta|acesso|verifica/.test(brand)) {
      return { level: 'warning', why: `Contém o nome "${kb}" mas não é ${k}`, similarTo: k };
    }
  }
  return null;
}

/**
 * Verificação feita antes de preencher ( +): o alvo precisa corresponder à credencial
 * e não pode parecer phishing. Devolve os motivos para mostrar ao usuário quando não for seguro.
 */
export function verifyBeforeFill(cred: Credential, target: FillTarget, trusted: string[] = []): { allowed: boolean; match: MatchKind | null; verdict: DomainVerdict | null } {
  const match = matchCredential(cred, target);
  if (!target.url) return { allowed: !!match, match, verdict: null };
  const verdict = analyzeDomain(target.url, trusted);
  return { allowed: !!match && verdict.level !== 'danger', match, verdict };
}
