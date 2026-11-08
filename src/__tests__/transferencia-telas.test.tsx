// Telas de Ajustes › Importar e exportar e › Backup, e o OCR no cadastro
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { AppStateProvider } from '../context/AppState';
import { Vault } from '../services/VaultService';
import { Repo, newCredential } from '../services/Repository';
import { bus, Events } from '../services/events';
import { BackupService } from '../services/BackupService';
import { SessionService } from '../services/SessionService';
import { __queuePickedFile } from '../native/transfer';
import { __queueOcrResult } from '../native/ocr';
import { __backupMock } from '../native/backup';
import { toB64, utf8 } from '../crypto';

jest.mock('react-native-vector-icons/Feather', () => 'Icon');
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.setTimeout(180000);

import ImportExportScreen from '../screens/settings/ImportExportScreen';
import BackupScreen from '../screens/settings/BackupScreen';
import SettingsScreen from '../screens/settings/SettingsScreen';
import CredentialEditScreen from '../screens/vault/CredentialEditScreen';

const MASTER = 'Cofre#Seguro2026';
const flush = () => act(async () => new Promise(r => setTimeout(r, 120)));
const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
const toasts: { message: string; kind: string }[] = [];
bus.on(Events.TOAST, t => toasts.push(t));
const lastToast = () => toasts[toasts.length - 1];

afterEach(async () => {
  while (mounted.length) {
    const r = mounted.pop()!;
    await act(async () => r.unmount());
  }
  toasts.length = 0;
});

beforeAll(async () => {
  await Vault.createVault({ masterPassword: MASTER });
  await Repo.saveCredential(newCredential({ title: 'Nubank', username: 'lucas', password: 'Nu#Segura2026!', url: 'nubank.com.br' }));
  // Campo de senha comum (o teclado virtual seguro tem teste próprio)
  await Vault.updateSettings({ secureKeyboard: false });
});

afterAll(() => SessionService.stop());

