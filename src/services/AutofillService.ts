// Preenchimento automático em outros apps e navegadores (, parte de preenchimento)
//
// Desenho de segurança (o serviço de acessibilidade roda mesmo com o cofre fechado):
//  1. O serviço NUNCA recebe a lista de senhas. Com o cofre aberto ele recebe só um índice de sugestões
//     (id, título, hosts, domínios associados e pacotes), mantido na memória e apagado ao bloquear.
//  2. Ao tocar no balão do Custódia, o serviço cria um pedido (pacote + URL da barra do navegador, sem segredos) e
//     abre o app. O usuário desbloqueia (biometria ou senha) e escolhe a credencial nesta tela.
//  3. O app verifica tudo aqui, em JS: correspondência (site exato, subdomínio, domínio associado ou pacote),
//     anti-phishing (`verifyBeforeFill`), regra da pasta (`blockAutofill`, `requireReauth`), credencial inativa e
//     o ajuste `autofillEnabled`.
//  4. Só então o par usuário/senha escolhido vai ao serviço, em memória e por no máximo 30 s; o serviço só preenche
//     no mesmo app (e no mesmo host, nos navegadores) do pedido e descarta o par logo depois.

import { Autofill, AutofillIndexEntry, AutofillKind, AutofillRequest, PasswordChangeSignal } from '../native/integration';
import { vaultDb } from '../db/Database';
import { uuid, wipe } from '../crypto';
import { Credential, Folder, FormItem } from '../types/models';
import { hostnameOf } from '../utils';
import { analyzeDomain, credentialsFor, FillTarget, isSameOrSubdomain, isValidHost, MatchKind, normalizeAssociated, verifyBeforeFill } from './DomainService';
import { PolicyService } from './PolicyService';
import { Repo } from './Repository';
import { Vault } from './VaultService';
import { AlertService } from './AlertService';
import { bus } from './events';
import { formFieldsFor } from './AutofillFieldService';

/** Tempo máximo que o par escolhido fica na memória do serviço esperando o app de destino voltar ao primeiro plano. */
export const AUTOFILL_DELIVERY_TTL_MS = 30_000;
/** Um pedido de preenchimento vale por 2 minutos (tempo de desbloquear e escolher). */
export const AUTOFILL_REQUEST_MAX_AGE_MS = 2 * 60_000;
export const MAX_PASSWORD_CHANGE_SUGGESTIONS = 20;

/** Evento do barramento: novo pedido de preenchimento pronto para a tela de escolha. */
export const AUTOFILL_REQUEST_EVENT = 'autofillRequest';

/**
 * Navegadores cujo id da barra de endereço o serviço conhece (lista igual à do `CustodiaAccessibilityService.kt`).
 * Num navegador, a correspondência é sempre pela URL: o pacote do navegador nunca identifica um site.
 */
export const BROWSER_PACKAGES = [
  'com.android.chrome',
  'com.chrome.beta',
  'com.chrome.dev',
  'org.mozilla.firefox',
  'org.mozilla.firefox_beta',
  'org.mozilla.fenix',
  'com.microsoft.emmx',
  'com.sec.android.app.sbrowser',
  'com.sec.android.app.sbrowser.beta',
  'com.brave.browser',
  'com.brave.browser_beta',
];

export const MSG = {
  locked: 'Cofre bloqueado. Desbloqueie para preencher.',
  disabled: 'O preenchimento automático está desligado em Ajustes › Preenchimento automático.',
  inactive: 'Esta credencial está inativa (vencida) e não é usada no preenchimento.',
  blockedFolder: 'A pasta desta credencial não permite preenchimento automático. Copie a senha manualmente.',
  noUrl: 'Não foi possível ler o endereço do site no navegador. Por segurança, o preenchimento foi bloqueado.',
  noMatch: 'Esta credencial não está associada a este app ou site.',
  expired: 'O pedido de preenchimento expirou. Volte ao app e toque no Custódia de novo.',
  notFound: 'Credencial não encontrada.',
  reauth: 'Esta pasta exige confirmar sua identidade. Ative o desbloqueio biométrico em Ajustes para preencher.',
  phishing: (similar: string) => `Este site parece falso (parecido com ${similar}). O preenchimento foi bloqueado.`,
};

