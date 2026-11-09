//, (preencher), (antes de preencher),: preenchimento automático,
// formulários, arrastar e sites associados. O serviço de acessibilidade (Kotlin) é simulado pelo fallback em
// memória de `src/native/integration.ts`; a árvore de nós da tela é simulada com objetos `ScreenNode`.
import { Vault } from '../services/VaultService';
import { bus, Events } from '../services/events';
import { Repo, newCredential, newFolder } from '../services/Repository';
import {
  AUTOFILL_REQUEST_MAX_AGE_MS,
  AutofillService,
  BUBBLE,
  MSG,
  SAVE_PROMPT,
  bubbleLabel,
  indexMatches,
  normalizeAndroidPackage,
  validateRequest,
} from '../services/AutofillService';
import { classifyField, formFieldsFor, MAX_SCAN_FIELDS, planFormFill, planLoginFill, scanScreen, ScreenNode } from '../services/AutofillFieldService';
import { DRAG_MSG, DragService } from '../services/DragService';
import { addAssociation, ASSOC_MSG, MAX_ASSOCIATIONS, prefillFromAutofill } from '../services/AssociationService';
import { AlertService } from '../services/AlertService';
import { IntegrationController } from '../services/IntegrationController';
import { __integrationMocks, AutofillRequest } from '../native/integration';
import { vaultDb } from '../db/Database';
import { Security } from '../native';
import { PaymentCard } from '../types/models';

jest.setTimeout(120000);

const MASTER = 'Cofre#Seguro2026';
const mem = __integrationMocks.autofill;
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

let seq = 0;
function request(partial: Partial<AutofillRequest>): AutofillRequest {
  return { id: `req-${++seq}`, kind: 'login', packageName: 'com.twitter.android', url: null, credentialId: null, newPassword: false, createdAt: Date.now(), ...partial };
}

async function unlock() {
  const p = (await Vault.getProfile())!;
  await Vault.completeUnlock(p.id, await Vault.verifyPassword(p.id, MASTER), 'password');
  // Sem o AppController, avisa que a verificação de integridade do desbloqueio terminou
  bus.emit(Events.INTEGRITY_CHECKED);
}

// Campos simulados (AccessibilityNodeInfo reduzido)
const edit = (f: Partial<ScreenNode>): ScreenNode => ({ editable: true, visible: true, ...f });
const screen = (...children: ScreenNode[]): ScreenNode => ({ children: [{ children }] });

let twitterId = '';
let paypalId = '';

beforeAll(async () => {
  await Vault.createVault({ masterPassword: MASTER });
  const twitter = await Repo.saveCredential(newCredential({ title: 'Twitter', username: 'lucas', password: 'Tw#Senha2026!', url: 'https://twitter.com', androidPackages: ['com.twitter.android'] }));
  twitterId = twitter.id;
  paypalId = (await Repo.saveCredential(newCredential({ title: 'PayPal', username: 'lucas@x.com', password: 'Pp#Senha2026!', url: 'https://www.paypal.com' }))).id;
});

