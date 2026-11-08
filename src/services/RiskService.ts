// Classificação por risco
// Cada credencial recebe uma nota de 0 a 100 (quanto maior, mais urgente tratar) e um nível crítico/alto/médio/
// baixo, com os fatores que pesaram: força da senha (inclui o teste de dicionário), reutilização, vazamento
// (HIBP), senha de dicionário, idade, validade vencida, 2FA disponível no serviço e não registrado, e endereço suspeito.
// Serviços sensíveis (bancos, e-mail, governo, trabalho) pesam mais: quem invade o e-mail recupera o resto.
// É síncrono (usa o cache de vazamentos já carregado) para servir também à ordenação "Maior risco".

import { KNOWN_DOMAINS } from '../data/domains';
import { Credential, CredentialCategory } from '../types/models';
import { analyzeCached, findReused, passwordAge } from './AnalysisService';
import { BreachEntry, BreachService, breachText, isFresh } from './BreachService';
import { analyzeDomain } from './DomainService';
import { registrableDomain } from '../utils';
import { Vault } from './VaultService';

export type RiskLevel = 'critical' | 'high' | 'medium' | 'low';

export interface RiskFactor {
  key: 'strength' | 'dictionary' | 'reuse' | 'breach' | 'age' | 'expired' | 'no2fa' | 'domain';
  label: string;
  points: number;
}

export interface RiskScore {
  score: number;
  level: RiskLevel;
  factors: RiskFactor[];
}

export interface RiskContext {
  reusedIds: Set<string>;
  breaches: Record<string, BreachEntry>;
  maxAgeDays: number;
  now: number;
}

export const RiskLevelLabels: Record<RiskLevel, string> = { critical: 'Crítico', high: 'Alto', medium: 'Médio', low: 'Baixo' };

/** Pontos de cada fator (somados e limitados a 100). */
export const RISK_POINTS = {
  critical: 35,
  weak: 25,
  medium: 10,
  dictionary: 15,
  reuse: 25,
  breach: 45,
  old: 10,
  veryOld: 15,
  expired: 20,
  no2fa: 10,
  domainDanger: 30,
  domainWarning: 8,
};

/** Categorias em que uma invasão causa mais estrago. */
const SENSITIVE: CredentialCategory[] = ['finance', 'email', 'government', 'work', 'health'];
const SENSITIVE_FACTOR = 1.2;

/** A credencial registra que o 2FA está ativo? (campo personalizado ou nota mencionando 2FA/TOTP/autenticador) */
export function has2faMarker(c: Pick<Credential, 'customFields' | 'notes'>): boolean {
  const re = /\b(2fa|mfa|totp|otp|autenticador|authenticator|duas etapas|dois fatores|two[- ]factor)\b/i;
  return (c.customFields || []).some(f => re.test(f.label) || re.test(f.value)) || re.test(c.notes || '');
}

export function riskLevel(score: number): RiskLevel {
  if (score >= 70) return 'critical';
  if (score >= 45) return 'high';
  if (score >= 20) return 'medium';
  return 'low';
}

function strengthFactor(c: Credential): RiskFactor | null {
  if (!c.password) return null;
  const a = analyzeCached(c.password);
  if (a.strength === 'critical') return { key: 'strength', label: 'Senha crítica', points: RISK_POINTS.critical };
  if (a.strength === 'weak') return { key: 'strength', label: 'Senha fraca', points: RISK_POINTS.weak };
  if (a.strength === 'medium') return { key: 'strength', label: 'Senha de força média', points: RISK_POINTS.medium };
  return null;
}

/** Senha que um ataque de dicionário testa cedo (lista de senhas comuns, palavras, leetspeak, sufixo numérico). */
function dictionaryFactor(c: Credential): RiskFactor | null {
  const reason = c.password ? analyzeCached(c.password).dictionary : undefined;
  return reason ? { key: 'dictionary', label: reason, points: RISK_POINTS.dictionary } : null;
}

function ageFactor(c: Credential, ctx: RiskContext): RiskFactor | null {
  const limit = c.maxPasswordAgeDays || ctx.maxAgeDays;
  if (!limit || !c.password) return null;
  const age = passwordAge(c);
  if (age <= limit) return null;
  return { key: 'age', label: `Senha com ${age} dias (troque a cada ${limit})`, points: age > 2 * limit ? RISK_POINTS.veryOld : RISK_POINTS.old };
}

function domainFactor(c: Credential): RiskFactor | null {
  if (!c.url || /^androidapp:\/\//i.test(c.url)) return null;
  const v = analyzeDomain(c.url);
  if (v.level === 'ok') return null;
  const why = v.reasons[0] || 'endereço suspeito';
  return v.level === 'danger' ? { key: 'domain', label: `Endereço suspeito: ${why}`, points: RISK_POINTS.domainDanger } : { key: 'domain', label: why, points: RISK_POINTS.domainWarning };
}

export const RiskService = {
  /** Contexto calculado uma vez para a lista toda (reutilização, cache de vazamentos, prazo padrão). */
  context(creds: Credential[], opts: Partial<RiskContext> = {}): RiskContext {
    return {
      reusedIds: opts.reusedIds || new Set(findReused(creds).flat().map(c => c.id)),
      breaches: opts.breaches || BreachService.cachedEntries(),
      maxAgeDays: opts.maxAgeDays ?? (Vault.settings.passwordMaxAgeDays || 90),
      now: opts.now ?? Date.now(),
    };
  },

  score(c: Credential, ctx: RiskContext): RiskScore {
    const factors: RiskFactor[] = [];
    const push = (f: RiskFactor | null) => f && factors.push(f);
    push(strengthFactor(c));
    push(dictionaryFactor(c));
    if (ctx.reusedIds.has(c.id)) push({ key: 'reuse', label: 'Senha repetida em outro serviço', points: RISK_POINTS.reuse });
    const breach = ctx.breaches[c.id];
    if (isFresh(breach, c, ctx.now) && breach.count > 0) push({ key: 'breach', label: `Senha vazada (${breachText(breach.count)})`, points: RISK_POINTS.breach });
    push(ageFactor(c, ctx));
    if (c.expiresAt && Date.parse(c.expiresAt) < ctx.now) push({ key: 'expired', label: 'Credencial vencida', points: RISK_POINTS.expired });
    const known = KNOWN_DOMAINS[registrableDomain(c.url || '')];
    if (known?.twoFactor && !has2faMarker(c)) push({ key: 'no2fa', label: `${known.name} oferece verificação em duas etapas (2FA): ative-a`, points: RISK_POINTS.no2fa });
    push(domainFactor(c));
    const base = factors.reduce((a, f) => a + f.points, 0);
    const score = Math.min(100, Math.round(base * (SENSITIVE.includes(c.category) ? SENSITIVE_FACTOR : 1)));
    factors.sort((a, b) => b.points - a.points);
    return { score, level: riskLevel(score), factors };
  },

  /** Lista ordenada do maior risco para o menor. */
  rank<T extends Credential>(creds: T[], ctx: RiskContext = RiskService.context(creds)): { cred: T; risk: RiskScore }[] {
    return creds
      .map(cred => ({ cred, risk: this.score(cred, ctx) }))
      .sort((a, b) => b.risk.score - a.risk.score || a.cred.title.localeCompare(b.cred.title, 'pt-BR'));
  },

  /** Quantas credenciais em cada nível. */
  summary(ranked: { risk: RiskScore }[]): Record<RiskLevel, number> {
    const out: Record<RiskLevel, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const r of ranked) out[r.risk.level]++;
    return out;
  },
};
