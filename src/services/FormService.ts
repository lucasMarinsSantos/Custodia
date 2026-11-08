// Formulários (, parte de dados): cartões, endereços e identidades
//  • Cartão: número validado por Luhn, bandeira detectada pelo BIN (inclui Elo e Hipercard), validade MM/AA e CVV.
//  • Endereço: CEP com 8 dígitos e consulta opcional ao ViaCEP (HTTPS, com timeout, sem quebrar offline).
//  • Identidade: CPF com dígito verificador, e-mail e telefone.
// `fieldsForAutofill` devolve os pares {campo, valor} padronizados (nomes do atributo HTML autocomplete) que o
// preenchimento automático em outros apps usa. Exclusão segura pelo VaultDatabase.

import { vaultDb } from '../db/Database';
import { uuid } from '../crypto';
import { Address, CardBrand, FormItem, FormKind, Identity, PaymentCard } from '../types/models';
import { ValidationError } from './Repository';
import { bus, Events } from './events';

// ---------------------------------------------------------------------------
// Limites e tabelas
// ---------------------------------------------------------------------------
export const FORM_LIMITS = { text: 120, long: 200, items: 500 };

export const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];

export const CardBrandLabels: Record<CardBrand, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  elo: 'Elo',
  amex: 'American Express',
  hipercard: 'Hipercard',
  diners: 'Diners Club',
  other: 'Cartão',
};

export const FormKindLabels: Record<FormKind, { one: string; many: string; empty: string }> = {
  card: { one: 'Cartão', many: 'Cartões', empty: 'Nenhum cartão salvo' },
  address: { one: 'Endereço', many: 'Endereços', empty: 'Nenhum endereço salvo' },
  identity: { one: 'Identidade', many: 'Identidades', empty: 'Nenhuma identidade salva' },
};

/** Faixas de BIN da Elo (6 dígitos), da tabela pública da bandeira. */
const ELO_RANGES: [number, number][] = [
  [401178, 401179], [431274, 431274], [438935, 438935], [451416, 451416], [457393, 457393], [457631, 457632],
  [504175, 504175], [506699, 506778], [509000, 509999], [627780, 627780], [636297, 636297], [636368, 636368],
  [650031, 650033], [650035, 650051], [650405, 650439], [650485, 650538], [650541, 650598], [650700, 650718],
  [650720, 650727], [650901, 650978], [651652, 651679], [655000, 655019], [655021, 655058],
];
const HIPERCARD_PREFIXES = ['606282', '384100', '384140', '384160', '637095', '637568', '637599', '637609', '637612'];

export const onlyDigits = (s: unknown) => (typeof s === 'string' || typeof s === 'number' ? String(s).replace(/\D/g, '') : '');