describe('Detecção de campos na tela de outro app', () => {
  it('reconhece usuário e senha pela dica, pelo id da view e pelo autofillHints', () => {
    expect(classifyField({ hint: 'Nome de usuário' })).toBe('username');
    expect(classifyField({ viewId: 'com.app:id/loginEmail' })).toBe('email');
    expect(classifyField({ autofillHints: ['password'], isPassword: true })).toBe('password');
    expect(classifyField({ hint: 'Nova senha', isPassword: true })).toBe('new-password');
    expect(classifyField({ hint: 'Qualquer coisa', isPassword: true })).toBe('password');
  });

  it('reconhece cartão, validade, CVV, CEP, rua, cidade e CPF em português e inglês', () => {
    expect(classifyField({ hint: 'Número do cartão' })).toBe('cc-number');
    expect(classifyField({ viewId: 'shop:id/cardNumber' })).toBe('cc-number');
    expect(classifyField({ hint: 'Validade (MM/AA)' })).toBe('cc-exp');
    expect(classifyField({ hint: 'Mês de vencimento' })).toBe('cc-exp-month');
    expect(classifyField({ hint: 'CVV', isPassword: true })).toBe('cc-csc');
    expect(classifyField({ hint: 'CEP' })).toBe('postal-code');
    expect(classifyField({ contentDescription: 'Street address' })).toBe('street-address');
    expect(classifyField({ hint: 'Cidade' })).toBe('address-level2');
    expect(classifyField({ hint: 'CPF' })).toBe('cpf');
    expect(classifyField({ autofillHints: ['postalCode'] })).toBe('postal-code');
  });

  it('um campo mascarado nunca vira campo de formulário comum (não vaza dado no lugar errado)', () => {
    expect(classifyField({ hint: 'CEP', isPassword: true })).toBe('password');
    expect(classifyField({ autofillHints: ['creditCardNumber'], isPassword: true })).toBe('password');
  });

  it('ignora texto enorme vindo do outro app (limite de 200 caracteres) e o texto digitado em campo de senha', () => {
    expect(classifyField({ hint: `${'x'.repeat(300)} cvv` })).toBeNull();
    expect(classifyField({ text: 'cpf', isPassword: true })).toBe('password');
  });

  it('varre a árvore de nós: tela de login do Twitter', () => {
    const scan = scanScreen(screen({ text: 'Entrar no Twitter' }, edit({ hint: 'Celular, e-mail ou nome de usuário' }), edit({ hint: 'Senha', isPassword: true }), edit({ visible: false, hint: 'escondido' })));
    expect(scan.hasLogin).toBe(true);
    expect(scan.newPassword).toBe(false);
    expect(scan.fields).toHaveLength(2);
    expect(planLoginFill(scan, 'lucas', 'segredo')).toEqual([
      { index: 1, value: 'segredo' },
      { index: 0, value: 'lucas' },
    ]);
  });

  it('detecta tela de troca de senha e preenche só a senha atual no login', () => {
    const scan = scanScreen(screen(edit({ hint: 'Senha atual', isPassword: true }), edit({ hint: 'Nova senha', isPassword: true }), edit({ hint: 'Confirme a nova senha', isPassword: true })));
    expect(scan.newPassword).toBe(true);
    expect(planLoginFill(scan, '', 'velha')).toEqual([{ index: 0, value: 'velha' }]);
  });

  it('login em duas etapas: sem campo de senha, o usuário vai no campo reconhecido', () => {
    const scan = scanScreen(screen(edit({ hint: 'Pesquisar' }), edit({ hint: 'E-mail' })));
    expect(planLoginFill(scan, 'lucas@x.com', 'p')).toEqual([{ index: 1, value: 'lucas@x.com' }]);
  });

  it('formulário de cartão: tipo detectado e validade única vira MM/AA; o CVV vai no campo mascarado', () => {
    const scan = scanScreen(screen(edit({ hint: 'Número do cartão' }), edit({ hint: 'Nome impresso no cartão' }), edit({ hint: 'Validade' }), edit({ hint: 'CVV', isPassword: true })));
    expect(scan.formKinds).toEqual(['card']);
    const card: PaymentCard = { id: 'c1', kind: 'card', label: 'Nubank', holder: 'LUCAS M', number: '5162 9200 0000 1234', expMonth: '7', expYear: '2029', cvv: '123', brand: 'mastercard', createdAt: '', updatedAt: '' };
    const plan = planFormFill(scan, formFieldsFor(card));
    expect(plan).toEqual([
      { index: 0, value: '5162920000001234' },
      { index: 1, value: 'LUCAS M' },
      { index: 2, value: '07/29' },
      { index: 3, value: '123' },
    ]);
  });

  it('formulário de endereço e de identidade', () => {
    const address = scanScreen(screen(edit({ hint: 'CEP' }), edit({ hint: 'Rua' }), edit({ hint: 'Cidade' }), edit({ hint: 'Estado' })));
    expect(address.formKinds).toEqual(['address']);
    const identity = scanScreen(screen(edit({ hint: 'Nome completo' }), edit({ hint: 'E-mail' }), edit({ hint: 'CPF' })));
    expect(identity.formKinds).toEqual(['identity']);
    // Senha comum em tela com nome/e-mail é cadastro de login, não identidade
    expect(scanScreen(screen(edit({ hint: 'Nome' }), edit({ hint: 'E-mail' }), edit({ hint: 'Senha', isPassword: true }))).formKinds).toEqual([]);
  });

  it(`limita a varredura a ${MAX_SCAN_FIELDS} campos e 40 níveis (tela hostil ou gigante)`, () => {
    const many = screen(...Array.from({ length: 500 }, () => edit({ hint: 'x' })));
    expect(scanScreen(many).fields).toHaveLength(MAX_SCAN_FIELDS);
    let deep: ScreenNode = edit({ hint: 'Senha', isPassword: true });
    for (let i = 0; i < 100; i++) deep = { children: [deep] };
    expect(scanScreen(deep).hasLogin).toBe(false);
  });
});

