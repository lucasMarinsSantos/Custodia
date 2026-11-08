// Telas das integrações: Ajustes › Preenchimento automático, escolha da credencial para outro app,
// Ajustes › Extensão de navegador, confirmação no celular, sites associados e arrastar no detalhe.
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Text, TextInput } from 'react-native';
import { AppStateProvider } from '../context/AppState';
import { Vault } from '../services/VaultService';
import { Repo, newCredential } from '../services/Repository';
import { bus, Events } from '../services/events';
import { SessionService } from '../services/SessionService';
import { AutofillService, MSG } from '../services/AutofillService';
import { BridgeApprovals, BrowserBridgeService } from '../services/BrowserBridgeService';
import { ASSOC_MSG } from '../services/AssociationService';
import { DRAG_MSG } from '../services/DragService';
import { __integrationMocks, AutofillRequest } from '../native/integration';

jest.mock('react-native-vector-icons/Feather', () => 'Icon');
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.setTimeout(120000);

import AutofillScreen from '../screens/settings/AutofillScreen';
import AutofillRequestScreen from '../screens/autofill/AutofillRequestScreen';
import BrowserExtensionScreen from '../screens/settings/BrowserExtensionScreen';
import SettingsScreen from '../screens/settings/SettingsScreen';
import CredentialEditScreen from '../screens/vault/CredentialEditScreen';
import CredentialDetailScreen from '../screens/vault/CredentialDetailScreen';
import { IntegrationHost } from '../components/IntegrationHost';

const flush = () => act(async () => new Promise(r => setTimeout(r, 120)));
const mounted: ReactTestRenderer.ReactTestRenderer[] = [];

afterEach(async () => {
  while (mounted.length) {
    const r = mounted.pop()!;
    await act(async () => r.unmount());
  }
});

afterAll(() => SessionService.stop());

