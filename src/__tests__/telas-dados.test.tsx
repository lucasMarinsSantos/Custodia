// Telas de dados: notas seguras, formulários, validade/idade/uso
// e últimas 10 senhas. Render com dados reais do cofre em memória e fluxos pela interface.
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Switch, Text } from 'react-native';
import { AppStateProvider } from '../context/AppState';
import { Vault } from '../services/VaultService';
import { Repo, newCredential } from '../services/Repository';
import { NoteService, newNote } from '../services/NoteService';
import { FormService, newFormItem } from '../services/FormService';
import { ExpiryService } from '../services/ExpiryService';
import { ClipboardService } from '../services/ClipboardService';
import { SessionService } from '../services/SessionService';
import { bus, Events } from '../services/events';
import { vaultDb } from '../db/Database';
import { __queueMockFile, __resetMockFiles } from '../native/files';
import { Address, PaymentCard } from '../types/models';

jest.mock('react-native-vector-icons/Feather', () => 'Icon');
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.setTimeout(120000);

import NotesScreen from '../screens/notes/NotesScreen';
import NoteDetailScreen from '../screens/notes/NoteDetailScreen';
import NoteEditScreen from '../screens/notes/NoteEditScreen';
import FormsScreen from '../screens/forms/FormsScreen';
import FormEditScreen from '../screens/forms/FormEditScreen';
import PasswordAgeSettingsScreen from '../screens/settings/PasswordAgeSettingsScreen';
import VaultScreen from '../screens/vault/VaultScreen';
import CredentialDetailScreen from '../screens/vault/CredentialDetailScreen';
import CredentialEditScreen from '../screens/vault/CredentialEditScreen';
import SettingsScreen from '../screens/settings/SettingsScreen';

const DAY = 86400000;
const flush = () => act(async () => new Promise(r => setTimeout(r, 120)));
const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
const toasts: { message: string; kind: string }[] = [];
let offToast: () => void = () => {};

beforeAll(async () => {
  await Vault.createVault({ masterPassword: 'Cofre#Seguro2026' });
  offToast = bus.on(Events.TOAST, (t: any) => toasts.push(t));
});

afterEach(async () => {
  while (mounted.length) {
    const r = mounted.pop()!;
    await act(async () => r.unmount());
  }
  toasts.length = 0;
  __resetMockFiles();
});

afterAll(async () => {
  offToast();
  ExpiryService.stopDaily();
  await ClipboardService.clearNow();
  SessionService.stop();
});

function nav() {
  return { navigate: jest.fn(), goBack: jest.fn(), setParams: jest.fn(), dispatch: jest.fn(), canGoBack: () => true, addListener: jest.fn(() => () => {}) };
}

async function render(Comp: React.ComponentType<any>, params: any = {}) {
  const navigation = nav();
  let r!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    r = ReactTestRenderer.create(
      <AppStateProvider>
        <Comp navigation={navigation} route={{ params, name: 'X' }} />
      </AppStateProvider>,
    );
  });
  mounted.push(r);
  await flush();
  return { r, navigation };
}

const texts = (r: ReactTestRenderer.ReactTestRenderer) =>
  r.root
    .findAllByType(Text)
    .map(t => (Array.isArray(t.props.children) ? t.props.children.join('') : String(t.props.children ?? '')))
    .join(' | ');

const press = async (r: ReactTestRenderer.ReactTestRenderer, label: string | RegExp) => {
  const match = (v?: string) => (typeof label === 'string' ? v === label : label.test(v || ''));
  const n = r.root.findAll(x => typeof x.type !== 'string' && x.props.onPress && (match(x.props.accessibilityLabel) || match(x.props.title)))[0];
  if (!n) throw new Error(`Botão não encontrado: ${label}`);
  await act(async () => {
    await n.props.onPress();
  });
  await flush();
};

const type = async (r: ReactTestRenderer.ReactTestRenderer, label: string, value: string) => {
  const n = r.root.findAll(x => typeof x.type === 'string' && x.props.onChangeText && (x.props.accessibilityLabel || '').startsWith(label))[0];
  if (!n) throw new Error(`Campo não encontrado: ${label}`);
  await act(async () => n.props.onChangeText(value));
};

const toggle = async (r: ReactTestRenderer.ReactTestRenderer, title: string, value: boolean) => {
  const sw = r.root.findAll(x => x.type === Switch && x.props.accessibilityLabel === title)[0];
  if (!sw) throw new Error(`Chave não encontrada: ${title}`);
  await act(async () => sw.props.onValueChange(value));
  await flush();
};