describe('Pedido vindo do serviço (entrada externa)', () => {
  it('aceita um pedido válido e completa https na URL da barra do Chrome', () => {
    const r = validateRequest({ ...request({ packageName: 'com.android.chrome', url: 'paypal.com/signin' }) });
    expect(r?.url).toBe('https://paypal.com/signin');
  });

  it('recusa pacote inválido, tipo desconhecido, URL gigante e pedido vencido ou do futuro', () => {
    expect(validateRequest({ ...request({}), packageName: '../../etc' })).toBeNull();
    expect(validateRequest({ ...request({}), kind: 'shell' })).toBeNull();
    expect(validateRequest({ ...request({}), url: `https://a.com/${'x'.repeat(3000)}` })).toBeNull();
    expect(validateRequest({ ...request({}), createdAt: Date.now() - AUTOFILL_REQUEST_MAX_AGE_MS - 1000 })).toBeNull();
    expect(validateRequest({ ...request({}), createdAt: Date.now() + 5 * 60_000 })).toBeNull();
    expect(validateRequest(null)).toBeNull();
  });
});

describe('Cenário: Preenchimento com sucesso em aplicativo compatível', () => {
  it('Dado o Custódia como serviço de preenchimento, Quando abro o login do "Twitter", Então ele sugere a credencial e ao tocar e autenticar os campos são preenchidos', async () => {
    // O balão aparece com o cofre bloqueado e pede desbloqueio
    await Vault.lock('teste');
    expect(bubbleLabel(false, 0, 0)).toBe(BUBBLE.locked);
    mem.requests.push(request({ packageName: 'com.twitter.android' }));
    IntegrationController.init();
    const pending = await AutofillService.checkPendingRequest();
    expect(pending?.packageName).toBe('com.twitter.android');
    expect((await AutofillService.preview(pending)).blocked).toBe(MSG.locked);
    // Desbloqueio (no app: biometria ou senha) → a credencial é sugerida
    await unlock();
    await tick(400);
    expect(mem.index.map(e => e.title)).toContain('Twitter');
    expect(JSON.stringify(mem.index)).not.toContain('Tw#Senha2026!');
    expect(indexMatches(mem.index, pending!).map(e => e.id)).toEqual([twitterId]);
    const preview = await AutofillService.preview(pending);
    expect(preview.candidates.map(c => c.cred.title)).toEqual(['Twitter']);
    expect(preview.candidates[0].match).toBe('package');
    await AutofillService.fillLogin(pending, twitterId);
    expect(mem.delivered).toMatchObject({ requestId: pending!.id, username: 'lucas', password: 'Tw#Senha2026!' });
    expect(mem.returned).toBeGreaterThan(0);
    expect((await Repo.credential(twitterId))!.usageCount).toBe(1);
    expect(AutofillService.currentRequest).toBeNull();
  });
});

describe('Cenário: Nenhuma credencial encontrada para o aplicativo', () => {
  it('Dado um app sem senha salva, Então não sugere preenchimento, Mas oferece buscar no cofre', async () => {
    const req = request({ packageName: 'com.app.desconhecido' });
    expect((await AutofillService.preview(req)).candidates).toEqual([]);
    expect(bubbleLabel(true, indexMatches(mem.index, req).length, 0)).toBe(BUBBLE.search);
    // Escolher uma credencial pela busca associa o app a ela e então preenche
    await AutofillService.associate(req, paypalId);
    expect((await Repo.credential(paypalId))!.androidPackages).toContain('com.app.desconhecido');
    expect((await AutofillService.preview(req)).candidates.map(c => c.cred.id)).toEqual([paypalId]);
  });
});

