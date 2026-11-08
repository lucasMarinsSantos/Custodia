// Telas da Segurança: render e interação com dados reais do cofre (banco simulado)
//  • Central de segurança e estatísticas, vazamentos, verificação de site,
//    histórico de acessos e alertas, duplicatas e risco, aviso de dicionário
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Alert, Text } from 'react-native';
import { AppStateProvider } from '../context/AppState';
import { Vault } from '../services/VaultService';
import { Repo, newCredential } from '../services/Repository';
import { AlertService } from '../services/AlertService';
import { AccessLogService } from '../services/AccessLogService';
import { BreachService, HIBP_RANGE_URL, sha1Hex } from '../services/BreachService';
import { ClipboardService } from '../services/ClipboardService';
import { SessionService } from '../services/SessionService';
import { vaultDb } from '../db/Database';
import { __setNetMocks } from '../native/net';

jest.mock('react-native-vector-icons/Feather', () => 'Icon');
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.setTimeout(120000);

import SecurityScreen from '../screens/security/SecurityScreen';
import BreachReportScreen from '../screens/security/BreachReportScreen';
import UrlCheckScreen from '../screens/security/UrlCheckScreen';
import AccessLogScreen from '../screens/security/AccessLogScreen';
import AlertsScreen from '../screens/security/AlertsScreen';
import DuplicatesScreen from '../screens/security/DuplicatesScreen';
import RiskScreen from '../screens/security/RiskScreen';
import GeneratorScreen from '../screens/generator/GeneratorScreen';
import CredentialEditScreen from '../screens/vault/CredentialEditScreen';

const LEAKED = '123456';
const leakedHash = sha1Hex(LEAKED);
let online = true;
(global as any).fetch = jest.fn(async (url: string) => {
  if (!online) throw new TypeError('Network request failed');
  const prefix = url.slice(HIBP_RANGE_URL.length);
  const body = prefix === leakedHash.slice(0, 5) ? `${leakedHash.slice(5)}:37359195\r\n0011E2F8B83D76FAF94F6A45C4D1DEF8164:0` : '0018A45C4D1DEF81644B54AB7F969B88D65:3';
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => body };
});

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

