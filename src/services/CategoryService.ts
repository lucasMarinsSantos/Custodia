// Categorização inteligente por domínio/nome do serviço
// Base local de domínios conhecidos + palavras-chave. Sugere a categoria (e o site) ao cadastrar.

import { CATEGORY_KEYWORDS, KNOWN_DOMAINS, KnownDomain } from '../data/domains';
import { CredentialCategory } from '../types/models';
import { registrableDomain, stripAccents } from '../utils';

export type Confidence = 'alta' | 'média' | 'baixa';

export const CategoryService = {
  lookup(url: string): KnownDomain | null {
    const host = (url || '').toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
    const reg = registrableDomain(url);
    return KNOWN_DOMAINS[host] || KNOWN_DOMAINS[reg] || null;
  },

  suggest(url: string, title: string): { category: CredentialCategory; name?: string; confidence: Confidence } {
    const known = url ? this.lookup(url) : null;
    if (known) return { category: known.category, name: known.name, confidence: 'alta' };
    // Busca pelo nome do serviço na base
    const t = stripAccents(title || '').toLowerCase().trim();
    if (t) {
      for (const [domain, info] of Object.entries(KNOWN_DOMAINS)) {
        const n = stripAccents(info.name).toLowerCase();
        if (n === t || domain.split('.')[0] === t.replace(/\s+/g, '')) {
          return { category: info.category, name: info.name, confidence: 'alta' };
        }
      }
    }
    const haystack = `${registrableDomain(url)} ${t}`;
    let best: CredentialCategory = 'other';
    let bestHits = 0;
    (Object.keys(CATEGORY_KEYWORDS) as CredentialCategory[]).forEach(cat => {
      const hits = CATEGORY_KEYWORDS[cat].filter(kw => haystack.includes(kw)).length;
      if (hits > bestHits) {
        best = cat;
        bestHits = hits;
      }
    });
    return { category: best, confidence: bestHits > 0 ? 'média' : 'baixa' };
  },

  /** Sugere o domínio a partir do nome digitado (ex.: "Nubank" → nubank.com.br). */
  domainForName(title: string): string | null {
    const t = stripAccents(title || '').toLowerCase().trim();
    if (t.length < 2) return null;
    for (const [domain, info] of Object.entries(KNOWN_DOMAINS)) {
      if (stripAccents(info.name).toLowerCase() === t) return domain;
    }
    return null;
  },

  count(): number {
    return Object.keys(KNOWN_DOMAINS).length;
  },
};