describe('Verificações antes de preencher', () => {
  it('bloqueia site parecido com um salvo (phishing) no navegador', async () => {
    const req = request({ packageName: 'com.android.chrome', url: 'https://www.paypa1.com/signin' });
    expect((await AutofillService.preview(req)).blocked).toMatch(/parece falso/);
    await expect(AutofillService.fillLogin(req, paypalId)).rejects.toMatchObject({ code: 'phishing' });
    await expect(AutofillService.associate(req, paypalId)).rejects.toMatchObject({ code: 'phishing' });
  });

  it('no navegador vale a URL, nunca o pacote; sem URL legível o preenchimento é bloqueado', async () => {
    const noUrl = request({ packageName: 'org.mozilla.firefox', url: null });
    expect((await AutofillService.preview(noUrl)).blocked).toBe(MSG.noUrl);
    const ok = request({ packageName: 'org.mozilla.firefox', url: 'https://paypal.com/login' });
    expect((await AutofillService.preview(ok)).candidates.map(c => c.cred.title)).toEqual(['PayPal']);
    expect(normalizeAndroidPackage('com.android.chrome')).toBe('');
  });

  it('HTTP sem cadeado gera aviso, mas não bloqueia', async () => {
    const req = request({ packageName: 'com.android.chrome', url: 'http://twitter.com/login' });
    const r = await AutofillService.fillLogin(req, twitterId);
    expect(r.warning).toMatch(/HTTP/);
  });

  it('credencial de outro site, inativa (vencida) ou de pasta "não preencher" é recusada', async () => {
    const req = () => request({ packageName: 'com.android.chrome', url: 'https://twitter.com' });
    await expect(AutofillService.fillLogin(req(), paypalId)).rejects.toMatchObject({ code: 'nomatch' });
    const old = await Repo.saveCredential(newCredential({ title: 'Velha', username: 'v', password: 'v', url: 'https://twitter.com', inactive: true }));
    await expect(AutofillService.fillLogin(req(), old.id)).rejects.toThrow(MSG.inactive);
    const folder = newFolder('Trabalho');
    folder.policy = { blockAutofill: true } as any;
    await Repo.saveFolder(folder);
    const blocked = await Repo.saveCredential(newCredential({ title: 'Twitter trabalho', username: 't', password: 't', url: 'https://twitter.com', folderId: folder.id }));
    await expect(AutofillService.fillLogin(req(), blocked.id)).rejects.toThrow(MSG.blockedFolder);
    const preview = await AutofillService.preview(req());
    expect(preview.candidates.find(c => c.cred.id === blocked.id)?.blockedReason).toBe(MSG.blockedFolder);
    expect(preview.candidates.find(c => c.cred.id === old.id)).toBeUndefined();
    const index = await AutofillService.buildIndex();
    expect(index.map(e => e.id)).not.toContain(blocked.id);
    expect(index.map(e => e.id)).not.toContain(old.id);
  });

  it('pasta que exige reautenticação pede biometria antes de preencher', async () => {
    const folder = newFolder('Reautenticar');
    folder.policy = { requireReauth: true } as any;
    await Repo.saveFolder(folder);
    const cred = await Repo.saveCredential(newCredential({ title: 'Banco', username: 'b', password: 'Bb#2026!x', url: 'https://banco.com.br', folderId: folder.id }));
    const req = () => request({ packageName: 'com.android.chrome', url: 'https://banco.com.br' });
    await expect(AutofillService.fillLogin(req(), cred.id)).rejects.toThrow(MSG.reauth);
    const avail = jest.spyOn(Security, 'biometricAvailable').mockResolvedValue({ available: true });
    await Vault.enableBiometric();
    avail.mockRestore();
    await AutofillService.fillLogin(req(), cred.id);
    expect(mem.delivered?.password).toBe('Bb#2026!x');
    await Vault.disableBiometric();
  });

  it('preenchimento desligado nos Ajustes bloqueia e esvazia o índice', async () => {
    await Vault.updateSettings({ autofillEnabled: false });
    await AutofillService.syncIndex();
    expect(mem.enabled).toBe(false);
    expect(mem.index).toEqual([]);
    await expect(AutofillService.fillLogin(request({}), twitterId)).rejects.toThrow(MSG.disabled);
    await Vault.updateSettings({ autofillEnabled: true });
    await AutofillService.syncIndex();
    expect(mem.index.length).toBeGreaterThan(0);
  });

  it('pedido vencido não preenche', async () => {
    const req = request({ createdAt: Date.now() - AUTOFILL_REQUEST_MAX_AGE_MS - 1 });
    await expect(AutofillService.fillLogin(req, twitterId)).rejects.toThrow(MSG.expired);
  });
});

