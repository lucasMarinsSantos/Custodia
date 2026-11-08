// Força das senhas salvas
// Dashboard com pontuação geral, distribuição de força e destaque para senhas fracas, curtas ou repetidas.

import { Credential, PasswordStrength } from '../types/models';
import { PasswordService, StrengthLevel } from './PasswordService';
import { daysBetween, registrableDomain } from '../utils';
import { DictionaryService } from './DictionaryService';

/** Senha encontrada no dicionário conta no máximo como fraca, por mais longa que pareça. */
export const DICTIONARY_MAX_SCORE = 40;

const strengthCache = new Map<string, { strength: PasswordStrength; score: number; dictionary?: string }>();

export function analyzeCached(pw: string) {
  let v = strengthCache.get(pw);
  if (!v) {
    // A lista das 10 mil senhas mais comuns volta a valer para as credenciais salvas (não só para a senha mestra)
    const a = PasswordService.analyze(pw, { checkCommon: true });
    const dict = DictionaryService.check(pw);
    v = dict.found
      ? { strength: a.score > DICTIONARY_MAX_SCORE ? 'weak' : a.strength, score: Math.min(a.score, DICTIONARY_MAX_SCORE), dictionary: dict.reason }
      : { strength: a.strength, score: a.score };
    if (strengthCache.size > 5000) strengthCache.clear();
    strengthCache.set(pw, v);
  }
  return v;
}

export const strengthOf = (pw: string): PasswordStrength => analyzeCached(pw).strength;

/** Idade da senha (dias desde a última troca). */
export const passwordAge = (c: Credential) => daysBetween(c.passwordChangedAt || c.createdAt);

export interface Recommendation {
  id: string;
  credentialId: string;
  title: string;
  message: string;
  severity: 'danger' | 'warning';
}

export interface SecurityReport {
  total: number;
  score: number;
  strongPercent: number;
  distribution: Record<PasswordStrength, number>;
  averageAgeDays: number;
  /** Fracas ou críticas. */
  weak: Credential[];
  /** Menos de 12 caracteres. */
  short: Credential[];
  /** Grupos de credenciais que usam exatamente a mesma senha em serviços diferentes. */
  reused: Credential[][];
  recommendations: Recommendation[];
  categories: Record<string, number>;
}

export function findReused(creds: Credential[]): Credential[][] {
  const map = new Map<string, Credential[]>();
  for (const c of creds) {
    if (!c.password) continue;
    const list = map.get(c.password) || [];
    list.push(c);
    map.set(c.password, list);
  }
  return [...map.values()].filter(g => {
    const services = new Set(g.map(c => registrableDomain(c.url) || c.title.trim().toLowerCase()));
    return g.length > 1 && services.size > 1;
  });
}

export const AnalysisService = {
  report(creds: Credential[]): SecurityReport {
    const distribution: Record<PasswordStrength, number> = { critical: 0, weak: 0, medium: 0, strong: 0, very_strong: 0 };
    const categories: Record<string, number> = {};
    let ageSum = 0;
    for (const c of creds) {
      distribution[strengthOf(c.password)]++;
      ageSum += passwordAge(c);
      categories[c.category] = (categories[c.category] || 0) + 1;
    }
    const total = creds.length;
    const strong = distribution.strong + distribution.very_strong;
    const weak = creds.filter(c => StrengthLevel[strengthOf(c.password)] <= 1);
    const short = creds.filter(c => c.password.length > 0 && c.password.length < 12);
    const reused = findReused(creds);
    const reusedIds = new Set(reused.flat().map(c => c.id));

    const recommendations: Recommendation[] = [];
    for (const c of creds) {
      const s = strengthOf(c.password);
      if (s === 'critical' || s === 'weak') {
        recommendations.push({
          id: `weak:${c.id}`,
          credentialId: c.id,
          title: `Troque a senha de ${c.title}`,
          message: `Senha Fraca: ${analyzeCached(c.password).dictionary || PasswordService.analyze(c.password).feedback.slice(0, 2).join('; ') || 'use o gerador.'}`,
          severity: 'warning',
        });
      }
      if (reusedIds.has(c.id)) {
        recommendations.push({
          id: `reuse:${c.id}`,
          credentialId: c.id,
          title: `Senha repetida em ${c.title}`,
          message: 'A mesma senha é usada em outro serviço. Use uma senha única para cada conta.',
          severity: 'warning',
        });
      }
    }
    recommendations.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'danger' ? -1 : 1));

    // Pontuação geral 0–100: média da força ponderada por penalidades de reutilização e senhas curtas
    let score = 100;
    if (total > 0) {
      const avgStrength = creds.reduce((acc, c) => acc + analyzeCached(c.password).score, 0) / total;
      score = Math.round(avgStrength - (reusedIds.size / total) * 25 - (short.length / total) * 10);
      score = Math.max(0, Math.min(100, score));
    }

    return {
      total,
      score,
      strongPercent: total ? Math.round((strong / total) * 100) : 0,
      distribution,
      averageAgeDays: total ? Math.round(ageSum / total) : 0,
      weak,
      short,
      reused,
      recommendations,
      categories,
    };
  },
};