// ---------------------------------------------------------------------------
// Cartão
// ---------------------------------------------------------------------------
/** Algoritmo de Luhn (dígito verificador de cartões), com 13 a 19 dígitos. */
export function luhnValid(number: string): boolean {
  const d = onlyDigits(number);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/** Bandeira pelo BIN. Elo e Hipercard vêm antes porque parte dos BINs deles começa com 4, 5 ou 6. */
export function detectCardBrand(number: string): CardBrand {
  const d = onlyDigits(number);
  const bin6 = Number(d.slice(0, 6));
  if (d.length >= 6 && ELO_RANGES.some(([a, b]) => bin6 >= a && bin6 <= b)) return 'elo';
  if (HIPERCARD_PREFIXES.some(p => d.startsWith(p))) return 'hipercard';
  if (/^3[47]/.test(d)) return 'amex';
  if (/^3(0[0-5]|[689])/.test(d)) return 'diners';
  const bin4 = Number(d.slice(0, 4));
  if (/^5[1-5]/.test(d) || (d.length >= 4 && bin4 >= 2221 && bin4 <= 2720)) return 'mastercard';
  if (/^4/.test(d)) return 'visa';
  return 'other';
}

/** Agrupa os dígitos para exibição (Amex: 4-6-5; demais: blocos de 4). */
export function formatCardNumber(number: string): string {
  const d = onlyDigits(number).slice(0, 19);
  if (/^3[47]/.test(d)) return [d.slice(0, 4), d.slice(4, 10), d.slice(10, 15)].filter(Boolean).join(' ');
  return d.replace(/(\d{4})(?=\d)/g, '$1 ');
}

/** Só os 4 últimos dígitos aparecem fora da edição. */
export const maskCardNumber = (number: string) => `•••• ${onlyDigits(number).slice(-4)}`;

export const cvvLength = (brand: CardBrand) => (brand === 'amex' ? 4 : 3);

/** Validade MM/AA: mês 01–12 e não anterior ao mês atual. */
export function expiryError(month: string, year: string, now = new Date()): string | null {
  if (!/^\d{2}$/.test(month) || !/^\d{2}$/.test(year)) return 'Informe a validade no formato MM/AA';
  const m = Number(month);
  if (m < 1 || m > 12) return 'Mês da validade inválido';
  const y = 2000 + Number(year);
  if (y * 12 + m < now.getFullYear() * 12 + now.getMonth() + 1) return 'Cartão vencido';
  return null;
}

/** Converte "MMAA"/"MM/AA" digitado para os dois campos. */
export function splitExpiry(text: string): { expMonth: string; expYear: string } {
  const d = onlyDigits(text).slice(0, 4);
  return { expMonth: d.slice(0, 2), expYear: d.slice(2, 4) };
}

// ---------------------------------------------------------------------------
// CPF e CEP
// ---------------------------------------------------------------------------
export function cpfValid(cpf: string): boolean {
  const d = onlyDigits(cpf);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const check = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return check(9) === Number(d[9]) && check(10) === Number(d[10]);
}

export function formatCpf(cpf: string): string {
  const d = onlyDigits(cpf).slice(0, 11);
  return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
}

/** CPF parcialmente oculto para a lista: ***.456.789-** */
export const maskCpf = (cpf: string) => {
  const d = onlyDigits(cpf);
  return d.length === 11 ? `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**` : '';
};

/** CEP com 8 dígitos (aceita "01310-100" ou "01310100"). */
export const cepValid = (cep: string) => /^\d{5}-?\d{3}$/.test(String(cep ?? '').trim());

export function formatCep(cep: string): string {
  const d = onlyDigits(cep).slice(0, 8);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

// ---------------------------------------------------------------------------
// ViaCEP (opcional): HTTPS, timeout e resposta validada
// ---------------------------------------------------------------------------
export const VIACEP_TIMEOUT_MS = 6000;

export interface CepResult {
  street: string;
  neighborhood: string;
  city: string;
  state: string;
  complement: string;
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;
const cleanText = (v: unknown, max = FORM_LIMITS.long) => (typeof v === 'string' ? v.replace(CONTROL_RE, '').trim().slice(0, max) : '');

/**
 * Consulta o CEP no ViaCEP. Só é chamada quando o usuário toca em "Buscar CEP" (o CEP vai para um serviço externo).
 * Qualquer falha (sem internet, timeout, resposta inválida, CEP inexistente) devolve null: o cadastro continua manual.
 */
export async function lookupCep(cep: string, fetchImpl: typeof fetch = fetch, timeoutMs = VIACEP_TIMEOUT_MS): Promise<CepResult | null> {
  const digits = onlyDigits(cep);
  if (!cepValid(cep)) return null;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => {
      controller?.abort();
      resolve(null);
    }, timeoutMs);
  });
  const request = (async (): Promise<CepResult | null> => {
    const res = await fetchImpl(`https://viacep.com.br/ws/${digits}/json/`, { signal: controller?.signal, headers: { Accept: 'application/json' } } as any);
    if (!res || !res.ok) return null;
    const text = await res.text();
    if (text.length > 4096) return null; // resposta gigante não é do ViaCEP
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || body.erro) return null;
    const state = cleanText(body.uf, 2).toUpperCase();
    const city = cleanText(body.localidade);
    if (!UFS.includes(state) || !city) return null;
    return { street: cleanText(body.logradouro), neighborhood: cleanText(body.bairro), city, state, complement: cleanText(body.complemento) };
  })().catch(() => null);
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Validação por tipo (erros por campo, para a tela mostrar no próprio campo)
// ---------------------------------------------------------------------------
export type FormErrors = Partial<Record<string, string>>;

function tooLong(item: Record<string, unknown>, errors: FormErrors) {
  for (const [k, v] of Object.entries(item)) {
    if (typeof v === 'string' && v.length > FORM_LIMITS.long && !errors[k]) errors[k] = `Use até ${FORM_LIMITS.long} caracteres`;
  }
}

