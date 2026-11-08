// Regras de segurança por pasta: edição, validação e aplicação
// A combinação das regras (pasta + pastas acima, vale a mais rígida) fica no PolicyService; aqui ficam:
//  • a normalização do que vem do editor (limites e tipos, nada de valor fora da faixa no banco);
//  • a regra herdada (o que a pasta já recebe das pastas acima, mostrado no editor);
//  • a aplicação no cadastro (força mínima) e na área de transferência (tempo de limpeza).

import { Credential, DefaultFolderPolicy, Folder, FolderPolicy, PasswordStrength, StrengthLabels } from '../types/models';
import { PasswordService } from './PasswordService';
import { PolicyService } from './PolicyService';
import { Repo, ValidationError } from './Repository';

export const POLICY_LIMITS = {
  maxAgeDays: { min: 1, max: 3650 },
  clipboardSeconds: { min: 5, max: 600 },
};

const STRENGTHS: PasswordStrength[] = ['critical', 'weak', 'medium', 'strong', 'very_strong'];

/** Inteiro dentro da faixa, ou null (sem regra). Texto vazio = sem regra; fora da faixa = erro claro. */
function boundedInt(value: unknown, range: { min: number; max: number }, label: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < range.min || n > range.max) {
    throw new ValidationError(`${label}: informe um número inteiro entre ${range.min} e ${range.max}.`);
  }
  return n;
}

export const FolderRulesService = {
  /** Valida a regra vinda do editor. Lança ValidationError com a mensagem para a tela. */
  normalize(input: Partial<Record<keyof FolderPolicy, unknown>>): FolderPolicy {
    const min = input.minStrength;
    if (min !== null && min !== undefined && !STRENGTHS.includes(min as PasswordStrength)) {
      throw new ValidationError('Força mínima inválida.');
    }
    return {
      ...DefaultFolderPolicy,
      requireReauth: input.requireReauth === true,
      minStrength: (min as PasswordStrength | null | undefined) ?? null,
      maxAgeDays: boundedInt(input.maxAgeDays, POLICY_LIMITS.maxAgeDays, 'Prazo máximo da senha'),
      blockAutofill: input.blockAutofill === true,
      blockExport: input.blockExport === true,
      clipboardSeconds: boundedInt(input.clipboardSeconds, POLICY_LIMITS.clipboardSeconds, 'Limpeza da área de transferência'),
    };
  },

  /** Regra que a pasta herda das pastas acima (sem a dela). */
  inherited(folders: Folder[], folderId: string): FolderPolicy {
    const f = folders.find(x => x.id === folderId);
    return PolicyService.effective(folders, f?.parentId ?? null);
  },

  /** Grava a regra da pasta (regra vazia é removida). */
  async save(folderId: string, input: Partial<Record<keyof FolderPolicy, unknown>>): Promise<Folder> {
    const policy = this.normalize(input);
    const folders = await Repo.folders();
    const folder = folders.find(f => f.id === folderId);
    if (!folder) throw new ValidationError('Pasta não encontrada.');
    const next: Folder = { ...folder, policy: PolicyService.isEmpty(policy) ? undefined : policy };
    await Repo.saveFolder(next);
    return next;
  },

  async forCredential(cred: Pick<Credential, 'folderId'>): Promise<FolderPolicy> {
    return PolicyService.forCredential(await Repo.folders(), cred);
  },

  /**
   * Força mínima da pasta no cadastro: devolve a mensagem de recusa, ou null se a senha atende.
   * Senha vazia não é avaliada aqui (o cadastro já trata campos obrigatórios).
   */
  passwordError(folders: Folder[], folderId: string | null, password: string): string | null {
    const policy = PolicyService.effective(folders, folderId);
    if (!policy.minStrength || !password) return null;
    const strength = PasswordService.analyze(password, { checkCommon: true }).strength;
    if (PolicyService.meetsStrength(strength, policy.minStrength)) return null;
    const path = Repo.folderPath(folders, folderId);
    return `A pasta "${path}" exige senha no mínimo ${StrengthLabels[policy.minStrength]}. A senha informada é ${StrengthLabels[strength]}.`;
  },

  /** Tempo de limpeza da área de transferência: o da pasta, sem nunca passar do configurado nos Ajustes. */
  clipboardSeconds(policy: FolderPolicy, globalSeconds: number): number {
    const global = globalSeconds > 0 ? globalSeconds : 30;
    return policy.clipboardSeconds ? Math.min(policy.clipboardSeconds, global) : global;
  },

  /** Resumo legível das regras ativas (lista de pastas e editor). */
  describe(policy: FolderPolicy): string[] {
    const out: string[] = [];
    if (policy.requireReauth) out.push('Reautenticar para ver/copiar');
    if (policy.minStrength) out.push(`Força mínima: ${StrengthLabels[policy.minStrength]}`);
    if (policy.maxAgeDays) out.push(`Trocar a cada ${policy.maxAgeDays} dias`);
    if (policy.blockAutofill) out.push('Sem preenchimento automático');
    if (policy.blockExport) out.push('Fora da exportação');
    if (policy.clipboardSeconds) out.push(`Área de transferência: ${policy.clipboardSeconds} s`);
    return out;
  },
};