export class AutofillError extends Error {
  constructor(message: string, readonly code: 'locked' | 'disabled' | 'inactive' | 'policy' | 'phishing' | 'nomatch' | 'nourl' | 'expired' | 'notfound' | 'reauth') {
    super(message);
  }
}

const PACKAGE_RE = /^[a-zA-Z]\w*(\.\w+)+$/;
const ID_RE = /^[\w-]{1,64}$/;
const KINDS: AutofillKind[] = ['login', 'card', 'address', 'identity'];

export const isBrowserPackage = (pkg: string) => BROWSER_PACKAGES.includes(pkg.toLowerCase());

/** Pacote Android válido digitado pelo usuário. Navegadores não podem ser associados a uma credencial. */
export function normalizeAndroidPackage(entry: string): string {
  const pkg = entry.trim().toLowerCase();
  if (!pkg || pkg.length > 255 || !PACKAGE_RE.test(pkg) || isBrowserPackage(pkg)) return '';
  return pkg;
}

const isId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v);
const isPackage = (v: unknown): v is string => typeof v === 'string' && v.length <= 255 && PACKAGE_RE.test(v);
const isOptionalText = (v: unknown, max: number) => v == null || (typeof v === 'string' && v.length <= max);
const isFresh = (at: unknown, now: number) => typeof at === 'number' && now - at <= AUTOFILL_REQUEST_MAX_AGE_MS && at - now <= 60_000;

/** Valida um pedido vindo do serviço nativo (entrada externa: o texto da barra de endereço vem de outro app). */
export function validateRequest(raw: any, now = Date.now()): AutofillRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const { id, kind, packageName, url, credentialId, createdAt, newPassword } = raw;
  const valid =
    isId(id) && KINDS.includes(kind) && isPackage(packageName) && isOptionalText(url, 2048) && (credentialId == null || isId(credentialId)) && isFresh(createdAt, now);
  if (!valid) return null;
  const cleanUrl = typeof url === 'string' ? url.trim().replace(/\s+/g, '') : '';
  return {
    id,
    kind,
    packageName: packageName.toLowerCase(),
    url: cleanUrl ? withScheme(cleanUrl) : null,
    credentialId: credentialId || null,
    newPassword: !!newPassword,
    createdAt,
  };
}

/** A barra do Chrome mostra "site.com/caminho" sem o protocolo nas páginas seguras: completa com https. */
function withScheme(url: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
}

/** Alvo usado na correspondência: num navegador vale só a URL; num app, só o pacote. */
export function targetOf(req: Pick<AutofillRequest, 'packageName' | 'url'>): FillTarget {
  return isBrowserPackage(req.packageName) ? { url: req.url } : { packageName: req.packageName, url: req.url };
}

/** Onde o preenchimento acontece, em texto para a interface. */
export function describeTarget(req: Pick<AutofillRequest, 'packageName' | 'url'>): string {
  const host = hostnameOf(req.url || '');
  return host ? host : req.packageName;
}

/** Domínios já salvos no cofre: um endereço parecido com um deles é suspeito (anti-phishing personalizado). */
export function trustedDomains(creds: Credential[]): string[] {
  const out: string[] = [];
  for (const c of creds) {
    const h = hostnameOf(c.url);
    if (isValidHost(h)) out.push(h);
    for (const a of c.associatedDomains) out.push(a.replace(/^\*\./, ''));
  }
  return out;
}

export interface Candidate {
  cred: Credential;
  match: MatchKind;
  /** Motivo pelo qual a credencial aparece desabilitada (regra da pasta). */
  blockedReason?: string;
}

export interface FillCheck {
  match: MatchKind | null;
  /** Aviso não bloqueante (ex.: conexão sem HTTPS). */
  warning?: string;
}