// =============================================================================
describe('Telas de notas seguras', () => {
  beforeEach(() => vaultDb.clearCollection('notes'));

  it('BDD Criar nota segura: na aba "Notas Seguras", "Nova Nota", título e texto, salvar', async () => {
    const list = await render(NotesScreen);
    expect(texts(list.r)).toContain('Notas Seguras');
    expect(texts(list.r)).toContain('Nenhuma nota segura');
    await press(list.r, 'Nova Nota');
    expect(list.navigation.navigate).toHaveBeenCalledWith('NoteEdit', {});

    const edit = await render(NoteEditScreen, {});
    await press(edit.r, 'Salvar');
    expect(texts(edit.r)).toContain('O título é obrigatório');
    await type(edit.r, 'Título', 'Seed da carteira');
    await type(edit.r, 'Texto confidencial', 'frase secreta de doze palavras');
    await press(edit.r, 'Salvar');
    expect(edit.navigation.goBack).toHaveBeenCalled();
    expect(toasts.map(t => t.message)).toContain('Nota salva no cofre criptografado');
    const [saved] = await NoteService.list();
    expect(saved).toMatchObject({ title: 'Seed da carteira', content: 'frase secreta de doze palavras' });

    const again = await render(NotesScreen);
    expect(texts(again.r)).toContain('Seed da carteira');
    await type(again.r, 'Buscar notas', 'inexistente');
    expect(texts(again.r)).toContain('Nenhuma nota encontrada');
  });

  it('BDD Edição de nota existente: abro a nota, adiciono texto e as alterações são salvas', async () => {
    const note = await NoteService.save(newNote({ title: 'Wi-Fi Casa', content: 'Rede: Casa', category: 'wifi' }));
    const detail = await render(NoteDetailScreen, { id: note.id });
    expect(texts(detail.r)).toContain('Wi-Fi Casa');
    expect(texts(detail.r)).toContain('Rede: Casa');
    await press(detail.r, 'Editar nota');
    expect(detail.navigation.navigate).toHaveBeenCalledWith('NoteEdit', { id: note.id });

    const edit = await render(NoteEditScreen, { id: note.id });
    await type(edit.r, 'Texto confidencial', 'Rede: Casa\nSenha: banana-azul');
    await press(edit.r, 'Salvar alterações');
    expect(toasts.map(t => t.message)).toContain('Nota atualizada');
    expect((await NoteService.get(note.id))!.content).toBe('Rede: Casa\nSenha: banana-azul');
  });

  it('anexos: adiciona pelo seletor e mostra o erro de tipo falso na tela', async () => {
    const edit = await render(NoteEditScreen, {});
    await type(edit.r, 'Título', 'Documentos');
    __queueMockFile({ name: 'rg.pdf', mime: 'application/pdf', size: 10, base64: Buffer.from('%PDF-1.4 rg').toString('base64') });
    await press(edit.r, 'Adicionar anexo');
    expect(texts(edit.r)).toContain('rg.pdf');
    __queueMockFile({ name: 'foto.png', mime: 'image/png', size: 4, base64: Buffer.from('MZ\u0090\u0000').toString('base64') });
    await press(edit.r, 'Adicionar anexo');
    expect(toasts.find(t => t.kind === 'error')?.message).toContain('não corresponde ao tipo do arquivo');
    expect(texts(edit.r)).not.toContain('foto.png');
    await press(edit.r, 'Salvar');
    const [saved] = await NoteService.list();
    expect(saved.attachments.map(a => a.name)).toEqual(['rg.pdf']);

    const detail = await render(NoteDetailScreen, { id: saved.id });
    expect(texts(detail.r)).toContain('Anexos (1)');
  });
});

