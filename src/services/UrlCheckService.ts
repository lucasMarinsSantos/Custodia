// Verificação de site: anti-phishing + certificado SSL/TLS
//  1. Valida o endereço digitado/colado: só http(s), host público e sintaticamente válido, sem porta estranha.
//  2. Analisa o domínio sem rede (DomainService.analyzeDomain): parecido com um conhecido, punycode, IP, "@"...
//  3. Se o host é público, pede ao nativo (NetModule.kt) a checagem TLS: certificado, emissor, validade,
//     protocolo e HSTS. Hosts internos/privados nunca são consultados (evita SSRF: o app não vira uma ferramenta
//     para sondar a rede local do usuário).
//  4. Junta tudo num veredito: seguro, atenção ou perigo, com os motivos e o domínio legítimo parecido.

import { analyzeDomain, DomainVerdict, isValidHost } from './DomainService';
import { Net, TlsInfo } from '../native/net';
import { formatDate, registrableDomain } from '../utils';

export type SiteLevel = 'safe' | 'warning' | 'danger';

export interface SiteReason {
  level: 'info' | 'warning' | 'danger' | 'ok';
  text: string;
}

export interface SiteReport {
  url: string;
  host: string;
  domain: string;
  level: SiteLevel;
  reasons: SiteReason[];
  similarTo?: string;
  domainVerdict: DomainVerdict;
  tls: TlsInfo | null;
  /** Por que a checagem de rede não foi feita (host interno, offline…). */
  tlsSkipped?: string;
}

export const MAX_URL_LENGTH = 2048;
/** Certificado que vence em menos de 14 dias merece atenção (renovação esquecida ou certificado de golpe). */
export const CERT_EXPIRY_WARN_DAYS = 14;
const DAY = 86400000;

export class UrlInputError extends Error {}

/** IPv4 em notação decimal com pontos. */
const DOTTED_IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.intranet', '.corp', '.home.arpa'];

/** IPv4 de rede privada, loopback, link-local, CGNAT, "esta rede" ou multicast/reservado. */
export function isPrivateIPv4(host: string): boolean {
  const m = DOTTED_IPV4.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

/**
 * Host que não pode ser consultado pela rede: localhost, nomes de rede interna (.local, .lan...), nomes sem ponto,
 * IPs privados e qualquer IP literal (IPv6 entre colchetes, IPv4 em decimal/hexadecimal como 2130706433 ou 0x7f.1).
 */
export function isInternalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h || h === 'localhost' || !h.includes('.')) return true;
  if (h.startsWith('[') || h.includes(':')) return true;
  if (INTERNAL_SUFFIXES.some(s => h.endsWith(s))) return true;
  if (isPrivateIPv4(h)) return true;
  // Formas numéricas alternativas (0x7f.0.0.1, 017700000001, 127.1): não são nomes, são IPs disfarçados
  return /^(0x|\d)[0-9a-fx.]*$/.test(h) && !DOTTED_IPV4.test(h);
}

export interface ParsedTarget {
  url: string;
  scheme: 'http' | 'https';
  host: string;
  port: number | null;
}

/**
 * Host exato (com "www.": o certificado é do nome que o usuário vai abrir) e porta. O que vem antes de "@" é
 * descartado, como faz o navegador. IPv6 fica entre colchetes.
 */
function splitAuthority(url: string): { host: string; port: number | null } {
  const authority = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0];
  const hostPort = authority.split('@').pop() || '';
  const bracketed = hostPort.startsWith('[') ? /^\[[^\]]*\]/.exec(hostPort)?.[0] || '' : '';
  const portMatch = /:(\d*)$/.exec(bracketed ? hostPort.slice(bracketed.length) : hostPort);
  const port = portMatch && portMatch[1] ? Number(portMatch[1]) : null;
  const host = (bracketed || hostPort.split(':')[0]).toLowerCase().replace(/\.$/, '');
  return { host, port };
}

/** Normaliza e valida o endereço digitado. Lança UrlInputError com a mensagem para o usuário. */
export function parseTarget(input: string): ParsedTarget {
  const raw = (input || '').trim();
  if (!raw) throw new UrlInputError('Digite ou cole o endereço do site');
  if (raw.length > MAX_URL_LENGTH) throw new UrlInputError(`O endereço pode ter até ${MAX_URL_LENGTH} caracteres`);
  if (/\s/.test(raw)) throw new UrlInputError('O endereço não pode ter espaços');
  const schemeMatch = /^([a-z][a-z0-9+.-]*):(\/\/)?/i.exec(raw);
  // "exemplo.com:8080" parece esquema "exemplo.com:"; só é esquema quando vem seguido de "//" ou não tem ponto
  const hasScheme = !!schemeMatch && (!!schemeMatch[2] || !schemeMatch[1].includes('.'));
  const scheme = hasScheme ? schemeMatch![1].toLowerCase() : 'https';
  if (scheme !== 'http' && scheme !== 'https') throw new UrlInputError('Só endereços de sites (http:// ou https://) podem ser verificados');
  const url = hasScheme ? raw : `https://${raw}`;
  const { host, port } = splitAuthority(url);
  if (!host) throw new UrlInputError('Endereço inválido');
  return { url, scheme, host, port };
}

