// Credenciais duplicadas
//  • Mesma conta: mesmo site (domínio registrável) e usuário, ou mesmo título e usuário: provável cadastro repetido.
//  • Mesma senha: a mesma senha salva em mais de um registro (reutilização).
//  • Senhas parecidas: mesma "base" com números/símbolos trocados (Flamengo2023! e Flamengo2024!), que um
//    atacante com uma delas adivinha rápido.
// A mesclagem guarda o registro escolhido, completa os campos vazios com os dos outros, junta campos personalizados,
// domínios e pacotes, soma o uso e só então exclui os demais (com confirmação na tela).

import { Credential, PasswordHistoryEntry } from '../types/models';
import { LIMITS, Repo, ValidationError } from './Repository';
import { registrableDomain, stripAccents } from '../utils';

export type DuplicateKind = 'same_account' | 'same_password' | 'similar_password';

export interface DuplicateGroup {
  id: string;
  kind: DuplicateKind;
  /** Descrição do que os itens têm em comum (sem mostrar a senha). */
  label: string;
  items: Credential[];
}

export const DuplicateKindLabels: Record<DuplicateKind, string> = {
  same_account: 'Mesma conta',
  same_password: 'Mesma senha',
  similar_password: 'Senhas parecidas',
};

/** Máximo de senhas antigas guardadas por registro. */
const MAX_HISTORY = 10;
const MIN_SIMILAR_BASE = 5;

const norm = (s: string) => stripAccents((s || '').trim().toLowerCase()).replace(/\s+/g, ' ');

const LEET: Record<string, string> = { '@': 'a', '4': 'a', '3': 'e', '1': 'i', '!': 'i', '0': 'o', $: 's', '5': 's', '7': 't' };

/** "Flamengo2024!" → "flamengo": minúsculas, sem números/símbolos nas pontas e com o leetspeak desfeito no miolo. */
export function passwordBase(pw: string): string {
  const core = norm(pw).replace(/^[^a-z]+/, '').replace(/[^a-z]+$/, '');
  let out = '';
  for (const ch of core) out += LEET[ch] ?? ch;
  return out;
}

/** União de conjuntos (cada credencial termina num único grupo "mesma conta"). */
function groupBy(creds: Credential[], keys: (c: Credential) => string[]): Credential[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const owner = new Map<string, string>();
  for (const c of creds) {
    parent.set(c.id, c.id);
    for (const k of keys(c)) {
      const o = owner.get(k);
      if (o) parent.set(find(c.id), find(o));
      else owner.set(k, c.id);
    }
  }
  const groups = new Map<string, Credential[]>();
  for (const c of creds) {
    const r = find(c.id);
    groups.set(r, [...(groups.get(r) || []), c]);
  }
  return [...groups.values()].filter(g => g.length > 1);
}

function accountKeys(c: Credential): string[] {
  const user = norm(c.username);
  const out: string[] = [];
  const site = registrableDomain(c.url || '');
  if (site) out.push(`site:${site}|${user}`);
  if (c.title.trim()) out.push(`title:${norm(c.title)}|${user}`);
  return out;
}

const byTitle = (a: Credential, b: Credential) => a.title.localeCompare(b.title, 'pt-BR');

function mergeLists(a: string[], b: string[]): string[] {
  return [...new Set([...(a || []), ...(b || [])])];
}

const idsOf = (items: Credential[]) => items.map(c => c.id).join(',');

function push(map: Map<string, Credential[]>, key: string, c: Credential) {
  map.set(key, [...(map.get(key) || []), c]);
}

/** Mesmo site (ou título) e mesmo usuário. */
function accountGroups(creds: Credential[]): DuplicateGroup[] {
  return groupBy(creds, accountKeys).map(g => {
    const sorted = [...g].sort(byTitle);
    const user = sorted[0].username.trim();
    const site = registrableDomain(sorted[0].url || '') || sorted[0].title.trim();
    return { id: `account:${idsOf(sorted)}`, kind: 'same_account' as const, label: user ? `${site} • ${user}` : site, items: sorted };
  });
}