describe('Formulários em outros apps', () => {
  it('lê cartões da coleção "forms" e entrega só os campos do item escolhido', async () => {
    const card: PaymentCard = { id: 'card-1', kind: 'card', label: 'Visa', holder: 'LUCAS', number: '4111 1111 1111 1111', expMonth: '12', expYear: '2030', cvv: '999', brand: 'visa', createdAt: '', updatedAt: '' };
    await vaultDb.put('forms', card);
    const req = request({ kind: 'card', packageName: 'com.loja.app' });
    const forms = await AutofillService.formsFor('card');
    expect(forms.map(f => f.id)).toEqual(['card-1']);
    await AutofillService.fillForm(req, forms[0]);
    expect(mem.delivered?.fields).toContainEqual({ key: 'cc-number', value: '4111111111111111' });
    expect(mem.delivered?.username).toBeUndefined();
    expect(await AutofillService.formsFor('login')).toEqual([]);
  });
});

describe('Cenário: Salvamento automático após novo login (e troca de senha)', () => {
  it('Quando faço login num site novo pelo navegador, Então o Custódia pergunta "Deseja salvar esta senha no cofre?"', async () => {
    mem.changes.push({ kind: 'login', packageName: 'com.android.chrome', url: 'novosite.com.br/entrar', at: Date.now() });
    const created = await AutofillService.processPasswordChanges();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ type: 'save', title: SAVE_PROMPT, url: 'https://novosite.com.br/entrar' });
    expect(prefillFromAutofill({ prefillUrl: created[0].url })).toMatchObject({ url: 'https://novosite.com.br', title: 'novosite.com.br' });
  });

  it('troca de senha numa credencial salva oferece atualizar e gera alerta; login comum não', async () => {
    mem.changes.push({ kind: 'login', packageName: 'com.twitter.android', url: null, at: Date.now() });
    expect(await AutofillService.processPasswordChanges()).toEqual([]);
    mem.changes.push({ kind: 'change', packageName: 'com.twitter.android', url: null, at: Date.now() });
    mem.changes.push({ kind: 'change', packageName: 'com.twitter.android', url: null, at: Date.now() });
    const created = await AutofillService.processPasswordChanges();
    expect(created[0]).toMatchObject({ type: 'update', credentialId: twitterId });
    const all = await AutofillService.passwordChangeSuggestions();
    expect(all.filter(s => s.credentialId === twitterId)).toHaveLength(1);
    expect((await AlertService.list()).some(a => a.title === 'Senha alterada em Twitter?')).toBe(true);
    await AutofillService.dismissPasswordChange(all[0].id);
    expect((await AutofillService.passwordChangeSuggestions()).length).toBe(all.length - 1);
  });

  it('ignora sinais inválidos vindos do serviço', async () => {
    mem.changes.push({ packageName: 'não é pacote', url: null, at: 0 } as any, { packageName: 'com.android.chrome', url: null, at: 0 } as any);
    expect(await AutofillService.processPasswordChanges()).toEqual([]);
  });
});

