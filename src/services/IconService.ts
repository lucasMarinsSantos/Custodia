// Personalização de ícones
// Cada credencial pode usar: logo automático do site (favicon público, guardado no banco cifrado),
// um glifo + cor escolhidos pelo usuário ou uma imagem da galeria.

import { vaultDb } from '../db/Database';
import { System } from '../native';
import { registrableDomain } from '../utils';
import { bus, Events } from './events';

/** Baixa o logo público do domínio, sem gravar nada (null se não houver internet ou ícone). */
async function fetchLogo(domain: string): Promise<string | null> {
  for (const provider of LOGO_PROVIDERS) {
    try {
      const r = await System.download(provider(domain));
      if (r && r.base64 && r.base64.length > 200) {
        const mime = r.mime && r.mime.startsWith('image/') ? r.mime : 'image/png';
        return `data:${mime};base64,${r.base64}`;
      }
    } catch {
      // tenta o próximo provedor
    }
  }
  return null;
}

const PUBLIC_DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const memory = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

export const LOGO_PROVIDERS = [
  (d: string) => `https://www.google.com/s2/favicons?domain=${d}&sz=128`,
  (d: string) => `https://icons.duckduckgo.com/ip3/${d}.ico`,
];

export const IconService = {
  cached(url: string): string | null | undefined {
    const d = registrableDomain(url);
    return d ? memory.get(d) : null;
  },

  async logoFor(url: string, download = true): Promise<string | null> {
    const domain = registrableDomain(url);
    if (!domain || !vaultDb.isOpen) return null;
    if (memory.has(domain)) return memory.get(domain) || null;
    const stored = await vaultDb.get<{ id: string; dataUri: string | null }>('logos', domain);
    if (stored) {
      memory.set(domain, stored.dataUri);
      return stored.dataUri;
    }
    // Só domínios públicos válidos vão para o serviço de ícones: nada de IPs, hosts internos ou texto arbitrário na URL
    if (!download || !PUBLIC_DOMAIN.test(domain)) return null;
    if (inflight.has(domain)) return inflight.get(domain)!;
    const p = (async () => {
      const dataUri = await fetchLogo(domain);
      if (dataUri && vaultDb.isOpen) await vaultDb.put('logos', { id: domain, dataUri, fetchedAt: new Date().toISOString() }, { silent: true });
      memory.set(domain, dataUri);
      return dataUri;
    })();
    inflight.set(domain, p);
    try {
      return await p;
    } finally {
      inflight.delete(domain);
    }
  },

  /** Baixa de novo o logo. Sem internet, o logo atual é mantido (só é trocado se o download der certo). */
  async refresh(url: string): Promise<string | null> {
    const domain = registrableDomain(url);
    if (!domain || !vaultDb.isOpen || !PUBLIC_DOMAIN.test(domain)) return null;
    const dataUri = await fetchLogo(domain);
    if (!dataUri || !vaultDb.isOpen) return null;
    await vaultDb.put('logos', { id: domain, dataUri, fetchedAt: new Date().toISOString() }, { silent: true });
    memory.set(domain, dataUri);
    bus.emit(Events.DATA_CHANGED);
    return dataUri;
  },

  async count(): Promise<number> {
    return vaultDb.isOpen ? (await vaultDb.all('logos')).length : 0;
  },

  resetMemory() {
    memory.clear();
  },
};

export const GLYPHS = [
  'key', 'lock', 'mail', 'globe', 'briefcase', 'dollar-sign', 'credit-card', 'shopping-bag', 'film', 'music',
  'code', 'github', 'gitlab', 'twitter', 'facebook', 'instagram', 'linkedin', 'youtube', 'twitch', 'slack',
  'cloud', 'server', 'database', 'wifi', 'home', 'heart', 'book', 'camera', 'phone', 'monitor', 'smartphone', 'star',
];

export const ICON_COLORS = ['#EF4444', '#F97316', '#EAB308', '#22C55E', '#0D9488', '#0EA5E9', '#3B82F6', '#6366F1', '#8B5CF6', '#EC4899', '#475569', '#111827'];
