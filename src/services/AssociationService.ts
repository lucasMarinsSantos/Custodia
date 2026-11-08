// Sites e apps associados a uma credencial: validação do que o usuário digita na edição e do que chega
// por parâmetro de navegação (cadastro aberto pela sugestão "Deseja salvar esta senha no cofre?").
import { normalizeAssociated } from './DomainService';
import { normalizeAndroidPackage } from './AutofillService';
import { Credential } from '../types/models';

export type AssocKind = 'site' | 'app';
export type Assoc = Pick<Credential, 'associatedDomains' | 'androidPackages'>;

/** Máximo de itens de cada tipo por credencial. */
export const MAX_ASSOCIATIONS = 20;

export const ASSOC_MSG = {
  badSite: 'Domínio inválido. Use, por exemplo, empresa.com ou *.empresa.com.',
  badApp: 'Pacote inválido. Use, por exemplo, com.empresa.app (navegadores não podem ser associados).',
  duplicate: 'Este item já está na lista.',
  tooMany: `Use no máximo ${MAX_ASSOCIATIONS} itens de cada tipo.`,
};

/** Adiciona um domínio ou pacote validado. Devolve o novo valor ou a mensagem de erro. */
export function addAssociation(value: Assoc, kind: AssocKind, entry: string): { next?: Assoc; error?: string } {
  const normalized = kind === 'site' ? normalizeAssociated(entry) : normalizeAndroidPackage(entry);
  if (!normalized) return { error: kind === 'site' ? ASSOC_MSG.badSite : ASSOC_MSG.badApp };
  const list = kind === 'site' ? value.associatedDomains : value.androidPackages;
  if (list.includes(normalized)) return { error: ASSOC_MSG.duplicate };
  if (list.length >= MAX_ASSOCIATIONS) return { error: ASSOC_MSG.tooMany };
  return { next: kind === 'site' ? { ...value, associatedDomains: [...list, normalized] } : { ...value, androidPackages: [...list, normalized] } };
}

/**
 * Cadastro aberto pela sugestão "Deseja salvar esta senha no cofre?" (login percebido pelo preenchimento automático):
 * já vem com o site ou o pacote do app, validados de novo aqui porque chegam por parâmetro de navegação.
 */
export function prefillFromAutofill(params: any): Partial<Credential> {
  const url = typeof params?.prefillUrl === 'string' ? params.prefillUrl.slice(0, 2048) : '';
  const host = url ? normalizeAssociated(url) : '';
  const pkg = typeof params?.prefillPackage === 'string' ? normalizeAndroidPackage(params.prefillPackage) : '';
  const out: Partial<Credential> = {};
  if (host && !host.startsWith('*.')) Object.assign(out, { url: `https://${host}`, title: host });
  if (pkg) Object.assign(out, { androidPackages: [pkg], title: out.title || pkg });
  return out;
}