describe('Sites e apps associados', () => {
  const empty = { associatedDomains: [] as string[], androidPackages: [] as string[] };

  it('valida e normaliza domínios e pacotes', () => {
    expect(addAssociation(empty, 'site', 'https://Portal.Empresa.com/x').next?.associatedDomains).toEqual(['portal.empresa.com']);
    expect(addAssociation(empty, 'site', '*.empresa.com').next?.associatedDomains).toEqual(['*.empresa.com']);
    expect(addAssociation(empty, 'site', 'sem ponto').error).toBe(ASSOC_MSG.badSite);
    expect(addAssociation(empty, 'app', 'br.com.banco.app').next?.androidPackages).toEqual(['br.com.banco.app']);
    expect(addAssociation(empty, 'app', 'com.android.chrome').error).toBe(ASSOC_MSG.badApp);
    expect(addAssociation(empty, 'app', 'pacote inválido').error).toBe(ASSOC_MSG.badApp);
    expect(addAssociation({ ...empty, associatedDomains: ['a.com'] }, 'site', 'A.com').error).toBe(ASSOC_MSG.duplicate);
    const full = { ...empty, androidPackages: Array.from({ length: MAX_ASSOCIATIONS }, (_, i) => `com.app.n${i}`) };
    expect(addAssociation(full, 'app', 'com.app.extra').error).toBe(ASSOC_MSG.tooMany);
  });

  it('o domínio associado com "*." vale para todos os subdomínios no preenchimento', async () => {
    const cred = await Repo.saveCredential(newCredential({ title: 'Intranet', username: 'i', password: 'i', url: 'https://mail.empresa.com', associatedDomains: ['*.empresa.com'] }));
    const req = request({ packageName: 'com.android.chrome', url: 'https://rh.empresa.com/login' });
    const c = (await AutofillService.preview(req)).candidates.find(x => x.cred.id === cred.id);
    expect(c?.match).toBe('associated');
    expect(indexMatches(await AutofillService.buildIndex(), req).map(e => e.id)).toContain(cred.id);
  });

  it('parâmetros de pré-preenchimento são validados (não aceitam pacote de navegador nem URL inválida)', () => {
    expect(prefillFromAutofill({ prefillPackage: 'com.android.chrome' })).toEqual({});
    expect(prefillFromAutofill({ prefillUrl: ['javascript', 'alert(1)'].join(':') })).toEqual({});
    expect(prefillFromAutofill({ prefillPackage: 'br.com.app' })).toMatchObject({ androidPackages: ['br.com.app'] });
  });
});

describe('Arrastar para outro app em tela dividida', () => {
  it('fora da tela dividida, explica como usar', async () => {
    const cred = (await Repo.credential(twitterId))!;
    __integrationMocks.drag.multiWindow = false;
    await expect(DragService.start(cred, 'password')).rejects.toThrow(DRAG_MSG.notMultiWindow);
  });

  it('em tela dividida, arrasta a senha marcada como sensível, sem área de transferência, e conta o uso', async () => {
    const cred = (await Repo.credential(twitterId))!;
    const before = cred.usageCount;
    __integrationMocks.drag.multiWindow = true;
    await DragService.start(cred, 'password');
    expect(__integrationMocks.drag.last).toEqual({ text: 'Tw#Senha2026!', label: 'Twitter — senha', sensitive: true });
    expect((await Repo.credential(twitterId))!.usageCount).toBe(before + 1);
    await DragService.start(cred, 'username');
    expect(__integrationMocks.drag.last?.sensitive).toBe(false);
  });

  it('respeita a pasta "não preencher", campo vazio e cofre bloqueado', async () => {
    const folder = newFolder('Sem arrastar');
    folder.policy = { blockAutofill: true } as any;
    await Repo.saveFolder(folder);
    const cred = await Repo.saveCredential(newCredential({ title: 'X', username: '', password: 'y', folderId: folder.id }));
    await expect(DragService.start(cred, 'password')).rejects.toThrow(DRAG_MSG.blocked);
    await expect(DragService.start(cred, 'username')).rejects.toThrow(DRAG_MSG.empty);
    await Vault.lock('teste');
    await expect(DragService.start(cred, 'password')).rejects.toThrow(DRAG_MSG.locked);
    // Bloquear apaga o índice e o pedido aberto no serviço
    await tick(50);
    expect(mem.index).toEqual([]);
    expect(AutofillService.currentRequest).toBeNull();
  });
});