/** Mesma senha em mais de um registro e senhas que só mudam nos números/símbolos das pontas. */
function passwordGroups(creds: Credential[]): DuplicateGroup[] {
  const byPassword = new Map<string, Credential[]>();
  const byBase = new Map<string, Credential[]>();
  for (const c of creds.filter(x => !!x.password)) {
    push(byPassword, c.password, c);
    const base = passwordBase(c.password);
    if (base.length >= MIN_SIMILAR_BASE) push(byBase, base, c);
  }
  const out: DuplicateGroup[] = [];
  for (const g of byPassword.values()) {
    if (g.length < 2) continue;
    const sorted = [...g].sort(byTitle);
    out.push({ id: `password:${idsOf(sorted)}`, kind: 'same_password', label: `A mesma senha em ${g.length} registros`, items: sorted });
  }
  for (const g of byBase.values()) {
    // Só interessa quando há senhas diferentes com a mesma base (iguais já aparecem em "Mesma senha")
    if (new Set(g.map(c => c.password)).size < 2) continue;
    const sorted = [...g].sort(byTitle);
    out.push({ id: `similar:${idsOf(sorted)}`, kind: 'similar_password', label: `${g.length} senhas com a mesma base, só os números ou símbolos mudam`, items: sorted });
  }
  return out;
}

/** Completa o registro mantido com os dados de outro (campos vazios, listas, uso). */
function fillEmpty(merged: Credential, o: Credential) {
  merged.username = merged.username || o.username;
  merged.url = merged.url || o.url;
  merged.password = merged.password || o.password;
  merged.folderId = merged.folderId ?? o.folderId;
  merged.favorite = merged.favorite || o.favorite;
}

function absorb(merged: Credential, o: Credential, history: PasswordHistoryEntry[], now: string) {
  fillEmpty(merged, o);
  if (o.notes && !merged.notes.includes(o.notes)) merged.notes = merged.notes ? `${merged.notes}\n\n${o.notes}` : o.notes;
  const fieldKeys = new Set(merged.customFields.map(f => `${f.label}\u0000${f.value}`));
  merged.customFields = [...merged.customFields, ...o.customFields.filter(f => !fieldKeys.has(`${f.label}\u0000${f.value}`))];
  merged.associatedDomains = mergeLists(merged.associatedDomains, o.associatedDomains);
  merged.androidPackages = mergeLists(merged.androidPackages, o.androidPackages);
  merged.usageCount = (merged.usageCount || 0) + (o.usageCount || 0);
  if (o.lastUsedAt && (!merged.lastUsedAt || o.lastUsedAt > merged.lastUsedAt)) merged.lastUsedAt = o.lastUsedAt;
  // Uma senha diferente não se perde: vai para as senhas anteriores do registro mantido
  if (o.password && o.password !== merged.password && !history.some(h => h.password === o.password)) history.unshift({ password: o.password, changedAt: now });
}

export const DuplicateService = {
  find(creds: Credential[]): DuplicateGroup[] {
    return [...accountGroups(creds), ...passwordGroups(creds)];
  },

  /** Existe outra credencial com o mesmo site/título e usuário? (aviso no cadastro) */
  findSameAccount(creds: Credential[], draft: Pick<Credential, 'id' | 'title' | 'username' | 'url'>): Credential | null {
    const keys = new Set(accountKeys(draft as Credential));
    if (!keys.size) return null;
    return creds.find(c => c.id !== draft.id && accountKeys(c).some(k => keys.has(k))) || null;
  },

  /** Junta os dados dos registros no escolhido (sem salvar). */
  mergeInto(keep: Credential, others: Credential[]): Credential {
    const merged: Credential = { ...keep, customFields: [...(keep.customFields || [])] };
    const history: PasswordHistoryEntry[] = [...(keep.passwordHistory || [])];
    const now = new Date().toISOString();
    for (const o of others) absorb(merged, o, history, now);
    merged.passwordHistory = history.slice(0, MAX_HISTORY);
    // Respeita os limites do repositório (a soma de dois registros grandes não pode impedir a mesclagem)
    merged.notes = merged.notes.slice(0, LIMITS.notes);
    merged.customFields = merged.customFields.slice(0, LIMITS.customFields);
    return merged;
  },

  /** Mescla e exclui os outros registros. Devolve a credencial mantida. */
  async merge(keepId: string, otherIds: string[]): Promise<Credential> {
    const keep = await Repo.credential(keepId);
    if (!keep) throw new ValidationError('A credencial escolhida não existe mais.');
    const others: Credential[] = [];
    for (const id of otherIds) {
      if (id === keepId) continue;
      const c = await Repo.credential(id);
      if (c) others.push(c);
    }
    if (!others.length) throw new ValidationError('Escolha ao menos uma credencial para mesclar.');
    const saved = await Repo.saveCredential(this.mergeInto(keep, others));
    for (const o of others) await Repo.deleteCredential(o.id);
    return saved;
  },
};