function nav() {
  return { navigate: jest.fn(), goBack: jest.fn(), setParams: jest.fn(), dispatch: jest.fn(), addListener: jest.fn(() => () => {}) };
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

const press = async (r: ReactTestRenderer.ReactTestRenderer, label: string) => {
  const n = r.root.findAll(x => typeof x.type !== 'string' && x.props.onPress && (x.props.accessibilityLabel === label || x.props.title === label))[0];
  if (!n) throw new Error(`Botão não encontrado: ${label}`);
  await act(async () => {
    await n.props.onPress();
  });
  await flush();
};

/** Digita no único campo de senha visível (folha de senha). */
const typePassword = async (r: ReactTestRenderer.ReactTestRenderer, value: string) => {
  const field = r.root.findAll(n => typeof n.type === 'string' && n.props.onChangeText && n.props.secureTextEntry)[0];
  await act(async () => field.props.onChangeText(value));
};

const csvFile = (text: string) => ({ name: 'senhas.csv', mime: 'text/csv', size: text.length, base64: toB64(utf8(text)) });

describe('Ajustes', () => {
  it('mostra "Importar e exportar" e "Backup"', async () => {
    const { r, navigation } = await render(SettingsScreen);
    expect(texts(r)).toContain('Importar e exportar');
    await press(r, 'Backup');
    expect(navigation.navigate).toHaveBeenCalledWith('Backup');
  });
});

describe('Tela Importar e exportar', () => {
  it('BDD Importação de CSV válida: prévia com contagem e aviso "Importação concluída com sucesso"', async () => {
    const { r } = await render(ImportExportScreen);
    __queuePickedFile(csvFile('name,url,username,password\nGitHub,https://github.com,lucas,Git#Hub2026!\nNubank,https://nubank.com.br,lucas,Nu#Segura2026!\n'));
    await press(r, 'Importar arquivo CSV ou JSON');
    const t = texts(r);
    expect(t).toContain('Prévia da importação');
    expect(t).toContain('Duplicada');
    expect((await Repo.credentials()).some(c => c.title === 'GitHub')).toBe(false); // nada antes de confirmar
    await press(r, 'Importar 1');
    expect(lastToast()).toEqual({ kind: 'success', message: expect.stringMatching(/^Importação concluída com sucesso: 1 item adicionado, 1 duplicado ignorado/) });
    expect((await Repo.credentials()).some(c => c.title === 'GitHub')).toBe(true);
  });

  it('BDD Erro de formatação no CSV: exibe "Erro de formatação" e não grava nada', async () => {
    const before = (await Repo.credentials()).length;
    const { r } = await render(ImportExportScreen);
    __queuePickedFile(csvFile('foo;bar;baz\n1;2;3\n'));
    await press(r, 'Importar arquivo CSV ou JSON');
    expect(lastToast().kind).toBe('error');
    expect(lastToast().message).toMatch(/^Erro de formatação/);
    expect((await Repo.credentials()).length).toBe(before);
  });

  it('exportar em texto claro exige confirmar o risco e reautenticar', async () => {
    const { r } = await render(ImportExportScreen);
    await press(r, 'CSV legível');
    expect(texts(r)).toContain('Arquivo sem proteção');
    await press(r, 'Exportar');
    expect(lastToast()).toEqual({ kind: 'error', message: 'Confirme que entende o risco de exportar um arquivo legível' });
    const toggle = r.root.findAll(n => n.props.onValueChange && typeof n.type !== 'string')[0];
    await act(async () => toggle.props.onValueChange(true));
    await press(r, 'Exportar');
    expect(texts(r)).toContain('Confirme sua identidade');
    await typePassword(r, 'errada');
    await press(r, 'Confirmar e exportar');
    expect(lastToast()).toEqual({ kind: 'error', message: 'Senha mestra incorreta.' });
    // Senha certa: o arquivo vai para o seletor do sistema (no Jest, cancelado)
    await typePassword(r, MASTER);
    await press(r, 'Confirmar e exportar');
    expect(lastToast()).toEqual({ kind: 'info', message: 'Exportação cancelada' });
  });

  it('exportação cifrada recusa senha curta para o arquivo', async () => {
    const { r } = await render(ImportExportScreen);
    await press(r, 'Exportar');
    expect(lastToast().message).toMatch(/pelo menos 12 caracteres/);
    await press(r, 'Gerar senha temporária');
    await press(r, 'Exportar');
    expect(texts(r)).toContain('Confirme sua identidade');
  });

  it('importar por foto abre o cadastro com a câmera', async () => {
    const { r, navigation } = await render(ImportExportScreen);
    await press(r, 'Importar por foto');
    expect(navigation.navigate).toHaveBeenCalledWith('CredentialEdit', { scan: 'camera' });
  });
});

describe('Cadastro com OCR (BDD Importação por OCR)', () => {
  it('Captura bem-sucedida de texto impresso: "Usuário: admin / Senha: 123" preenche os campos', async () => {
    const { r } = await render(CredentialEditScreen, {});
    __queueOcrResult({ text: 'Usuário: admin / Senha: 123', confidence: 80, brightness: 150 });
    await press(r, 'Escanear texto com a câmera');
    const field = (label: string) => r.root.findAll(n => n.props.accessibilityLabel?.startsWith(label) && n.props.onChangeText && typeof n.type === 'string')[0];
    expect(field('Usuário').props.value).toBe('admin');
    expect(field('Senha').props.value).toBe('123');
    expect(lastToast().message).toMatch(/Revise antes de salvar/);
  });

  it('Foto em ambiente sem luz: sugere ativar o flash', async () => {
    const { r } = await render(CredentialEditScreen, {});
    __queueOcrResult({ text: '', confidence: 5, brightness: 10 });
    await press(r, 'Escanear texto com a câmera');
    expect(texts(r)).toContain('Ative o flash ou melhore a iluminação para reconhecer os caracteres');
  });
});

describe('Tela Backup', () => {
  beforeEach(() => __backupMock.reset());

  it('BDD Exportar arquivo de backup local: "Criar Backup" + senha mestra gera o arquivo .custodia', async () => {
    const { r } = await render(BackupScreen);
    expect(texts(r)).toContain('Nenhum backup no destino ainda.');
    await press(r, 'Criar Backup');
    await typePassword(r, MASTER);
    await press(r, 'Confirmar');
    expect(lastToast()).toEqual({ kind: 'success', message: expect.stringMatching(/^Backup criado: custodia-backup-.*\.custodia$/) });
    expect((await BackupService.list()).length).toBe(1);
  });

  it('BDD Restaurar de um backup com senha incorreta: exibe "Falha na descriptografia. Senha inválida."', async () => {
    const { json } = await BackupService.build();
    const { r } = await render(BackupScreen);
    __queuePickedFile({ name: 'b.custodia', mime: 'application/octet-stream', size: json.length, base64: toB64(utf8(json)) });
    await press(r, 'Restaurar Backup');
    expect(texts(r)).toContain('Abrir backup');
    await typePassword(r, 'SenhaIncorreta#1');
    await press(r, 'Abrir');
    expect(texts(r)).toContain('Falha na descriptografia. Senha inválida.');
    expect(lastToast()).toEqual({ kind: 'error', message: 'Falha na descriptografia. Senha inválida.' });
    // Com a senha certa: prévia e restauração confirmada
    await typePassword(r, MASTER);
    await press(r, 'Abrir');
    expect(texts(r)).toContain('Arquivo íntegro');
    const confirm = r.root.findAll(n => n.props.onValueChange && typeof n.type !== 'string').pop()!;
    await act(async () => confirm.props.onValueChange(true));
    await press(r, 'Restaurar agora');
    expect(lastToast().message).toMatch(/^Backup restaurado/);
  });
});