function nav() {
  return { navigate: jest.fn(), goBack: jest.fn(), replace: jest.fn(), popTo: jest.fn(), setParams: jest.fn(), dispatch: jest.fn(), canGoBack: () => true, addListener: jest.fn(() => () => {}) };
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

const byLabel = (r: ReactTestRenderer.ReactTestRenderer, label: string | RegExp) =>
  r.root.findAll(x => typeof x.type !== 'string' && x.props.onPress && (typeof label === 'string' ? x.props.accessibilityLabel === label || x.props.title === label : label.test(x.props.accessibilityLabel || x.props.title || '')));

const press = async (r: ReactTestRenderer.ReactTestRenderer, label: string | RegExp) => {
  const n = byLabel(r, label)[0];
  if (!n) throw new Error(`Botão não encontrado: ${label}`);
  await act(async () => {
    await n.props.onPress();
  });
  await flush();
};

let fbId = '';
let leakedId = '';

beforeAll(async () => {
  await Vault.createVault({ masterPassword: 'Cofre#Seguro2026' });
  const fb = await Repo.saveCredential(newCredential({ title: 'Facebook', url: 'facebook.com', username: 'lucas', password: 'Mesma#Senha2026', category: 'social', usageCount: 4 }));
  await Repo.saveCredential(newCredential({ title: 'Instagram', url: 'instagram.com', username: 'lucas', password: 'Mesma#Senha2026', category: 'social' }));
  const leaked = await Repo.saveCredential(newCredential({ title: 'Fórum antigo', url: 'forum.exemplo.com', username: 'lucas', password: LEAKED }));
  await Repo.saveCredential(newCredential({ title: 'Banco', url: 'nubank.com.br', username: 'lucas', password: 'x9#Lq!v2Tz$8mWp&Rk4e', category: 'finance' }));
  await Repo.saveCredential(newCredential({ title: 'Banco cópia', url: 'https://nubank.com.br/login', username: 'Lucas', password: 'Q7!mZp#4vLx@2RkT', category: 'finance' }));
  fbId = fb.id;
  leakedId = leaked.id;
});

describe('Telas de segurança', () => {
  it('Saúde das Senhas vira a central: atalhos e estatísticas por categoria, idade, força e uso', async () => {
    const { r, navigation } = await render(SecurityScreen);
    const t = texts(r);
    for (const s of ['Central de segurança', 'Alertas de segurança', 'Vazamentos de senhas', 'Credenciais duplicadas', 'Classificação por risco', 'Verificar site', 'Histórico de acessos']) expect(t).toContain(s);
    for (const s of ['Estatísticas do cofre', 'Por categoria', 'Redes Sociais', 'Por idade da senha', 'Até 30 dias', 'Por força', 'Mais usadas']) expect(t).toContain(s);
    expect(t).toContain('2 grupos de duplicatas');
    await press(r, /^Vazamentos de senhas/);
    expect(navigation.navigate).toHaveBeenCalledWith('BreachReport');
  });

  it('BDD "Senha comprometida detectada" e "Verificação de senha segura" na tela de vazamentos, com "Trocar senha"', async () => {
    const { r, navigation } = await render(BreachReportScreen);
    expect(texts(r)).toContain('O cofre ainda não foi verificado por completo.');
    await press(r, 'Verificar agora');
    await flush();
    const t = texts(r);
    expect(t).toContain('Contas comprometidas');
    expect(t).toContain('Fórum antigo');
    expect(t).toContain('Esta senha já apareceu em vazamentos de dados');
    expect(t).toContain('encontrada 37.359.195 vezes');
    expect(t).toContain('Segura'); // ícone verde das senhas nunca vazadas
    expect(t).toContain('Última verificação completa');
    await press(r, 'Trocar senha');
    expect(navigation.navigate).toHaveBeenCalledWith('CredentialEdit', { id: leakedId });
  });

  it('sem internet, a tela de vazamentos avisa e não quebra', async () => {
    online = false;
    BreachService.clearMemory();
    const { r } = await render(BreachReportScreen);
    await press(r, 'Verificar agora');
    expect(texts(r)).toContain('Sem conexão');
    expect(texts(r)).toContain('Fórum antigo'); // o resultado do cache continua valendo
    online = true;
  });

  it('verificação de site: endereço inválido, domínio falso e certificado válido', async () => {
    __setNetMocks({ tls: async host => ({ reachable: true, valid: true, host, issuer: 'DigiCert Inc • DigiCert TLS RSA', validTo: Date.now() + 90 * 86400000, protocol: 'TLSv1.3', hsts: true }) });
    const { r } = await render(UrlCheckScreen);
    const input = () => r.root.findAll(n => n.props.accessibilityLabel?.startsWith('Endereço do site') && n.props.onChangeText && typeof n.type === 'string')[0];
    await press(r, 'Verificar');
    expect(texts(r)).toContain('Digite ou cole o endereço do site');
    await act(async () => input().props.onChangeText('https://nubamk.com.br'));
    await press(r, 'Verificar');
    expect(texts(r)).toContain('Perigo');
    expect(texts(r)).toContain('Este endereço imita nubank.com.br');
    await act(async () => input().props.onChangeText('nubank.com.br'));
    await press(r, 'Verificar');
    const t = texts(r);
    expect(t).toContain('Seguro');
    expect(t).toContain('Certificado SSL');
    expect(t).toContain('DigiCert Inc • DigiCert TLS RSA');
    expect(t).toContain('Expira em');
    await act(async () => input().props.onChangeText('http://nubank.com.br'));
    await press(r, 'Verificar');
    expect(texts(r)).toContain('HTTPS obrigatório');
    __setNetMocks({ tls: null });
  });

  it('histórico de acessos: sucesso e falha com método, data/hora e aparelho; filtro "Só falhas"', async () => {
    const at = new Date().toISOString();
    await vaultDb.put('accessLog', { id: 'ok1', at, method: 'biometric', success: true, device: 'Pixel 8 • Wi-Fi' }, { silent: true });
    await vaultDb.put('accessLog', { id: 'f1', at, method: 'password', success: false, detail: 'Senha mestra incorreta', device: 'Pixel 8 • Wi-Fi' }, { silent: true });
    const { r } = await render(AccessLogScreen);
    let t = texts(r);
    expect(t).toContain('Acesso permitido');
    expect(t).toContain('Tentativa de acesso falha');
    expect(t).toContain('Biometria');
    expect(t).toContain('Pixel 8 • Wi-Fi');
    expect(t).toMatch(/\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/);
    await press(r, 'Só falhas');
    t = texts(r);
    expect(t).not.toContain('Acesso permitido');
    expect(t).toContain('Senha mestra incorreta');
  });

  it('central de alertas: não lidos, abrir marca como lido e leva ao item; marcar todos', async () => {
    await AlertService.markRead();
    await AlertService.raise({ type: 'reused', severity: 'warning', title: 'Senha repetida no Facebook', message: 'Use uma senha única.', ref: fbId });
    await AlertService.raise({ type: 'login_failed', severity: 'warning', title: 'Tentativa de acesso falha em 03/11/2026 10:00', message: 'Senha mestra: incorreta.' });
    const { r, navigation } = await render(AlertsScreen);
    expect(texts(r)).toContain('Não lidos (2)');
    await press(r, /^Não lido\. Senha repetida no Facebook/);
    expect(navigation.navigate).toHaveBeenCalledWith('CredentialDetail', { id: fbId });
    expect(await AlertService.unreadCount()).toBe(1);
    await press(r, /^Não lido\. Tentativa de acesso falha/);
    expect(navigation.navigate).toHaveBeenCalledWith('AccessLog');
    await AlertService.raise({ type: 'ssl', severity: 'danger', title: 'Certificado inválido', message: 'x' });
    await flush();
    await press(r, 'Marcar todos como lidos');
    expect(await AlertService.unreadCount()).toBe(0);
    await press(r, 'Excluir alerta Certificado inválido');
    expect((await AlertService.list()).some(a => a.title === 'Certificado inválido')).toBe(false);
  });

  it('BDD "Senhas repetidas encontradas" e "Alteração de senha repetida" na tela de duplicatas; mesclar contas', async () => {
    const { r, navigation } = await render(DuplicatesScreen);
    let t = texts(r);
    expect(t).toContain('Senhas Reutilizadas');
    expect(t).toContain('Facebook');
    expect(t).toContain('Instagram');
    expect(t).toContain('Contas repetidas');
    await press(r, 'Trocar senha');
    expect(navigation.navigate).toHaveBeenCalledWith('CredentialEdit', { id: expect.any(String) });

    // Mesclar: confirma no diálogo
    const spy = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      buttons?.find(b => b.style === 'destructive')?.onPress?.();
    });
    await press(r, 'Mesclar');
    await flush();
    spy.mockRestore();
    expect((await Repo.credentials()).filter(c => c.title.startsWith('Banco'))).toHaveLength(1);

    // Troca a senha do Facebook para uma única: a seção some
    const fb = (await Repo.credential(fbId))!;
    await Repo.saveCredential({ ...fb, password: 'Unica#Nova!2026zq' });
    await flush();
    t = texts(r);
    expect(t).not.toContain('Senhas Reutilizadas');
    expect(t).toContain('Nenhuma duplicata');
  });

  it('classificação por risco: maior risco primeiro, com nota e motivos', async () => {
    const { r, navigation } = await render(RiskScreen);
    const t = texts(r);
    expect(t).toContain('Crítico:');
    expect(t.indexOf('Fórum antigo')).toBeLessThan(t.indexOf('Facebook'));
    expect(t).toMatch(/Senha vazada \(encontrada 37\.359\.195 vezes\)/);
    await press(r, /^Fórum antigo: risco/);
    expect(navigation.navigate).toHaveBeenCalledWith('CredentialDetail', { id: leakedId });
  });

  it(': aviso de dicionário no cadastro; o gerador não mostra o aviso para a senha gerada', async () => {
    const { r } = await render(CredentialEditScreen, {});
    const field = (label: string) => r.root.findAll(n => n.props.accessibilityLabel?.startsWith(label) && n.props.onChangeText && typeof n.type === 'string')[0];
    await act(async () => field('Senha').props.onChangeText('Flamengo2024!'));
    expect(texts(r)).toContain('Senha de dicionário');
    expect(texts(r)).toContain("Encontrada em dicionário: 'flamengo' + 2024!");
    await act(async () => field('Senha').props.onChangeText('x9#Lq!v2Tz$8mWp&Rk4e'));
    expect(texts(r)).not.toContain('Senha de dicionário');

    const g = await render(GeneratorScreen);
    expect(texts(g.r)).not.toContain('Senha de dicionário');
  });

  it('o histórico registra o desbloqueio feito pelas telas (evento AUTH_ATTEMPT)', async () => {
    AccessLogService.init();
    const p = (await Vault.getProfile())!;
    await expect(Vault.verifyPassword(p.id, 'errada-errada')).rejects.toThrow();
    await AccessLogService.idle();
    expect((await AccessLogService.list({ onlyFailures: true })).some(e => e.detail === 'Senha mestra incorreta' && e.id !== 'f1')).toBe(true);
    AccessLogService._stop();
  });
});
