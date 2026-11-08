// Classificação de campos de outros apps para o preenchimento automático
//
// O serviço de acessibilidade (Kotlin, `FieldClassifier.kt`) usa exatamente estas regras, na mesma ordem, para
// reconhecer os campos da tela em foco. Esta é a versão de referência em TypeScript, testada no Jest
// (`autofill-campos.test.ts`); qualquer mudança aqui precisa ser repetida no Kotlin.
//
// Ordem de decisão para cada campo:
//  1. `autofillHints` do Android/HTML (o app declarou o que o campo é): mapeamento direto;
//  2. texto do campo (dica, id da view, descrição de acessibilidade e o texto visível curto), sem acentos,
//     comparado com as expressões abaixo, das mais específicas para as mais genéricas.
// Campo de senha (`isPassword`) só pode virar senha, nova senha ou código de segurança do cartão: nunca recebe
// um valor de formulário comum, para não vazar dado num campo mascarado errado.

import { FormItem } from '../types/models';
import { stripAccents } from '../utils';

/** Nomes padrão dos campos de formulário (os mesmos de `FormService.fieldsForAutofill`). */
export type FormFieldKey =
  | 'cc-number'
  | 'cc-name'
  | 'cc-exp-month'
  | 'cc-exp-year'
  | 'cc-exp'
  | 'cc-csc'
  | 'postal-code'
  | 'street-address'
  | 'address-level2'
  | 'address-level1'
  | 'name'
  | 'email'
  | 'tel'
  | 'cpf';

export type LoginFieldKey = 'username' | 'password' | 'new-password';
export type FieldKey = FormFieldKey | LoginFieldKey;

/** Nomes dos campos usados em mais de um lugar (evita repetir os literais). */
export const K = {
  ccNumber: 'cc-number',
  ccName: 'cc-name',
  ccExpMonth: 'cc-exp-month',
  ccExpYear: 'cc-exp-year',
  ccExp: 'cc-exp',
  ccCsc: 'cc-csc',
  postal: 'postal-code',
  street: 'street-address',
  city: 'address-level2',
  state: 'address-level1',
  newPassword: 'new-password',
} as const;

/** Par {campo, valor} que o app entrega ao serviço para preencher um formulário. */
export interface AutofillFormField {
  key: FormFieldKey;
  value: string;
}

/** O que o serviço sabe de um campo da tela (AccessibilityNodeInfo). */
export interface FieldDescriptor {
  autofillHints?: string[];
  hint?: string;
  viewId?: string;
  contentDescription?: string;
  text?: string;
  isPassword?: boolean;
}

/** `autofillHints` (View.AUTOFILL_HINT_*, androidx HintConstants e `autocomplete` do HTML), agrupados por campo. */
const HINT_GROUPS: [FieldKey, string[]][] = [
  ['username', ['username']],
  ['password', ['password', 'current-password']],
  [K.newPassword, ['newpassword', K.newPassword]],
  [K.ccNumber, ['creditcardnumber', K.ccNumber]],
  [K.ccName, [K.ccName, 'creditcardholdername']],
  [K.ccExpMonth, ['creditcardexpirationmonth', K.ccExpMonth]],
  [K.ccExpYear, ['creditcardexpirationyear', K.ccExpYear]],
  [K.ccExp, ['creditcardexpirationdate', K.ccExp]],
  [K.ccCsc, ['creditcardsecuritycode', K.ccCsc]],
  [K.postal, ['postalcode', K.postal, 'zipcode']],
  [K.street, ['postaladdress', 'streetaddress', K.street, 'address-line1']],
  [K.city, ['addresslocality', K.city]],
  [K.state, ['addressregion', K.state]],
  ['name', ['personname', 'name']],
  ['email', ['emailaddress', 'email']],
  ['tel', ['phone', 'phonenumber', 'tel']],
  ['cpf', ['cpf']],
];

const HINTS: Record<string, FieldKey> = Object.fromEntries(HINT_GROUPS.flatMap(([key, hints]) => hints.map(h => [h, key])));

/** Campos que podem ser de senha (mascarados). */
const SECRET_KEYS: FieldKey[] = ['password', K.newPassword, K.ccCsc];

/** Regras de texto, na ordem de prioridade. O texto já chega sem acentos, em minúsculas e com separadores trocados por espaço. */
const PASSWORD_RULES: [RegExp, FieldKey][] = [
  [/\b(cvv|cvc|csc|cod(igo)? (de )?seguranca|security code)\b/, K.ccCsc],
  [/\b(nova senha|new ?password|confirm(ar|e)? (a )?(nova )?senha|confirm(ation)? password|repita a senha|repeat password|retype)\b/, K.newPassword],
];

