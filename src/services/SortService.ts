// Ordenação inteligente
//  • Inteligente: favoritas + frequência de uso (log) + recência do último acesso (decaimento de 14 dias)
//  • Recentes: último acesso/alteração • Mais usadas: contador de uso • A–Z: título

import { Credential, SortMode } from '../types/models';

const DAY = 86400000;

/** Pontuação da ordenação inteligente: frequência de uso + data do último acesso (decaimento). */
export function smartScore(c: Credential, now = Date.now()): number {
  const last = c.lastUsedAt ? new Date(c.lastUsedAt).getTime() : new Date(c.createdAt).getTime() - 30 * DAY;
  const days = Math.max(0, (now - last) / DAY);
  const recency = Math.exp(-days / 14) * 10;
  return (c.favorite ? 20 : 0) + Math.log2(1 + (c.usageCount || 0)) * 4 + recency;
}

export function sortCredentials(items: Credential[], mode: SortMode, now = Date.now()): Credential[] {
  const byTitle = (a: Credential, b: Credential) => a.title.localeCompare(b.title, 'pt-BR');
  // Chaves calculadas uma vez por item (não a cada comparação do sort)
  const keyed = items.map(c => ({ c, k: mode === 'smart' ? -smartScore(c, now) : mode === 'usage' ? -(c.usageCount || 0) : 0 }));
  if (mode === 'recent') keyed.sort((a, b) => (b.c.lastUsedAt || b.c.updatedAt).localeCompare(a.c.lastUsedAt || a.c.updatedAt) || byTitle(a.c, b.c));
  else if (mode === 'alpha') keyed.sort((a, b) => byTitle(a.c, b.c));
  else keyed.sort((a, b) => a.k - b.k || byTitle(a.c, b.c));
  return keyed.map(x => x.c);
}