function validateCard(c: PaymentCard, now: Date): FormErrors {
  const e: FormErrors = {};
  if (!luhnValid(c.number)) e.number = 'Número de cartão inválido';
  if (!c.holder.trim()) e.holder = 'Informe o nome impresso no cartão';
  const exp = expiryError(c.expMonth, c.expYear, now);
  if (exp) e.expiry = exp;
  if (c.cvv && !new RegExp(`^\\d{${cvvLength(detectCardBrand(c.number))}}$`).test(c.cvv)) e.cvv = `O CVV tem ${cvvLength(detectCardBrand(c.number))} dígitos`;
  return e;
}

function validateAddress(a: Address): FormErrors {
  const e: FormErrors = {};
  if (!cepValid(a.zipCode)) e.zipCode = 'O CEP deve ter 8 dígitos';
  if (!a.street.trim()) e.street = 'Informe o logradouro';
  if (!a.city.trim()) e.city = 'Informe a cidade';
  if (!UFS.includes(a.state.trim().toUpperCase())) e.state = 'Estado inválido (use a sigla, ex.: SP)';
  if (a.phone && !/^\d{10,13}$/.test(onlyDigits(a.phone))) e.phone = 'Telefone inválido';
  return e;
}

/** Data de nascimento DD/MM/AAAA que existe no calendário, entre 1900 e hoje. */
export function birthDateValid(text: string, now = new Date()): boolean {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(text ?? '').trim());
  if (!m) return false;
  const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(year, month - 1, day);
  return year >= 1900 && d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day && d.getTime() <= now.getTime();
}

function validateIdentity(i: Identity): FormErrors {
  const e: FormErrors = {};
  if (!i.fullName.trim()) e.fullName = 'Informe o nome completo';
  if (i.cpf && !cpfValid(i.cpf)) e.cpf = 'CPF inválido';
  if (i.email && !EMAIL_RE.test(i.email.trim())) e.email = 'E-mail inválido';
  if (i.phone && !/^\d{10,13}$/.test(onlyDigits(i.phone))) e.phone = 'Telefone inválido';
  if (i.birthDate && !birthDateValid(i.birthDate)) e.birthDate = 'Data de nascimento inválida (use DD/MM/AAAA)';
  return e;
}

const t = (s: unknown) => (typeof s === 'string' ? s.trim() : '');
const meta = (item: FormItem) => ({ id: String(item.id || uuid()), label: t(item.label), createdAt: t(item.createdAt), updatedAt: t(item.updatedAt) });

/**
 * Normaliza para o formato gravado: só os campos conhecidos de cada tipo (um registro vindo de importação ou
 * sincronização não consegue guardar campos extras nem valores que não sejam texto), só dígitos onde faz sentido
 * e a bandeira recalculada pelo número (nunca a informada).
 */
function normalize(item: FormItem): FormItem {
  if (item.kind === 'card') {
    const number = onlyDigits(item.number).slice(0, 19);
    return { ...meta(item), kind: 'card', holder: t(item.holder).toUpperCase(), number, expMonth: onlyDigits(item.expMonth).slice(0, 2), expYear: onlyDigits(item.expYear).slice(0, 2), cvv: onlyDigits(item.cvv).slice(0, 4), brand: detectCardBrand(number) };
  }
  if (item.kind === 'address') {
    return {
      ...meta(item),
      kind: 'address',
      fullName: t(item.fullName),
      zipCode: formatCep(item.zipCode),
      street: t(item.street),
      number: t(item.number),
      complement: t(item.complement),
      neighborhood: t(item.neighborhood),
      city: t(item.city),
      state: t(item.state).toUpperCase(),
      country: t(item.country) || 'Brasil',
      phone: t(item.phone),
      reference: t(item.reference),
      isPrimary: item.isPrimary === true,
    };
  }
  return { ...meta(item), kind: 'identity', fullName: t(item.fullName), email: t(item.email).toLowerCase(), phone: t(item.phone), cpf: item.cpf ? formatCpf(item.cpf) : '', rg: t(item.rg), birthDate: t(item.birthDate), company: t(item.company) };
}

// ---------------------------------------------------------------------------
// Preenchimento automático
// ---------------------------------------------------------------------------
export type AutofillField =
  | 'cc-number'
  | 'cc-name'
  | 'cc-exp-month'
  | 'cc-exp-year'
  | 'cc-csc'
  | 'postal-code'
  | 'street-address'
  | 'address-level2'
  | 'address-level1'
  | 'name'
  | 'email'
  | 'tel'
  | 'cpf';

export interface AutofillPair {
  field: AutofillField;
  value: string;
}

function streetLine(a: Address): string {
  const main = [a.street, a.number].filter(Boolean).join(', ');
  return a.complement ? `${main} - ${a.complement}` : main;
}