function tlsReasons(tls: TlsInfo, now: number): SiteReason[] {
  if (!tls.reachable) return [{ level: 'warning', text: `Não foi possível verificar o certificado: ${tls.error || 'sem conexão'}` }];
  if (!tls.valid) return [{ level: 'danger', text: `Certificado SSL inválido: ${tls.error || 'não confiável'}` }];
  const issuer = tls.issuer ? ', emitido por ' + tls.issuer : '';
  const out: SiteReason[] = [{ level: 'ok', text: `Certificado válido${issuer}` }];
  if (tls.validTo) {
    const days = Math.floor((tls.validTo - now) / DAY);
    if (days < 0) out.push({ level: 'danger', text: 'O certificado do site expirou' });
    else if (days < CERT_EXPIRY_WARN_DAYS) out.push({ level: 'warning', text: `O certificado vence em ${days} ${days === 1 ? 'dia' : 'dias'} (${formatDate(new Date(tls.validTo).toISOString())})` });
  }
  if (tls.protocol && /^(SSL|TLSv1(\.[01])?$)/.test(tls.protocol)) out.push({ level: 'warning', text: `Protocolo antigo e inseguro (${tls.protocol})` });
  if (tls.hsts === false) out.push({ level: 'info', text: 'O site não exige HTTPS sempre (sem HSTS)' });
  return out;
}

const HTTP_FINDING = /HTTP sem cadeado/;
export const HTTPS_REQUIRED = 'HTTPS obrigatório: este endereço usa HTTP, sem criptografia. Não digite senhas nele.';

/** HTTP é sempre um problema; se o mesmo site tem HTTPS válido, é só atenção (basta usar https://). */
function httpsRequired(host: string, httpsAvailable: boolean): SiteReason {
  if (httpsAvailable) return { level: 'warning', text: `${HTTPS_REQUIRED} O site tem HTTPS: use https://${host}` };
  return { level: 'danger', text: HTTPS_REQUIRED };
}

function levelOf(reasons: SiteReason[]): SiteLevel {
  if (reasons.some(r => r.level === 'danger')) return 'danger';
  return reasons.some(r => r.level === 'warning') ? 'warning' : 'safe';
}

export const UrlCheckService = {
  /**
   * Verifica um site. `trusted` são os sites já salvos no cofre (o domínio parecido com um deles é suspeito).
   * Nunca lança por falta de rede: o veredito sai só da análise do domínio, com um aviso.
   */
  async check(input: string, trusted: string[] = [], now = Date.now()): Promise<SiteReport> {
    const target = parseTarget(input);
    const verdict = analyzeDomain(target.url, trusted);
    // O aviso de HTTP do DomainService é substituído pela regra "HTTPS obrigatório" abaixo
    const reasons: SiteReason[] = verdict.reasons
      .filter(text => !HTTP_FINDING.test(text))
      .map(text => ({ level: (verdict.level === 'danger' ? 'danger' : 'warning') as SiteReason['level'], text }));
    let tls: TlsInfo | null = null;
    let tlsSkipped: string | undefined;
    if (isInternalHost(target.host) || DOTTED_IPV4.test(target.host)) {
      tlsSkipped = 'Endereços internos, privados ou IPs não são consultados pela rede (proteção do app)';
    } else if (!isValidHost(target.host)) {
      tlsSkipped = 'O nome do site tem caracteres especiais: o certificado não foi consultado';
    } else if (target.port !== null && target.port !== 443 && target.port !== 80) {
      tlsSkipped = `A porta ${target.port} não é verificada; só a porta padrão do HTTPS (443)`;
    } else {
      try {
        tls = await Net.checkTls(target.host);
      } catch (e: any) {
        tlsSkipped = e?.message || 'Não foi possível verificar o certificado';
      }
    }
    if (tls) reasons.push(...tlsReasons(tls, now));
    // Sem a checagem do certificado o site não pode ser chamado de seguro
    else if (tlsSkipped) reasons.push({ level: 'warning', text: tlsSkipped });
    if (target.scheme === 'http') reasons.unshift(httpsRequired(target.host, !!tls?.valid));
    return {
      url: target.url,
      host: target.host,
      domain: registrableDomain(target.host),
      level: levelOf(reasons),
      reasons,
      similarTo: verdict.similarTo,
      domainVerdict: verdict,
      tls,
      tlsSkipped,
    };
  },
};

export const SiteLevelLabels: Record<SiteLevel, string> = {
  safe: 'Seguro',
  warning: 'Atenção',
  danger: 'Perigo',
};
