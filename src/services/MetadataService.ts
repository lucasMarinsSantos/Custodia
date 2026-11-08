// Metadados do cofre: estatísticas para o painel da aba Saúde das Senhas
// Contas por categoria, distribuição de força, idade das senhas, mais usadas, pastas, notas e formulários.
// Função pura sobre os dados já carregados: nada sai do aparelho e nenhuma senha aparece no resultado.

import { CategoryLabels, Credential, CredentialCategory, Folder, FormItem, FormKind, PasswordStrength, SecureNote } from '../types/models';
import { strengthOf } from './AnalysisService';

const DAY = 86400000;

export interface CountItem {
  key: string;
  label: string;
  count: number;
}

export interface VaultStats {
  totals: { credentials: number; folders: number; notes: number; forms: number; favorites: number; inactive: number; neverUsed: number };
  byCategory: CountItem[];
  strength: Record<PasswordStrength, number>;
  /** Faixas de idade da senha (desde a última troca). */
  ages: CountItem[];
  averageAgeDays: number;
  oldest: { id: string; title: string; days: number } | null;
  mostUsed: { id: string; title: string; usageCount: number }[];
  byFolder: CountItem[];
  withoutFolder: number;
  forms: Record<FormKind, number>;
  notesByCategory: CountItem[];
  /** Credencial criada mais recentemente e mais antiga (datas de cadastro). */
  createdRange: { first: string | null; last: string | null };
}

export interface StatsInput {
  creds: Credential[];
  folders?: Folder[];
  notes?: Pick<SecureNote, 'category'>[];
  forms?: Pick<FormItem, 'kind'>[];
}

export const AGE_BUCKETS: { key: string; label: string; max: number }[] = [
  { key: 'lt30', label: 'Até 30 dias', max: 30 },
  { key: 'lt90', label: '31 a 90 dias', max: 90 },
  { key: 'lt180', label: '91 a 180 dias', max: 180 },
  { key: 'lt365', label: '181 dias a 1 ano', max: 365 },
  { key: 'old', label: 'Mais de 1 ano', max: Infinity },
];

const NOTE_LABELS: Record<string, string> = {
  recovery_key: 'Chave de recuperação',
  wifi: 'Wi-Fi',
  bank_info: 'Dados bancários',
  document: 'Documento',
  personal: 'Pessoal',
  other: 'Outros',
};

const desc = (a: CountItem, b: CountItem) => b.count - a.count || a.label.localeCompare(b.label, 'pt-BR');

function countBy<T>(items: T[], key: (t: T) => string, label: (k: string) => string): CountItem[] {
  const m = new Map<string, number>();
  for (const it of items) {
    const k = key(it);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].map(([k, count]) => ({ key: k, label: label(k), count })).sort(desc);
}

/** Dias desde a última troca da senha (datas inválidas contam como hoje). */
function ageInDays(c: Credential, now: number): number {
  const changed = Date.parse(c.passwordChangedAt || c.createdAt);
  return Number.isNaN(changed) ? 0 : Math.max(0, Math.floor((now - changed) / DAY));
}

function ageStats(creds: Credential[], now: number) {
  const ages = AGE_BUCKETS.map(b => ({ key: b.key, label: b.label, count: 0 }));
  let ageSum = 0;
  let oldest: VaultStats['oldest'] = null;
  for (const c of creds) {
    const days = ageInDays(c, now);
    ageSum += days;
    ages[AGE_BUCKETS.findIndex(b => days <= b.max)].count++;
    if (!oldest || days > oldest.days) oldest = { id: c.id, title: c.title, days };
  }
  return { ages, ageSum, oldest };
}

export const MetadataService = {
  stats({ creds, folders = [], notes = [], forms = [] }: StatsInput, now = Date.now()): VaultStats {
    const strength: Record<PasswordStrength, number> = { critical: 0, weak: 0, medium: 0, strong: 0, very_strong: 0 };
    for (const c of creds) if (c.password) strength[strengthOf(c.password)]++;
    const { ages, ageSum, oldest } = ageStats(creds, now);
    const folderName = new Map(folders.map(f => [f.id, f.name]));
    const inFolder = creds.filter(c => c.folderId && folderName.has(c.folderId));
    const created = creds.map(c => c.createdAt).filter(Boolean).sort();
    const formCount: Record<FormKind, number> = { card: 0, address: 0, identity: 0 };
    for (const f of forms) if (f && f.kind in formCount) formCount[f.kind]++;
    return {
      totals: {
        credentials: creds.length,
        folders: folders.length,
        notes: notes.length,
        forms: forms.length,
        favorites: creds.filter(c => c.favorite).length,
        inactive: creds.filter(c => c.inactive).length,
        neverUsed: creds.filter(c => !c.usageCount).length,
      },
      byCategory: countBy(creds, c => c.category, k => CategoryLabels[k as CredentialCategory] || 'Outros'),
      strength,
      ages,
      averageAgeDays: creds.length ? Math.round(ageSum / creds.length) : 0,
      oldest,
      mostUsed: creds
        .filter(c => c.usageCount > 0)
        .sort((a, b) => b.usageCount - a.usageCount || a.title.localeCompare(b.title, 'pt-BR'))
        .slice(0, 5)
        .map(c => ({ id: c.id, title: c.title, usageCount: c.usageCount })),
      byFolder: countBy(inFolder, c => c.folderId as string, k => folderName.get(k) || 'Pasta'),
      withoutFolder: creds.length - inFolder.length,
      forms: formCount,
      notesByCategory: countBy(notes, n => n.category || 'other', k => NOTE_LABELS[k] || 'Outros'),
      createdRange: { first: created[0] ?? null, last: created[created.length - 1] ?? null },
    };
  },
};
