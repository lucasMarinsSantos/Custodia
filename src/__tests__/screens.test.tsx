// Teste de fumaça: cada tela renderiza com dados reais do cofre sem dar erro
// e os fluxos principais funcionam pela interface (criar credencial, validação do título, gerador).
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { AppStateProvider } from '../context/AppState';
import { Vault } from '../services/VaultService';
import { Repo, newCredential, newFolder } from '../services/Repository';
import { bus, Events } from '../services/events';
import { ClipboardService } from '../services/ClipboardService';
import { SessionService } from '../services/SessionService';

jest.mock('react-native-vector-icons/Feather', () => 'Icon');
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.setTimeout(120000);

import WelcomeScreen from '../screens/auth/WelcomeScreen';
import SetupScreen from '../screens/auth/SetupScreen';
import LoginScreen from '../screens/auth/LoginScreen';
import RecoveryScreen from '../screens/auth/RecoveryScreen';
import RecoverySetupScreen from '../screens/auth/RecoverySetupScreen';
import VaultScreen from '../screens/vault/VaultScreen';
import CredentialDetailScreen from '../screens/vault/CredentialDetailScreen';
import CredentialEditScreen from '../screens/vault/CredentialEditScreen';
import HistoryScreen from '../screens/vault/HistoryScreen';
import FoldersScreen from '../screens/vault/FoldersScreen';
import GeneratorScreen from '../screens/generator/GeneratorScreen';
import SecurityScreen from '../screens/security/SecurityScreen';
import SettingsScreen from '../screens/settings/SettingsScreen';
import SecuritySettingsScreen from '../screens/settings/SecuritySettingsScreen';
import ChangePasswordScreen from '../screens/settings/ChangePasswordScreen';
import RecoveryOptionsScreen from '../screens/settings/RecoveryOptionsScreen';
import AboutScreen from '../screens/settings/AboutScreen';

const flush = () => act(async () => new Promise(r => setTimeout(r, 120)));
const mounted: ReactTestRenderer.ReactTestRenderer[] = [];

afterEach(async () => {
  // Desmonta as telas do teste (evita timers/animações de um teste interferindo no próximo)
  while (mounted.length) {
    const r = mounted.pop()!;
    await act(async () => r.unmount());
  }
});

afterAll(async () => {
  await ClipboardService.clearNow();
  SessionService.stop();
});