// =============================================================================
describe('Telas de formulários', () => {
  beforeEach(() => vaultDb.clearCollection('forms'));
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('cartão: número inválido aparece no campo; válido salva com a bandeira', async () => {
    const edit = await render(FormEditScreen, { kind: 'card' });
    expect(texts(edit.r)).toContain('Novo Cartão');
    await type(edit.r, 'Número do cartão', '4111 1111 1111 1112');
    expect(texts(edit.r)).toContain('Número de cartão inválido');
    expect(texts(edit.r)).toContain('Visa');
    await type(edit.r, 'Número do cartão', '4111111111111111');
    await type(edit.r, 'Nome impresso', 'Lucas Marins');
    await type(edit.r, 'Validade', '1239');
    await type(edit.r, 'CVV', '123');
    await press(edit.r, 'Salvar Cartão');
    expect(toasts.map(t => t.message)).toContain('Cartão salvo');
    const [card] = (await FormService.list('card')) as PaymentCard[];
    expect(card).toMatchObject({ number: '4111111111111111', brand: 'visa', expMonth: '12', expYear: '39' });

    const list = await render(FormsScreen, { kind: 'card' });
    expect(texts(list.r)).toContain('Meus Cartões');
    expect(texts(list.r)).toContain('•••• 1111');
    expect(texts(list.r)).not.toContain('4111111111111111');
  });

  it('endereço: "Buscar CEP" preenche pelo ViaCEP; principal; lista "Meus Endereços" (tela 10)', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, text: async () => JSON.stringify({ logradouro: 'Avenida Paulista', bairro: 'Bela Vista', localidade: 'São Paulo', uf: 'SP' }) })) as any;
    const edit = await render(FormEditScreen, { kind: 'address' });
    expect(texts(edit.r)).toContain('Novo Endereço');
    await type(edit.r, 'CEP', '01310100');
    await press(edit.r, 'Buscar CEP');
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe('https://viacep.com.br/ws/01310100/json/');
    expect(toasts.map(t => t.message)).toContain('Endereço preenchido pelo CEP');
    await type(edit.r, 'Número', '1000');
    await toggle(edit.r, 'Definir como endereço principal', true);
    await press(edit.r, 'Salvar Endereço');
    const [a] = (await FormService.list('address')) as Address[];
    expect(a).toMatchObject({ street: 'Avenida Paulista', city: 'São Paulo', state: 'SP', zipCode: '01310-100', isPrimary: true });

    const list = await render(FormsScreen, { kind: 'address' });
    expect(texts(list.r)).toContain('Meus Endereços');
    expect(texts(list.r)).toContain('Avenida Paulista, 1000');
    expect(texts(list.r)).toContain('Principal');
  });

  it('endereço sem internet: avisa e o cadastro segue manual', async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError('Network request failed');
    }) as any;
    const edit = await render(FormEditScreen, { kind: 'address' });
    await type(edit.r, 'CEP', '01310-100');
    await press(edit.r, 'Buscar CEP');
    expect(toasts.map(t => t.message)).toContain('CEP não encontrado ou sem internet. Preencha o endereço manualmente.');
    await press(edit.r, 'Salvar Endereço');
    expect(texts(edit.r)).toContain('Informe o logradouro');
  });

  it('identidade: CPF inválido no campo; lista mostra o CPF mascarado', async () => {
    const edit = await render(FormEditScreen, { kind: 'identity' });
    await type(edit.r, 'Nome completo', 'Lucas Marins');
    await type(edit.r, 'CPF', '52998224724');
    await press(edit.r, 'Salvar Identidade');
    expect(texts(edit.r)).toContain('CPF inválido');
    await type(edit.r, 'CPF', '52998224725');
    await press(edit.r, 'Salvar Identidade');
    expect(toasts.map(t => t.message)).toContain('Identidade salva');
    const list = await render(FormsScreen, { kind: 'identity' });
    expect(texts(list.r)).toContain('***.982.247-**');
  });

  it('opções da lista: copiar e excluir', async () => {
    const saved = await FormService.save({ ...(newFormItem('card') as PaymentCard), holder: 'L', number: '5555555555554444', expMonth: '12', expYear: '39' });
    const list = await render(FormsScreen, { kind: 'card' });
    await press(list.r, /^Opções de /);
    await press(list.r, 'Copiar número do cartão');
    expect(toasts.find(t => t.kind === 'error')).toBeUndefined();
    await press(list.r, /^Opções de /);
    expect(texts(list.r)).toContain('Excluir');
    await FormService.remove(saved.id);
  });
});