const TEXT_RULES: [RegExp, FieldKey][] = [
  [/\b(cvv|cvc|csc|cod(igo)? (de )?seguranca|security code)\b/, K.ccCsc],
  [/\b(numero do cartao|n do cartao|card ?number|cc ?number|cartao de credito|credit card)\b/, K.ccNumber],
  [/\b(nome (impresso|no cartao|do titular)|titular|holder|name on card|cardholder|cc name)\b/, K.ccName],
  // "Validade (MM/AA)" é a data inteira, não só o mês
  [/\bmm (aa|yy|aaaa|yyyy)\b/, K.ccExp],
  [/\b(mes|month)\b.*\b(validade|venc\w*|exp\w*)\b|\b(validade|venc\w*|exp\w*)\b.*\b(mes|month|mm)\b|\bcc exp month\b/, K.ccExpMonth],
  [/\b(ano|year)\b.*\b(validade|venc\w*|exp\w*)\b|\b(validade|venc\w*|exp\w*)\b.*\b(ano|year|aa|yy)\b|\bcc exp year\b/, K.ccExpYear],
  [/\b(validade|vencimento|expira\w*|expiry|expiration|exp date)\b|\bmm (aa|yy|aaaa|yyyy)\b/, K.ccExp],
  [/\bcpf\b/, 'cpf'],
  [/\b(cep|zip|postal|codigo postal)\b/, K.postal],
  [/\b(e ?mail)\b/, 'email'],
  [/\b(telefone|celular|phone|tel|whatsapp|mobile)\b/, 'tel'],
  [/\b(cidade|city|municipio|localidade)\b/, K.city],
  [/\b(estado|uf|state|province)\b/, K.state],
  [/\b(rua|logradouro|endereco|address|street|avenida)\b/, K.street],
  [/\b(usuario|user ?name|login|user|identifier|account)\b/, 'username'],
  [/\b(nome completo|nome|full name|name|seu nome)\b/, 'name'],
];

/** Tamanho máximo considerado do texto de um campo (evita regex em textos enormes vindos de outros apps). */
export const MAX_FIELD_TEXT = 200;

