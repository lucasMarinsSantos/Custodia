// Regras de segurança por pasta
// A regra de uma pasta vale para as subpastas. Quando pai e filha definem a mesma regra, vale a mais rígida.

import { Credential, DefaultFolderPolicy, Folder, FolderPolicy, PasswordStrength } from '../types/models';

const STRENGTH_ORDER: PasswordStrength[] = ['critical', 'weak', 'medium', 'strong', 'very_strong'];

const minOf = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.min(a, b));

function strictest(a: FolderPolicy, b: FolderPolicy): FolderPolicy {
  const strength =
    a.minStrength && b.minStrength
      ? STRENGTH_ORDER[Math.max(STRENGTH_ORDER.indexOf(a.minStrength), STRENGTH_ORDER.indexOf(b.minStrength))]
      : a.minStrength || b.minStrength;
  return {
    requireReauth: a.requireReauth || b.requireReauth,
    minStrength: strength,
    maxAgeDays: minOf(a.maxAgeDays, b.maxAgeDays),
    blockAutofill: a.blockAutofill || b.blockAutofill,
    blockExport: a.blockExport || b.blockExport,
    clipboardSeconds: minOf(a.clipboardSeconds, b.clipboardSeconds),
  };
}

export const PolicyService = {
  /** Política efetiva de uma pasta: a dela combinada com a de todas as pastas acima. */
  effective(folders: Folder[], folderId: string | null): FolderPolicy {
    let policy: FolderPolicy = { ...DefaultFolderPolicy };
    const byId = new Map(folders.map(f => [f.id, f]));
    let cur = folderId ? byId.get(folderId) : undefined;
    for (let guard = 0; cur && guard < 20; guard++) {
      if (cur.policy) policy = strictest(policy, { ...DefaultFolderPolicy, ...cur.policy });
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return policy;
  },

  forCredential(folders: Folder[], cred: Pick<Credential, 'folderId'>): FolderPolicy {
    return this.effective(folders, cred.folderId);
  },

  /** true se a força `s` atende ao mínimo exigido. */
  meetsStrength(s: PasswordStrength, min: PasswordStrength | null): boolean {
    return !min || STRENGTH_ORDER.indexOf(s) >= STRENGTH_ORDER.indexOf(min);
  },

  isEmpty(p: FolderPolicy | undefined): boolean {
    if (!p) return true;
    return !p.requireReauth && !p.minStrength && p.maxAgeDays == null && !p.blockAutofill && !p.blockExport && p.clipboardSeconds == null;
  },
};
