// Utilitários gerais

const MULTI_TLDS = new Set([
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br', 'jus.br', 'mil.br', 'art.br', 'coop.br', 'leg.br', 'mp.br',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'com.ar', 'com.mx', 'com.pt',
  'co.in', 'com.cn', 'com.tr', 'co.za', 'com.co', 'com.pe', 'com.uy', 'com.py', 'com.ve', 'com.bo', 'co.nz',
]);

/** Extrai o hostname de uma URL (aceita entradas sem protocolo). */
export function hostnameOf(url: string): string {
  if (!url) return '';
  let s = url.trim().toLowerCase();
  if (s.startsWith('androidapp://')) return s.replace('androidapp://', '');
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split(/[/?#]/)[0];
  s = s.split('@').pop() || s;
  s = s.split(':')[0];
  return s.replace(/^www\d*\./, '');
}

/** Domínio registrável (eTLD+1), ex.: login.itau.com.br → itau.com.br */
export function registrableDomain(urlOrHost: string): string {
  const host = hostnameOf(urlOrHost);
  if (!host || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join('.');
  if (MULTI_TLDS.has(last2)) return parts.slice(-3).join('.');
  return last2;
}

export function normalizeUrl(url: string): string {
  const u = url.trim();
  if (!u) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return u;
  return 'https://' + u;
}

export function daysBetween(a: string | number | Date, b: string | number | Date = new Date()): number {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

export function formatDate(iso?: string | null, withTime = false): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const date = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  if (!withTime) return date;
  return `${date} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function timeAgo(iso?: string | null): string {
  if (!iso) return 'nunca';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'há 1 dia';
  if (d < 30) return `há ${d} dias`;
  const m = Math.floor(d / 30);
  if (m === 1) return 'há 1 mês';
  if (m < 12) return `há ${m} meses`;
  const y = Math.floor(m / 12);
  return y === 1 ? 'há 1 ano' : `há ${y} anos`;
}

export function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}