const now = () => new Date().toISOString();
const changed = () => bus.emit(Events.DATA_CHANGED);

export function newFormItem(kind: FormKind): FormItem {
  const base = { id: uuid(), label: '', createdAt: now(), updatedAt: now() };
  if (kind === 'card') return { ...base, kind, holder: '', number: '', expMonth: '', expYear: '', cvv: '', brand: 'other' };
  if (kind === 'address') return { ...base, kind, fullName: '', zipCode: '', street: '', number: '', complement: '', neighborhood: '', city: '', state: '', country: 'Brasil', phone: '', reference: '', isPrimary: false };
  return { ...base, kind, fullName: '', email: '', phone: '', cpf: '', rg: '', birthDate: '', company: '' };
}

/** Título para a lista quando o usuário não deu um nome. */
export function formTitle(item: FormItem): string {
  if (item.label) return item.label;
  if (item.kind === 'card') return `${CardBrandLabels[item.brand]} final ${onlyDigits(item.number).slice(-4)}`;
  if (item.kind === 'address') return [item.street, item.number].filter(Boolean).join(', ') || 'Endereço';
  return item.fullName || 'Identidade';
}

export const FormService = {
  validate(item: FormItem, nowDate = new Date()): FormErrors {
    let errors: FormErrors;
    if (item.kind === 'card') errors = validateCard(item, nowDate);
    else if (item.kind === 'address') errors = validateAddress(item);
    else errors = validateIdentity(item);
    tooLong(item as unknown as Record<string, unknown>, errors);
    return errors;
  },

  async list(kind?: FormKind): Promise<FormItem[]> {
    const all = await vaultDb.all<FormItem>('forms');
    return all
      .filter(f => !kind || f.kind === kind)
      .sort((a, b) => Number((b as Address).isPrimary || false) - Number((a as Address).isPrimary || false) || b.updatedAt.localeCompare(a.updatedAt));
  },

  async get(id: string): Promise<FormItem | null> {
    return vaultDb.get<FormItem>('forms', id);
  },

  async save(input: FormItem): Promise<FormItem> {
    if (!input || !['card', 'address', 'identity'].includes(input.kind)) throw new ValidationError('Tipo de formulário inválido');
    const item = normalize(input);
    const errors = this.validate(item);
    const first = Object.values(errors)[0];
    if (first) throw new ValidationError(first);
    const prev = await vaultDb.get<FormItem>('forms', item.id);
    if (!prev && (await vaultDb.all<FormItem>('forms')).length >= FORM_LIMITS.items) throw new ValidationError(`Use no máximo ${FORM_LIMITS.items} formulários`);
    const saved = { ...item, createdAt: prev?.createdAt || item.createdAt || now(), updatedAt: now() } as FormItem;
    // Só um endereço principal
    if (saved.kind === 'address' && saved.isPrimary) {
      for (const other of await this.list('address')) {
        if (other.id !== saved.id && (other as Address).isPrimary) await vaultDb.put('forms', { ...other, isPrimary: false, updatedAt: now() }, { silent: true });
      }
    }
    await vaultDb.put('forms', saved);
    changed();
    return saved;
  },

  /** Exclusão segura e irrecuperável. */
  async remove(id: string): Promise<void> {
    await vaultDb.remove('forms', id);
    changed();
  },

  /** Pares {campo, valor} padronizados para preencher formulários em outros apps; campos vazios ficam de fora. */
  fieldsForAutofill(item: FormItem): AutofillPair[] {
    let pairs: [AutofillField, string][];
    if (item.kind === 'card') {
      pairs = [
        ['cc-number', onlyDigits(item.number)],
        ['cc-name', item.holder],
        ['cc-exp-month', item.expMonth],
        ['cc-exp-year', item.expYear ? `20${item.expYear}` : ''],
        ['cc-csc', item.cvv],
      ];
    } else if (item.kind === 'address') {
      pairs = [
        ['name', item.fullName],
        ['postal-code', formatCep(item.zipCode)],
        ['street-address', streetLine(item)],
        ['address-level2', item.city],
        ['address-level1', item.state],
        ['tel', onlyDigits(item.phone)],
      ];
    } else {
      pairs = [
        ['name', item.fullName],
        ['email', item.email],
        ['tel', onlyDigits(item.phone)],
        ['cpf', item.cpf ? formatCpf(item.cpf) : ''],
      ];
    }
    return pairs.filter(([, v]) => !!v && String(v).trim()).map(([field, value]) => ({ field, value: String(value).trim() }));
  },
};