function nav() {
  return { navigate: jest.fn(), goBack: jest.fn(), replace: jest.fn(), popTo: jest.fn(), reset: jest.fn(), setParams: jest.fn(), dispatch: jest.fn(), canGoBack: () => true, addListener: jest.fn(() => () => {}) };
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

const find = (r: ReactTestRenderer.ReactTestRenderer, label: string, prop = 'onPress') =>
  r.root.findAll(x => typeof x.type !== 'string' && x.props[prop] && (x.props.accessibilityLabel === label || x.props.title === label))[0];

const press = async (r: ReactTestRenderer.ReactTestRenderer, label: string) => {
  const n = find(r, label);
  if (!n) throw new Error(`Botão não encontrado: ${label}`);
  await act(async () => {
    await n.props.onPress();
  });
  await flush();
};

function toasts() {
  const list: string[] = [];
  const off = bus.on(Events.TOAST, (t: any) => list.push(t.message));
  return { list, off };
}

let seq = 0;
const request = (p: Partial<AutofillRequest>): AutofillRequest => ({ id: `t-${++seq}`, kind: 'login', packageName: 'com.twitter.android', url: null, credentialId: null, newPassword: false, createdAt: Date.now(), ...p });

let twitterId = '';

beforeAll(async () => {
  await Vault.createVault({ masterPassword: 'Cofre#Seguro2026' });
  twitterId = (
    await Repo.saveCredential(newCredential({ title: 'Twitter', username: 'lucas', password: 'Tw#Senha2026!', url: 'https://twitter.com', androidPackages: ['com.twitter.android'], associatedDomains: ['*.x.com'] }))
  ).id;
});

describe('Ajustes › Preenchimento automático', () => {
  it('guia a ativação, explica a restrição do Android 13+ e liga/desliga o preenchimento', async () => {
    __integrationMocks.autofill.serviceEnabled = false;
    const { r } = await render(AutofillScreen);
    const t = texts(r);
    expect(t).toContain('Serviço de acessibilidade inativo');
    expect(t).toContain('Como ativar');
    expect(t).toContain('Permitir configurações restritas');
    await press(r, 'Abrir informações do app');
    await press(r, 'Abrir configurações de acessibilidade');
    await press(r, 'Preencher em outros apps');
    expect(Vault.settings.autofillEnabled).toBe(false);
    await press(r, 'Preencher em outros apps');
    expect(Vault.settings.autofillEnabled).toBe(true);
  });

  it('com o serviço ativo, mostra o status e as sugestões de salvar login novo', async () => {
    __integrationMocks.autofill.serviceEnabled = true;
    __integrationMocks.autofill.changes.push({ kind: 'login', packageName: 'com.android.chrome', url: 'https://novo.com.br', at: Date.now() });
    await AutofillService.processPasswordChanges();
    const { r, navigation } = await render(AutofillScreen);
    expect(texts(r)).toContain('Serviço de acessibilidade ativo');
    expect(texts(r)).toContain('Deseja salvar esta senha no cofre?');
    await press(r, 'Deseja salvar esta senha no cofre?');
    expect(navigation.navigate).toHaveBeenCalledWith('CredentialEdit', { prefillUrl: 'https://novo.com.br', prefillPackage: '' });
  });

  it('Ajustes lista as integrações', async () => {
    const { r } = await render(SettingsScreen);
    expect(texts(r)).toContain('Preenchimento automático');
    expect(texts(r)).toContain('Extensão de navegador');
  });
});

describe('Escolha da credencial para outro app', () => {
  it('sem pedido aberto, explica como usar', async () => {
    AutofillService.setCurrentRequest(null);
    const { r } = await render(AutofillRequestScreen);
    expect(texts(r)).toContain('Nenhum pedido de preenchimento aberto');
  });

  it('sugere a credencial do app, segura o bloqueio por inatividade e preenche ao tocar', async () => {
    const hold = jest.spyOn(SessionService, 'holdInactivity');
    const req = request({});
    AutofillService.setCurrentRequest(req);
    const { r, navigation } = await render(AutofillRequestScreen);
    expect(hold).toHaveBeenCalledWith(true);
    expect(texts(r)).toContain('Credenciais sugeridas');
    expect(texts(r)).toContain('App associado');
    const t = toasts();
    await press(r, 'Twitter');
    t.off();
    expect(__integrationMocks.autofill.delivered).toMatchObject({ requestId: req.id, password: 'Tw#Senha2026!' });
    expect(t.list[0]).toContain('Volte para com.twitter.android');
    expect(navigation.goBack).toHaveBeenCalled();
    hold.mockRestore();
  });

  it('Cenário: nenhuma credencial encontrada, não sugere, mas oferece buscar no cofre', async () => {
    AutofillService.setCurrentRequest(request({ packageName: 'com.app.semsenha' }));
    const { r } = await render(AutofillRequestScreen);
    expect(texts(r)).toContain('Nenhuma credencial salva para este app ou site.');
    await press(r, 'Buscar no cofre');
    expect(texts(r)).toContain('Twitter');
    expect(find(r, 'Buscar', 'onChangeText')).toBeTruthy();
  });

  it('site parecido com um salvo: mostra "Preenchimento bloqueado" e não lista credenciais', async () => {
    AutofillService.setCurrentRequest(request({ packageName: 'com.android.chrome', url: 'https://twltter.com/login' }));
    const { r } = await render(AutofillRequestScreen);
    expect(texts(r)).toContain('Preenchimento bloqueado');
    expect(texts(r)).not.toContain('Credenciais sugeridas');
  });

  it('subdomínio associado com *. aparece como "Domínio associado"', async () => {
    AutofillService.setCurrentRequest(request({ packageName: 'com.android.chrome', url: 'https://login.x.com' }));
    const { r } = await render(AutofillRequestScreen);
    expect(texts(r)).toContain('Domínio associado');
  });

  it('cofre bloqueado: o motivo aparece antes da escolha', async () => {
    AutofillService.setCurrentRequest(request({}));
    const spy = jest.spyOn(Vault, 'isUnlocked', 'get').mockReturnValue(false);
    try {
      const preview = await AutofillService.preview(AutofillService.currentRequest);
      expect(preview.blocked).toBe(MSG.locked);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('Ajustes › Extensão de navegador e confirmação no celular', () => {
  it('liga a ponte, abre a janela de pareamento e mostra a confirmação com o código', async () => {
    const { r } = await render(BrowserExtensionScreen);
    expect(texts(r)).toContain('Nenhuma extensão pareada.');
    await press(r, 'Permitir conexão da extensão');
    expect(Vault.settings.browserBridge).toBe(true);
    expect(texts(r)).toContain('Aceitar conexões da rede Wi-Fi');
    await press(r, 'Parear nova extensão');
    expect(texts(r)).toContain('Aguardando a extensão…');
    await press(r, 'Cancelar pareamento');
    expect(BrowserBridgeService.pairingWindow).toBeNull();

    const host = await render(IntegrationHost);
    let answer: boolean | null = null;
    act(() => {
      BridgeApprovals.request({ kind: 'pair', title: 'Parear extensão de navegador?', message: '"Chrome" quer se conectar', code: '123 456' }).then(v => (answer = v));
    });
    await flush();
    expect(texts(host.r)).toContain('123 456');
    await press(host.r, 'Permitir');
    expect(answer).toBe(true);
  });
});

describe('Sites associados e arrastar (cadastro e detalhe)', () => {
  it('editor valida o domínio associado e mostra o erro', async () => {
    const { r } = await render(CredentialEditScreen, { id: twitterId });
    const input = () => r.root.findAll(n => n.type === TextInput && n.props.placeholder === 'empresa.com ou *.empresa.com')[0];
    await act(async () => input().props.onChangeText('sem ponto'));
    await press(r, 'Adicionar');
    expect(texts(r)).toContain(ASSOC_MSG.badSite);
    await act(async () => input().props.onChangeText('portal.empresa.com'));
    await press(r, 'Adicionar');
    expect(texts(r)).toContain('portal.empresa.com');
  });

  it('cadastro aberto por "Deseja salvar esta senha no cofre?" já vem com o site', async () => {
    const { r } = await render(CredentialEditScreen, { prefillUrl: 'https://novo.com.br/entrar' });
    const values = r.root.findAll(n => n.type === TextInput).map(n => n.props.value);
    expect(values).toContain('novo.com.br');
    expect(values).toContain('https://novo.com.br');
  });

  it('detalhe lista os sites associados e o toque longo na senha explica a tela dividida', async () => {
    __integrationMocks.drag.multiWindow = false;
    const { r } = await render(CredentialDetailScreen, { id: twitterId });
    expect(texts(r)).toContain('Sites e apps associados');
    expect(texts(r)).toContain('*.x.com');
    const field = r.root.findAll(n => typeof n.type !== 'string' && n.props.onLongPress && /^Senha/.test(n.props.accessibilityLabel || ''))[0];
    const t = toasts();
    await act(async () => {
      await field.props.onLongPress();
    });
    await flush();
    t.off();
    expect(t.list).toContain(DRAG_MSG.notMultiWindow);
  });
});