async function loadVault(): Promise<{ creds: Credential[]; folders: Folder[] }> {
  return { creds: await Repo.credentials(), folders: await Repo.folders() };
}

function assertUsable(req: AutofillRequest | null): asserts req is AutofillRequest {
  if (!Vault.isUnlocked) throw new AutofillError(MSG.locked, 'locked');
  if (!Vault.settings.autofillEnabled) throw new AutofillError(MSG.disabled, 'disabled');
  if (!req || Date.now() - req.createdAt > AUTOFILL_REQUEST_MAX_AGE_MS) throw new AutofillError(MSG.expired, 'expired');
  if (isBrowserPackage(req.packageName) && !req.url) throw new AutofillError(MSG.noUrl, 'nourl');
}

/** Anti-phishing do endereço (vale para login e formulários). Devolve o aviso não bloqueante, se houver. */
function assertNotPhishing(req: AutofillRequest, creds: Credential[]): string | undefined {
  if (!req.url || !Vault.settings.autofillVerifyUrl) return undefined;
  const verdict = analyzeDomain(req.url, trustedDomains(creds));
  if (verdict.level === 'danger') throw new AutofillError(MSG.phishing(verdict.similarTo || verdict.domain), 'phishing');
  return verdict.level === 'warning' ? verdict.reasons.join('. ') : undefined;
}

/** Confirmação de identidade exigida pela regra da pasta (`requireReauth`): biometria, mesmo com o cofre aberto. */
export async function confirmIdentity(): Promise<void> {
  const profile = Vault.currentProfile;
  if (!profile || !Vault.isUnlocked) throw new AutofillError(MSG.locked, 'locked');
  if (!Vault.settings.biometricEnabled) throw new AutofillError(MSG.reauth, 'reauth');
  wipe(await Vault.verifyBiometric(profile.id));
}

/**
 * Sugestões do índice para a tela em foco, a mesma regra do Kotlin (`AutofillState.matches`), usada só para o
 * texto do balão. A decisão de preencher é sempre refeita no app, com `AutofillService.check`.
 */
export function indexMatches(index: AutofillIndexEntry[], req: Pick<AutofillRequest, 'packageName' | 'url'>): AutofillIndexEntry[] {
  const browser = isBrowserPackage(req.packageName);
  const host = hostnameOf(req.url || '');
  const pkg = req.packageName.toLowerCase();
  return index.filter(e => {
    if (!browser && e.packages.includes(pkg)) return true;
    if (!host) return false;
    if (e.hosts.some(h => isSameOrSubdomain(host, h))) return true;
    return e.associated.some(a => (a.startsWith('*.') ? isSameOrSubdomain(host, a.slice(2)) : host === a));
  });
}

export const BUBBLE = {
  fill: 'Preencher com Custódia',
  locked: 'Preencher com Custódia (desbloquear)',
  search: 'Nenhuma credencial salva · Buscar no cofre',
};

/** Texto do balão: cofre bloqueado pede desbloqueio; sem sugestão, oferece buscar no cofre (cenário BDD). */
export function bubbleLabel(unlocked: boolean, matches: number, formKinds: number): string {
  if (!unlocked) return BUBBLE.locked;
  return matches > 0 || formKinds > 0 ? BUBBLE.fill : BUBBLE.search;
}

let current: AutofillRequest | null = null;