// =============================================================================
describe('Validade, idade, uso e senhas anteriores nas telas', () => {
  beforeEach(async () => {
    await vaultDb.clearCollection('credentials');
    await vaultDb.setKv('expiry:alerted', '{}');
  });

  it('BDD Credencial expirada: ao abrir o app fica marcada em vermelho na lista, com alerta e filtro', async () => {
    const expired = await Repo.saveCredential(newCredential({ title: 'Portal Vencido', password: 'Senha#Forte2026', expiresAt: ExpiryService.addDays(-3) }));
    await Repo.saveCredential(newCredential({ title: 'Senha Velha', password: 'Senha#Forte2026', createdAt: new Date(Date.now() - 200 * DAY).toISOString() }));
    await Repo.saveCredential(newCredential({ title: 'Em dia', password: 'Senha#Forte2026' }));
    await ExpiryService.sweep();
    expect((await Repo.credential(expired.id))!.inactive).toBe(true);

    const { r } = await render(VaultScreen);
    const t = texts(r);
    expect(t).toContain('Vencida');
    expect(t).toContain('Trocar senha');
    expect(t).toContain('Senhas expiradas');
    expect(t).toContain('1 credencial vencida e 1 senha para trocar. Toque para ver.');
    const row = r.root.findAll(n => typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith('Portal Vencido') && n.props.onPress)[0];
    expect(row.props.accessibilityLabel).toContain('vencida');
    await press(r, 'Vencidas / Trocar (2)');
    expect(texts(r)).not.toContain('Em dia');
    expect(texts(r)).toContain('Portal Vencido');
  });

  it('BDD Definir validade de senha: ativo "Expirar em", 90 dias, salvo e o tempo restante aparece no detalhe', async () => {
    const c = await Repo.saveCredential(newCredential({ title: 'Banco', password: 'Senha#Forte2026' }));
    const edit = await render(CredentialEditScreen, { id: c.id });
    await toggle(edit.r, 'Expirar em', true);
    expect(texts(edit.r)).toContain('Vence em 90 dias');
    await press(edit.r, 'Salvar alterações');
    expect((await Repo.credential(c.id))!.expiresAt).toBe(ExpiryService.addDays(90));

    const detail = await render(CredentialDetailScreen, { id: c.id });
    expect(texts(detail.r)).toContain('Vence em 90 dias');
  });

  it('data de validade digitada inválida impede o salvamento com mensagem', async () => {
    const c = await Repo.saveCredential(newCredential({ title: 'Loja', password: 'Senha#Forte2026' }));
    const edit = await render(CredentialEditScreen, { id: c.id });
    await toggle(edit.r, 'Expirar em', true);
    await type(edit.r, 'Data de validade', '31/02/2030');
    expect(texts(edit.r)).toContain('Data inválida (use DD/MM/AAAA)');
    await press(edit.r, 'Salvar alterações');
    expect(toasts.map(x => x.message)).toContain('Data de validade inválida (use DD/MM/AAAA)');
    expect(edit.navigation.goBack).not.toHaveBeenCalled();
  });

  it('detalhe: "Vezes utilizada", "Último uso", idade, sugestão de troca e senhas anteriores ocultas/copiáveis', async () => {
    let c = await Repo.saveCredential(newCredential({ title: 'Email', password: 'Antiga#Senha#01', createdAt: new Date(Date.now() - 120 * DAY).toISOString() }));
    c = await Repo.saveCredential({ ...c, password: 'Atual#Senha#02', passwordChangedAt: c.passwordChangedAt });
    // passwordChangedAt é recalculado na troca: força a idade antiga direto no banco para o teste da sugestão
    await vaultDb.put('credentials', { ...c, passwordChangedAt: new Date(Date.now() - 120 * DAY).toISOString() });
    await Repo.recordUsage(c.id);
    await Repo.recordUsage(c.id);

    const { r, navigation } = await render(CredentialDetailScreen, { id: c.id });
    const t = texts(r);
    expect(t).toContain('Vezes utilizada');
    expect(t).toContain('Último uso');
    expect(t).toContain('Senha alterada há 120 dias');
    expect(t).toContain('Recomendamos trocar esta senha');
    expect(t).toContain('Senhas anteriores (1/10)');
    expect(t).not.toContain('Antiga#Senha#01');
    await press(r, 'Mostrar senha anterior 1');
    expect(texts(r)).toContain('Antiga#Senha#01');
    await press(r, 'Copiar senha anterior 1');
    expect(toasts.find(x => x.kind === 'error')).toBeUndefined();
    await press(r, 'Trocar senha');
    expect(navigation.navigate).toHaveBeenCalledWith('CredentialEdit', { id: c.id });
  });

  it('ajustes: prazo padrão configurável e atalho na tela de ajustes', async () => {
    const s = await render(SettingsScreen);
    expect(texts(s.r)).toContain('Troca e validade das senhas');
    expect(texts(s.r)).toContain('Cartões, endereços e identidades');
    const p = await render(PasswordAgeSettingsScreen);
    expect(texts(p.r)).toContain('Sugestão de troca');
    await press(p.r, '60 dias');
    expect(Vault.settings.passwordMaxAgeDays).toBe(60);
    await press(p.r, '90 dias');
    expect(Vault.settings.passwordMaxAgeDays).toBe(90);
  });
});