function nav() {
  return {
    navigate: jest.fn(),
    goBack: jest.fn(),
    replace: jest.fn(),
    popTo: jest.fn(),
    reset: jest.fn(),
    setParams: jest.fn(),
    dispatch: jest.fn(),
    canGoBack: () => true,
    addListener: jest.fn(() => () => {}),
  };
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

const pressByLabel = async (r: ReactTestRenderer.ReactTestRenderer, label: string | RegExp) => {
  const n = r.root.findAll(x => typeof x.type !== 'string' && x.props.onPress && (typeof label === 'string' ? x.props.accessibilityLabel === label || x.props.title === label : label.test(x.props.accessibilityLabel || x.props.title || '')))[0];
  if (!n) throw new Error(`Botão não encontrado: ${label}`);
  await act(async () => {
    await n.props.onPress();
  });
  await flush();
};

describe('Telas antes do cofre existir', () => {
  it('boas-vindas e criação da senha mestra (BDD: senha curta e confirmação incorreta)', async () => {
    const w = await render(WelcomeScreen);
    expect(texts(w.r)).toContain('Criar meu cofre');
    await pressByLabel(w.r, 'Criar meu cofre');
    expect(w.navigation.navigate).toHaveBeenCalledWith('Setup');

    const s = await render(SetupScreen);
    const inputs = () => s.r.root.findAll(n => n.props.onChangeText && n.props.secureTextEntry !== undefined && typeof n.type === 'string');
    expect(texts(s.r)).toContain('Mínimo de 12 caracteres');
    await act(async () => inputs()[0].props.onChangeText('Ab1!xy'));
    await pressByLabel(s.r, 'Criar cofre');
    expect(texts(s.r)).toContain('A senha deve conter pelo menos 12 caracteres');
    await act(async () => inputs()[0].props.onChangeText('Cofre#Seguro2026'));
    await act(async () => inputs()[1].props.onChangeText('Cofre#Seguro2025'));
    await pressByLabel(s.r, 'Criar cofre');
    expect(texts(s.r)).toContain('As senhas não coincidem');
    expect(await Vault.hasVault()).toBe(false);
    // Confirmação correta → cofre criado
    await act(async () => inputs()[1].props.onChangeText('Cofre#Seguro2026'));
    await pressByLabel(s.r, 'Criar cofre');
    await flush();
    expect(await Vault.hasVault()).toBe(true);
    expect(Vault.isUnlocked).toBe(true);
  });
});

describe('Telas com o cofre aberto', () => {
  let id = '';
  beforeAll(async () => {
    const f = newFolder('Finanças');
    await Repo.saveFolder(f);
    const c = await Repo.saveCredential(newCredential({ title: 'Nubank', username: 'lucas', password: '123456', url: 'nubank.com.br', category: 'finance', folderId: f.id }));
    await Repo.saveCredential({ ...c, password: 'Nova#Senha2026!x' });
    await Repo.saveCredential(newCredential({ title: 'Netflix', username: 'familia', password: 'x9#Lq!v2Tz$8mWp&Rk4e', url: 'netflix.com' }));
    id = c.id;
  });

  it('RecoverySetup mostra o código de recuperação', async () => {
    bus.emit(Events.UNLOCKED, { recoveryCode: 'ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2-34567' });
    const { r } = await render(RecoverySetupScreen);
    expect(texts(r)).toContain('Código de recuperação');
  });

  it('Cofre lista, busca e mostra "Nenhuma credencial encontrada"', async () => {
    const { r } = await render(VaultScreen);
    const t = texts(r);
    expect(t).toContain('Meus acessos');
    expect(t).toContain('Nubank');
    expect(t).toContain('Netflix');
    const search = r.root.findAll(n => n.props.accessibilityLabel === 'Buscar no cofre' && n.props.onChangeText)[0];
    await act(async () => search.props.onChangeText('Netf'));
    expect(texts(r)).not.toContain('Nubank');
    await act(async () => search.props.onChangeText('Asdfgh'));
    expect(texts(r)).toContain('Nenhuma credencial encontrada');
  });

  it('BDD: salvar sem título exibe "O título é obrigatório"; com título salva no cofre', async () => {
    const { r, navigation } = await render(CredentialEditScreen, {});
    await pressByLabel(r, 'Salvar');
    expect(texts(r)).toContain('O título é obrigatório');
    const field = (label: string) => r.root.findAll(n => n.props.accessibilityLabel?.startsWith(label) && n.props.onChangeText && typeof n.type === 'string')[0];
    await act(async () => field('Título').props.onChangeText('Facebook'));
    await act(async () => field('Usuário').props.onChangeText('lucas.fb'));
    await act(async () => field('Senha').props.onChangeText('Face#Book2026!'));
    await pressByLabel(r, 'Salvar');
    expect(navigation.goBack).toHaveBeenCalled();
    expect((await Repo.credentials()).some(c => c.title === 'Facebook' && c.username === 'lucas.fb')).toBe(true);
  });

  it('detalhe, histórico, pastas, gerador e saúde das senhas renderizam', async () => {
    const d = await render(CredentialDetailScreen, { id });
    expect(texts(d.r)).toContain('Nubank');
    await pressByLabel(d.r, 'Copiar senha');
    expect((await Repo.credential(id))?.usageCount).toBe(1);

    const h = await render(HistoryScreen, { id });
    expect(texts(h.r)).toContain('Restaurar esta versão');

    const f = await render(FoldersScreen);
    expect(texts(f.r)).toContain('Finanças');

    const g = await render(GeneratorScreen);
    expect(texts(g.r)).toContain('Comprimento: 16 caracteres');

    const s = await render(SecurityScreen);
    expect(texts(s.r)).toContain('Saúde das senhas');
  });

  it('gerador aberto pela edição devolve a senha à MESMA tela (popTo, sem abrir outra "Nova credencial")', async () => {
    const g = await render(GeneratorScreen, { returnTo: 'CredentialEdit' });
    await pressByLabel(g.r, 'Usar esta senha');
    expect(g.navigation.popTo).toHaveBeenCalledWith('CredentialEdit', { generated: expect.stringMatching(/^.{16}$/) }, { merge: true });
    expect(g.navigation.navigate).not.toHaveBeenCalled();
  });

  it('ajustes e subtelas renderizam', async () => {
    for (const Comp of [SettingsScreen, SecuritySettingsScreen, ChangePasswordScreen, RecoveryOptionsScreen, AboutScreen]) {
      const { r } = await render(Comp);
      expect(texts(r).length).toBeGreaterThan(10);
    }
  });

  it('login e recuperação renderizam com o cofre bloqueado', async () => {
    await Vault.lock();
    const l = await render(LoginScreen);
    expect(texts(l.r)).toContain('Desbloquear');
    expect(texts(l.r)).toContain('Esqueceu a senha?');
    const rec = await render(RecoveryScreen, {});
    expect(texts(rec.r)).toContain('Nova senha mestra');
  });
});