export const AutofillService = {
  // ---------------------------------------------------------------------------
  // Pedido vindo do serviço
  // ---------------------------------------------------------------------------
  get currentRequest(): AutofillRequest | null {
    if (current && Date.now() - current.createdAt > AUTOFILL_REQUEST_MAX_AGE_MS) current = null;
    return current;
  },

  /** Busca no módulo nativo o pedido aberto (balão tocado em outro app) e avisa a interface. */
  async checkPendingRequest(): Promise<AutofillRequest | null> {
    const raw = await Autofill.takeRequest();
    if (!raw) return this.currentRequest;
    const req = validateRequest(raw);
    if (!req) return this.currentRequest;
    current = req;
    bus.emit(AUTOFILL_REQUEST_EVENT, req);
    return req;
  },

  /** Apenas para testes e para a tela: define o pedido atual. */
  setCurrentRequest(req: AutofillRequest | null) {
    current = req;
  },

  async dismiss(req: AutofillRequest | null = current) {
    if (req) await Autofill.cancel(req.id).catch(() => {});
    if (current && req && current.id === req.id) current = null;
  },

  // ---------------------------------------------------------------------------
  // Escolha da credencial
  // ---------------------------------------------------------------------------
  /** Credenciais sugeridas para o pedido, da melhor correspondência para a pior (inativas ficam de fora). */
  async candidates(req: Pick<AutofillRequest, 'packageName' | 'url'>): Promise<Candidate[]> {
    if (isBrowserPackage(req.packageName) && !req.url) return [];
    const { creds, folders } = await loadVault();
    return credentialsFor(creds, targetOf(req)).map(({ cred, match }) => ({
      cred,
      match,
      blockedReason: PolicyService.forCredential(folders, cred).blockAutofill ? MSG.blockedFolder : undefined,
    }));
  },

  /**
   * Visão da tela de escolha: sugestões e, quando o pedido não pode ser atendido (site falso, endereço ilegível,
   * preenchimento desligado), o motivo, mostrado antes de o usuário escolher qualquer credencial.
   */
  async preview(req: AutofillRequest | null): Promise<{ candidates: Candidate[]; blocked?: string; warning?: string }> {
    try {
      assertUsable(req);
      const warning = assertNotPhishing(req, await Repo.credentials());
      return { candidates: req.kind === 'login' ? await this.candidates(req) : [], warning };
    } catch (e: any) {
      if (e instanceof AutofillError) return { candidates: [], blocked: e.message };
      throw e;
    }
  },

  /** Todas as verificações antes de preencher. Lança `AutofillError` com a mensagem para o usuário. */
  async check(req: AutofillRequest | null, cred: Credential | null): Promise<FillCheck> {
    assertUsable(req);
    if (!cred) throw new AutofillError(MSG.notFound, 'notfound');
    const { creds, folders } = await loadVault();
    if (cred.inactive) throw new AutofillError(MSG.inactive, 'inactive');
    if (PolicyService.forCredential(folders, cred).blockAutofill) throw new AutofillError(MSG.blockedFolder, 'policy');
    const warning = assertNotPhishing(req, creds);
    const target = targetOf(req);
    const { match, allowed, verdict } = verifyBeforeFill(cred, target, trustedDomains(creds));
    if (!match) throw new AutofillError(MSG.noMatch, 'nomatch');
    // Verificação de URL desligada nos Ajustes: vale só a correspondência
    if (!allowed && Vault.settings.autofillVerifyUrl && verdict) throw new AutofillError(MSG.phishing(verdict.similarTo || verdict.domain), 'phishing');
    return { match, warning };
  },

  /** Associa o app/site do pedido à credencial, quando o usuário escolhe uma credencial de fora da lista. */
  async associate(req: AutofillRequest, credId: string): Promise<Credential> {
    const cred = await Repo.credential(credId);
    if (!cred) throw new AutofillError(MSG.notFound, 'notfound');
    if (req.url && isBrowserPackage(req.packageName)) {
      const host = normalizeAssociated(hostnameOf(req.url));
      if (!host) throw new AutofillError(MSG.noUrl, 'nourl');
      // Antes de associar, o endereço passa pelo anti-phishing: associar um site falso faria o golpe "corresponder"
      assertNotPhishing(req, await Repo.credentials());
      if (cred.associatedDomains.includes(host)) return cred;
      return Repo.saveCredential({ ...cred, associatedDomains: [...cred.associatedDomains, host] });
    }
    const pkg = normalizeAndroidPackage(req.packageName);
    if (!pkg) throw new AutofillError(MSG.noMatch, 'nomatch');
    if (cred.androidPackages.includes(pkg)) return cred;
    return Repo.saveCredential({ ...cred, androidPackages: [...cred.androidPackages, pkg] });
  },

  /** Preenche o login escolhido: verifica, confirma a identidade se a pasta exigir, entrega e conta o uso. */
  async fillLogin(req: AutofillRequest | null, credId: string): Promise<FillCheck> {
    const cred = await Repo.credential(credId);
    const result = await this.check(req, cred);
    const folders = await Repo.folders();
    if (PolicyService.forCredential(folders, cred!).requireReauth) await confirmIdentity();
    // Revalida depois da biometria: o cofre pode ter sido bloqueado no meio
    assertUsable(req);
    const ok = await Autofill.deliver({ requestId: req.id, username: cred!.username, password: cred!.password }, AUTOFILL_DELIVERY_TTL_MS);
    if (!ok) throw new AutofillError(MSG.expired, 'expired');
    await Repo.recordUsage(cred!.id);
    current = null;
    await Autofill.returnToTarget().catch(() => {});
    return result;
  },

  /** Preenche um formulário (cartão, endereço ou identidade) com o mesmo fluxo seguro. */
  async fillForm(req: AutofillRequest | null, item: FormItem): Promise<FillCheck> {
    assertUsable(req);
    const warning = assertNotPhishing(req, await Repo.credentials());
    const fields = formFieldsFor(item);
    const ok = await Autofill.deliver({ requestId: req.id, fields }, AUTOFILL_DELIVERY_TTL_MS);
    if (!ok) throw new AutofillError(MSG.expired, 'expired');
    current = null;
    await Autofill.returnToTarget().catch(() => {});
    return { match: null, warning };
  },

  /** Itens de formulário do tipo pedido (coleção `forms`, cadastrada). */
  async formsFor(kind: AutofillKind): Promise<FormItem[]> {
    if (kind === 'login') return [];
    return (await vaultDb.all<FormItem>('forms')).filter(f => f.kind === kind);
  },

  // ---------------------------------------------------------------------------
  // Índice de sugestões (sem segredos)
  // ---------------------------------------------------------------------------
  async buildIndex(): Promise<AutofillIndexEntry[]> {
    const { creds, folders } = await loadVault();
    return creds
      .filter(c => !c.inactive && !PolicyService.forCredential(folders, c).blockAutofill)
      .map(c => ({
        id: c.id,
        title: c.title.slice(0, 60),
        hosts: [hostnameOf(c.url)].filter(isValidHost),
        associated: c.associatedDomains.map(normalizeAssociated).filter(Boolean),
        packages: c.androidPackages.map(normalizeAndroidPackage).filter(Boolean),
      }));
  },

  /** Mantém o serviço nativo em dia com o cofre e os ajustes. */
  async syncIndex(): Promise<void> {
    await Autofill.setEnabled(!!Vault.settings.autofillEnabled);
    if (Vault.isUnlocked && Vault.settings.autofillEnabled) {
      const index = await this.buildIndex();
      // O cofre pode ter bloqueado enquanto o índice era montado: não republica a lista de sites num cofre fechado
      if (Vault.isUnlocked) await Autofill.setIndex(index);
      else await Autofill.clearIndex();
    } else await Autofill.clearIndex();
  },

  async onLocked(): Promise<void> {
    current = null;
    await Autofill.clearIndex();
  },

  async isServiceEnabled(): Promise<boolean> {
    return Autofill.isServiceEnabled().catch(() => false);
  },

  async openSettings(): Promise<void> {
    await Autofill.openAccessibilitySettings();
  },

  async openAppInfo(): Promise<void> {
    await Autofill.openAppInfo();
  },

  // ---------------------------------------------------------------------------
  // Troca de senha detectada (requisito 36)
  // ---------------------------------------------------------------------------
  /** Converte os sinais do serviço em sugestões abertas no app (e um alerta), sem nunca receber a senha digitada. */
  async processPasswordChanges(): Promise<PasswordChangeSuggestion[]> {
    if (!Vault.isUnlocked) return [];
    const signals = (await Autofill.takePasswordChanges()).slice(0, 10);
    const created: PasswordChangeSuggestion[] = [];
    for (const s of signals) created.push(...(await suggestionsFor(s)));
    if (created.length) {
      const all = [...created, ...(await this.passwordChangeSuggestions())];
      const keyOf = (x: PasswordChangeSuggestion) => x.credentialId || `save:${x.url || x.packageName}`;
      const unique = all.filter((x, i) => all.findIndex(y => keyOf(y) === keyOf(x)) === i);
      await vaultDb.setKv(SUGGESTIONS_KEY, JSON.stringify(unique.slice(0, MAX_PASSWORD_CHANGE_SUGGESTIONS)));
      bus.emit(PASSWORD_CHANGE_EVENT);
    }
    return created;
  },

  async passwordChangeSuggestions(): Promise<PasswordChangeSuggestion[]> {
    if (!Vault.isUnlocked) return [];
    try {
      const list = JSON.parse((await vaultDb.getKv(SUGGESTIONS_KEY)) || '[]');
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  },

  async dismissPasswordChange(id: string): Promise<void> {
    const list = (await this.passwordChangeSuggestions()).filter(s => s.id !== id);
    await vaultDb.setKv(SUGGESTIONS_KEY, JSON.stringify(list));
    bus.emit(PASSWORD_CHANGE_EVENT);
  },
};

export interface PasswordChangeSuggestion {
  id: string;
  /** update: trocou a senha de uma credencial salva; save: login novo, ainda fora do cofre. */
  type: 'update' | 'save';
  credentialId: string | null;
  title: string;
  where: string;
  /** Site (navegador) ou pacote (app) onde aconteceu, para pré-preencher o cadastro. */
  url: string | null;
  packageName: string | null;
  at: string;
}

const SUGGESTIONS_KEY = 'autofill.passwordChanges';
export const PASSWORD_CHANGE_EVENT = 'autofillPasswordChange';
/** Texto do cenário BDD "Salvamento automático após novo login". */
export const SAVE_PROMPT = 'Deseja salvar esta senha no cofre?';

/** Sinal vindo do serviço nativo (entrada externa): pacote e URL validados, sem segredo nenhum. */
function signalTarget(s: PasswordChangeSignal): { packageName: string; url: string | null } | null {
  if (!s || typeof s.packageName !== 'string' || s.packageName.length > 255 || !PACKAGE_RE.test(s.packageName)) return null;
  const url = typeof s.url === 'string' && s.url.trim() && s.url.length <= 2048 ? withScheme(s.url.trim().replace(/\s+/g, '')) : null;
  const req = { packageName: s.packageName.toLowerCase(), url };
  if (isBrowserPackage(req.packageName) && !hostnameOf(url || '')) return null;
  return req;
}

async function suggestionsFor(s: PasswordChangeSignal): Promise<PasswordChangeSuggestion[]> {
  const req = signalTarget(s);
  if (!req) return [];
  const at = new Date(Number(s.at) || Date.now()).toISOString();
  const where = describeTarget(req);
  const matches = (await AutofillService.candidates(req)).slice(0, 3);
  const browser = isBrowserPackage(req.packageName);
  const base = { where, url: browser ? req.url : null, packageName: browser ? null : req.packageName, at };
  // Login num site/app sem credencial salva: oferece salvar (cenário BDD "Salvamento automático após novo login")
  if (!matches.length) return [{ id: uuid(), type: 'save', credentialId: null, title: SAVE_PROMPT, ...base }];
  // Login comum numa credencial já salva não é troca de senha
  if (s.kind === 'login') return [];
  const out: PasswordChangeSuggestion[] = [];
  for (const { cred } of matches) {
    out.push({ id: uuid(), type: 'update', credentialId: cred.id, title: `Senha alterada em ${cred.title}?`, ...base });
    await AlertService.raise({
      type: 'old',
      severity: 'info',
      title: `Senha alterada em ${cred.title}?`,
      message: `Você digitou uma nova senha em ${where}. Atualize a credencial no Custódia para não perder o acesso.`,
      ref: cred.id,
    });
  }
  return out;
}