/** Texto normalizado para comparação: sem acentos, minúsculo e com `_ - . / :` virando espaço. */
export function normalizeFieldText(s: string): string {
  return stripAccents(String(s || '').slice(0, MAX_FIELD_TEXT))
    .toLowerCase()
    .replace(/[_\-./:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Junta o que descreve o campo. O texto digitado só entra se for curto e o campo não for de senha. */
export function describeField(f: FieldDescriptor): string {
  const id = (f.viewId || '').split(':id/').pop() || '';
  // "cardNumber" → "card Number": separa camelCase antes de baixar a caixa
  const parts = [f.hint, id.replace(/([a-z])([A-Z])/g, '$1 $2'), f.contentDescription];
  if (!f.isPassword && f.text && f.text.length < 40) parts.push(f.text);
  return normalizeFieldText(parts.filter(Boolean).join(' '));
}

/** Classifica um campo da tela. Devolve null quando não reconhece (o campo é deixado em branco). */
export function classifyField(f: FieldDescriptor): FieldKey | null {
  for (const h of f.autofillHints || []) {
    const key = HINTS[String(h).toLowerCase()];
    if (key && (!f.isPassword || SECRET_KEYS.includes(key))) return key;
  }
  const desc = describeField(f);
  if (f.isPassword) {
    for (const [re, key] of PASSWORD_RULES) if (re.test(desc)) return key;
    return 'password';
  }
  for (const [re, key] of TEXT_RULES) if (re.test(desc)) return key;
  return null;
}

/** Tipos de formulário presentes na tela, a partir dos campos reconhecidos. */
export function formKindsOf(keys: (FieldKey | null)[]): ('card' | 'address' | 'identity')[] {
  const set = new Set(keys.filter(Boolean) as FieldKey[]);
  const count = (list: FieldKey[]) => list.filter(k => set.has(k)).length;
  const out: ('card' | 'address' | 'identity')[] = [];
  if (set.has(K.ccNumber) || (set.has(K.ccCsc) && count([K.ccExp, K.ccExpMonth, K.ccName]) > 0)) out.push('card');
  if (count([K.postal, K.street, K.city, K.state]) >= 2) out.push('address');
  if (!set.has('password') && count(['name', 'email', 'tel', 'cpf']) >= 2) out.push('identity');
  return out;
}

/**
 * Pares {campo, valor} de um item de formulário.
 * Segue os mesmos nomes de `FormService.fieldsForAutofill(item)`.
 */
export function formFieldsFor(item: FormItem): AutofillFormField[] {
  const pairs: [FormFieldKey, string | undefined][] = [];
  if (item.kind === 'card') {
    pairs.push([K.ccNumber, item.number.replace(/\D/g, '')], [K.ccName, item.holder], [K.ccExpMonth, item.expMonth], [K.ccExpYear, item.expYear], [K.ccCsc, item.cvv]);
  } else if (item.kind === 'address') {
    const street = [item.street, item.number, item.complement].filter(Boolean).join(', ');
    pairs.push([K.postal, item.zipCode], [K.street, street], [K.city, item.city], [K.state, item.state], ['name', item.fullName], ['tel', item.phone]);
  } else {
    pairs.push(['name', item.fullName], ['email', item.email], ['tel', item.phone], ['cpf', item.cpf]);
  }
  return pairs.filter(([, v]) => !!v && String(v).trim()).map(([key, value]) => ({ key, value: String(value).trim() }));
}

// -----------------------------------------------------------------------------
// Varredura da tela e plano de preenchimento (espelhados em `ScreenScanner.kt`)
// -----------------------------------------------------------------------------

/** Nó da árvore de acessibilidade, reduzido ao que o serviço usa (AccessibilityNodeInfo). */
export interface ScreenNode extends FieldDescriptor {
  editable?: boolean;
  visible?: boolean;
  focused?: boolean;
  children?: ScreenNode[];
}

/** Limites da varredura: protegem contra telas enormes (ou hostis) que travariam o serviço. */
export const MAX_SCAN_DEPTH = 40;
export const MAX_SCAN_FIELDS = 60;

export interface ScannedField {
  node: ScreenNode;
  key: FieldKey | null;
}

export interface ScreenScan {
  fields: ScannedField[];
  /** Há campo de senha: tela de login (ou de troca de senha). */
  hasLogin: boolean;
  /** Há campo de "nova senha" (ou dois campos de senha): tela de troca/cadastro de senha. */
  newPassword: boolean;
  formKinds: ('card' | 'address' | 'identity')[];
}

/** Coleta os campos editáveis e visíveis, em ordem de leitura, e classifica cada um. */
export function scanScreen(root: ScreenNode | null): ScreenScan {
  const fields: ScannedField[] = [];
  const walk = (node: ScreenNode | undefined, depth: number) => {
    if (!node || depth > MAX_SCAN_DEPTH || fields.length >= MAX_SCAN_FIELDS) return;
    if (node.editable && node.visible !== false) fields.push({ node, key: classifyField(node) });
    for (const child of node.children || []) walk(child, depth + 1);
  };
  walk(root || undefined, 0);
  const passwords = fields.filter(f => f.node.isPassword);
  const keys = fields.map(f => f.key);
  return {
    fields,
    hasLogin: passwords.length > 0,
    newPassword: keys.includes(K.newPassword) || passwords.length >= 2,
    formKinds: formKindsOf(keys),
  };
}

/** Atribuição de um valor a um campo da tela (índice em `ScreenScan.fields`). */
export interface FillAction {
  index: number;
  value: string;
}

/**
 * Login: a senha vai no primeiro campo de senha que não é de "nova senha"; o usuário vai no último campo comum
 * antes dele (ou no campo reconhecido como usuário/e-mail). Sem campo de senha (login em duas etapas), o usuário vai
 * no campo reconhecido como usuário, ou no campo com foco.
 */
export function planLoginFill(scan: ScreenScan, username: string, password: string): FillAction[] {
  const out: FillAction[] = [];
  const pw = scan.fields.findIndex(f => f.node.isPassword && f.key !== K.newPassword && f.key !== K.ccCsc);
  if (pw >= 0 && password) out.push({ index: pw, value: password });
  const before = pw >= 0 ? scan.fields.slice(0, pw) : scan.fields;
  let user = -1;
  before.forEach((f, i) => {
    if (!f.node.isPassword && (f.key === 'username' || f.key === 'email')) user = i;
  });
  if (user < 0 && pw >= 0) {
    for (let i = pw - 1; i >= 0 && user < 0; i--) if (!scan.fields[i].node.isPassword) user = i;
  }
  if (user < 0 && pw < 0) user = scan.fields.findIndex(f => f.node.focused && !f.node.isPassword);
  if (user >= 0 && username) out.push({ index: user, value: username });
  return out;
}

/** Formulário: cada campo reconhecido recebe o valor do mesmo nome; validade única vira "MM/AA". */
export function planFormFill(scan: ScreenScan, values: AutofillFormField[]): FillAction[] {
  const byKey = new Map(values.map(v => [v.key, v.value]));
  const month = byKey.get(K.ccExpMonth);
  const year = byKey.get(K.ccExpYear);
  // Formulário de cartão com um campo "Nome" genérico: recebe o nome impresso
  if (!byKey.has('name') && byKey.get(K.ccName)) byKey.set('name', byKey.get(K.ccName)!);
  if (!byKey.has(K.ccExp) && month && year) byKey.set(K.ccExp, `${month.padStart(2, '0')}/${year.slice(-2)}`);
  const out: FillAction[] = [];
  const used = new Set<FieldKey>();
  scan.fields.forEach((f, index) => {
    if (!f.key || used.has(f.key)) return;
    // Campo mascarado só recebe o código de segurança do cartão
    if (f.node.isPassword && f.key !== K.ccCsc) return;
    const value = byKey.get(f.key as FormFieldKey);
    if (!value) return;
    used.add(f.key);
    out.push({ index, value });
  });
  return out;
}
