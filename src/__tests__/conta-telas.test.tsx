// Telas da conta: 2FA (ativação com QR Code), perfis, regras da pasta e a etapa do código no login.
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { AppStateProvider } from '../context/AppState';
import { Vault } from '../services/VaultService';
import { TotpService } from '../services/TotpService';
import { Repo, newFolder } from '../services/Repository';
import { ClipboardService } from '../services/ClipboardService';
import { SessionService } from '../services/SessionService';

jest.mock('react-native-vector-icons/Feather', () => 'Icon');
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.setTimeout(180000);

import TwoFactorScreen from '../screens/settings/TwoFactorScreen';
import ProfilesScreen from '../screens/settings/ProfilesScreen';
import FolderRulesScreen from '../screens/vault/FolderRulesScreen';
import LoginScreen from '../screens/auth/LoginScreen';
import { MasterPasswordInput } from '../components/MasterPasswordInput';

const MASTER = 'Cofre#Seguro2026';
const flush = () => act(async () => new Promise(r => setTimeout(r, 120)));
const mounted: ReactTestRenderer.ReactTestRenderer[] = [];

afterEach(async () => {
  while (mounted.length) {
    const r = mounted.pop()!;
    await act(async () => r.unmount());
  }
});
afterAll(async () => {
  await ClipboardService.clearNow();
  SessionService.stop();
});

const nav = () => ({ navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => () => {}) });

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

const press = async (r: ReactTestRenderer.ReactTestRenderer, title: string) => {
  const n = r.root.findAll(x => typeof x.type !== 'string' && x.props.onPress && (x.props.title === title || x.props.accessibilityLabel === title))[0];
  if (!n) throw new Error(`Botão não encontrado: ${title}`);
  await act(async () => {
    await n.props.onPress();
  });
  await flush();
};

const type = async (r: ReactTestRenderer.ReactTestRenderer, label: string, value: string) => {
  const n = r.root.findAll(x => typeof x.type !== 'string' && x.props.label === label && (x.props.onChangeText || x.props.onChange))[0];
  if (!n) throw new Error(`Campo não encontrado: ${label}`);
  await act(async () => (n.props.onChangeText || n.props.onChange)(value));
};

describe('Telas de conta', () => {
  beforeAll(async () => {
    await Vault.createVault({ name: 'Pessoal', masterPassword: MASTER });
  });

  it('2FA: ativa pelo QR Code e mostra os códigos de reserva; o login passa a pedir o código', async () => {
    const { r } = await render(TwoFactorScreen);
    await press(r, 'Ativar verificação em duas etapas');
    expect(r.root.findAll(x => x.props.accessibilityLabel === 'QR Code da verificação em duas etapas').length).toBeGreaterThan(0);
    const secretText = r.root.findAllByType(Text).find(t => /^[A-Z2-7]{4}( [A-Z2-7]{4}){7}$/.test(String(t.props.children)))!;
    const secret = String(secretText.props.children).replace(/ /g, '');
    await type(r, 'Código de 6 dígitos', TotpService.generate(secret));
    await type(r, 'Senha mestra', MASTER);
    await press(r, 'Confirmar e ativar');
    expect(texts(r)).toContain('Códigos de reserva');
    await press(r, 'Já guardei');
    expect(texts(r)).toContain('Verificação em duas etapas ativa');

    await Vault.lock();
    const login = await render(LoginScreen);
    const pw = login.r.root.findAllByType(MasterPasswordInput)[0];
    await act(async () => pw.props.onChange(MASTER));
    await press(login.r, 'Desbloquear');
    expect(texts(login.r)).toContain('Digite o código de 6 dígitos do seu app autenticador');
    await type(login.r, 'Código de verificação', '000000');
    await press(login.r, 'Verificar e entrar');
    expect(texts(login.r)).toContain('Código de verificação inválido.');
    expect(Vault.isUnlocked).toBe(false);
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_000);
    await type(login.r, 'Código de verificação', TotpService.generate(secret));
    await press(login.r, 'Verificar e entrar');
    (Date.now as jest.Mock).mockRestore();
    expect(Vault.isUnlocked).toBe(true);
  });

  it('regras da pasta: editor salva e mostra a herança na subpasta', async () => {
    const f = newFolder('Bancos');
    await Repo.saveFolder(f);
    const sub = newFolder('Cartões', f.id);
    await Repo.saveFolder(sub);
    const { r, navigation } = await render(FolderRulesScreen, { folderId: f.id });
    const toggle = r.root.findAll(x => x.props.title === 'Reautenticar para ver/copiar' && x.props.onChange)[0];
    await act(async () => toggle.props.onChange(true));
    await type(r, 'Limpar a área de transferência após (segundos)', '15');
    await press(r, 'Salvar regras');
    expect(navigation.goBack).toHaveBeenCalled();
    expect((await Repo.folders()).find(x => x.id === f.id)!.policy).toMatchObject({ requireReauth: true, clipboardSeconds: 15 });
    const child = await render(FolderRulesScreen, { folderId: sub.id });
    expect(texts(child.r)).toContain('Regras herdadas');
    expect(texts(child.r)).toContain('Herdada de uma pasta acima');
  });

  it('perfis: lista o perfil em uso e o seletor aparece no login com dois perfis', async () => {
    const { r } = await render(ProfilesScreen);
    expect(texts(r)).toContain('Perfil Pessoal');
    expect(texts(r)).toContain('em uso');
    await Vault.createProfile({ name: 'Profissional', type: 'professional', masterPassword: 'Trabalho#Seguro2026' });
    await Vault.lock();
    const login = await render(LoginScreen);
    expect(texts(login.r)).toContain('Perfil Pessoal');
    expect(texts(login.r)).toContain('Perfil Profissional');
  });
});
