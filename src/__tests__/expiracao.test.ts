// (validade e contador de uso), (sugestão de troca por idade) e (últimas 10 senhas)
import { Vault } from '../services/VaultService';
import { MAX_PASSWORD_HISTORY, Repo, newCredential, newFolder, pushPasswordHistory } from '../services/Repository';
import { ExpiryService, DEFAULT_MAX_AGE_DAYS } from '../services/ExpiryService';
import { AlertService } from '../services/AlertService';
import { AppController } from '../services/AppController';
import { IntegrityService } from '../services/IntegrityService';
import { SessionService } from '../services/SessionService';
import { vaultDb } from '../db/Database';
import { Credential } from '../types/models';

jest.setTimeout(120000);

const DAY = 86400000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

beforeAll(async () => {
  await Vault.createVault({ masterPassword: 'Cofre#Seguro2026' });
});

afterEach(() => ExpiryService.stopDaily());

async function clearAll() {
  await vaultDb.clearCollection('credentials');
  await vaultDb.clearCollection('alerts');
  await vaultDb.clearCollection('folders');
  await vaultDb.setKv('expiry:alerted', '{}');
}

describe('BDD Expiração de credenciais', () => {
  beforeEach(clearAll);

  it('Cenário: Definir validade de senha, salva e mostra o tempo restante', async () => {
    const c = await Repo.saveCredential(newCredential({ title: 'Banco', password: 'Senha#Forte2026', expiresAt: ExpiryService.addDays(90) }));
    const read = (await Repo.credential(c.id))!;
    expect(read.expiresAt).toBe(ExpiryService.addDays(90));
    expect(ExpiryService.daysLeft(read)).toBe(90);
    expect(ExpiryService.expiryLabel(read)).toBe('Vence em 90 dias');
    expect(ExpiryService.state(read)).toBe('valid');
    expect(ExpiryService.state({ expiresAt: ExpiryService.addDays(3) })).toBe('expiring');
    expect(ExpiryService.expiryLabel({ expiresAt: ExpiryService.addDays(1) })).toBe('Vence amanhã');
    expect(ExpiryService.expiryLabel({ expiresAt: null })).toBe('Sem data de validade');
  });

  it('Cenário: Credencial expirada, fica inativa ao abrir o app e gera um alerta (sem repetir)', async () => {
    const c = await Repo.saveCredential(newCredential({ title: 'Portal antigo', password: 'Senha#Forte2026', expiresAt: ExpiryService.addDays(-2) }));
    expect(ExpiryService.expiryLabel(c)).toBe('Venceu há 2 dias');
    const r1 = await ExpiryService.sweep();
    expect(r1).toMatchObject({ inactivated: 1, expired: 1, alerts: 1 });
    expect((await Repo.credential(c.id))!.inactive).toBe(true);
    const alerts = await AlertService.list();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: 'expired', severity: 'danger', title: 'Credencial vencida', ref: c.id });
    expect(alerts[0].message).toContain('Atualize a senha');

    // Mesmo lido, o alerta não volta na próxima varredura (no dia seguinte)
    await AlertService.markRead();
    const r2 = await ExpiryService.sweep(Date.now() + 2 * DAY);
    expect(r2.alerts).toBe(0);
    expect(await AlertService.list()).toHaveLength(1);
    expect(await ExpiryService.lastSweep()).toBeTruthy();
  });

  it('reativar ao renovar: data nova no futuro devolve a credencial ao estado ativo', async () => {
    const c = await Repo.saveCredential(newCredential({ title: 'Wi-Fi', password: 'Senha#Forte2026', expiresAt: ExpiryService.addDays(-1) }));
    await ExpiryService.sweep();
    const inactive = (await Repo.credential(c.id))!;
    expect(inactive.inactive).toBe(true);
    // Na edição: trocar a data por uma futura reativa
    expect(ExpiryService.applyRenewal({ ...inactive, expiresAt: ExpiryService.addDays(30) }).inactive).toBe(false);
    expect(ExpiryService.applyRenewal(inactive).inactive).toBe(true);
    const renewed = (await ExpiryService.renew(c.id, 90))!;
    expect(renewed.inactive).toBe(false);
    expect(ExpiryService.daysLeft(renewed)).toBe(90);
    // A troca de validade aparece no histórico de versões
    expect((await Repo.versions(c.id))[0].summary).toContain('validade');
    // A nova validade gera um alerta novo se vencer de novo (assinatura = data de validade)
    await Repo.saveCredential({ ...renewed, expiresAt: ExpiryService.addDays(-3) });
    expect((await ExpiryService.sweep()).alerts).toBe(1);
  });

  it('reativar ao salvar: mudar a data para o futuro ou trocar a senha reativa; outra edição não', async () => {
    const c = await Repo.saveCredential(newCredential({ title: 'ERP', password: 'Senha#Forte2026', expiresAt: ExpiryService.addDays(-1) }));
    await ExpiryService.sweep();
    let cur = (await Repo.credential(c.id))!;
    expect(cur.inactive).toBe(true);
    expect(ExpiryService.isActive(cur)).toBe(false);

    // Editar só as notas mantém inativa
    cur = await Repo.saveCredential({ ...cur, notes: 'nova nota' });
    expect(cur.inactive).toBe(true);
    // Data nova no futuro: reativa
    cur = await Repo.saveCredential({ ...cur, expiresAt: ExpiryService.addDays(30) });
    expect(cur.inactive).toBe(false);
    expect(ExpiryService.isActive(cur)).toBe(true);

    // Venceu de novo; agora o usuário troca a senha sem mexer na data: reativa e tira a validade vencida
    cur = await Repo.saveCredential({ ...cur, expiresAt: ExpiryService.addDays(-2) });
    await ExpiryService.sweep();
    cur = (await Repo.credential(c.id))!;
    expect(cur.inactive).toBe(true);
    cur = await Repo.saveCredential({ ...cur, password: 'Trocada#Nova2026' });
    expect(cur.inactive).toBe(false);
    expect(cur.expiresAt).toBeNull();
    expect((await ExpiryService.sweep()).inactivated).toBe(0);
  });

  it('fora do preenchimento automático: inativa ou vencida (mesmo antes da varredura) não é usada', () => {
    const base = newCredential({ title: 'X', password: 'p' });
    expect(ExpiryService.isActive(base)).toBe(true);
    expect(ExpiryService.isActive({ ...base, inactive: true })).toBe(false);
    expect(ExpiryService.isActive({ ...base, expiresAt: new Date(Date.now() - 1000).toISOString() })).toBe(false);
  });

  it('com "autoInactiveOnExpire" desligado a vencida só é destacada, sem ficar inativa', async () => {
    await Vault.updateSettings({ autoInactiveOnExpire: false });
    try {
      const c = await Repo.saveCredential(newCredential({ title: 'Loja', password: 'Senha#Forte2026', expiresAt: ExpiryService.addDays(-1) }));
      const r = await ExpiryService.sweep();
      expect(r.inactivated).toBe(0);
      expect((await Repo.credential(c.id))!.inactive).toBe(false);
      expect(ExpiryService.needsAttention(c, [])).toBe(true);
    } finally {
      await Vault.updateSettings({ autoInactiveOnExpire: true });
    }
  });

  it('datas digitadas: DD/MM/AAAA válida vira meia-noite local; datas impossíveis são recusadas', () => {
    const iso = ExpiryService.parseDate('15/03/2027')!;
    expect(new Date(iso).getDate()).toBe(15);
    expect(new Date(iso).getHours()).toBe(0);
    expect(ExpiryService.toInput(iso)).toBe('15/03/2027');
    for (const bad of ['31/02/2027', '00/01/2027', '1/1/2027', '10/13/2027', '01/01/1900', 'amanhã']) expect(ExpiryService.parseDate(bad)).toBeNull();
  });

  it('a varredura roda no desbloqueio (AppController.onUnlocked) e é agendada diariamente', async () => {
    const sweep = jest.spyOn(ExpiryService, 'sweep');
    const daily = jest.spyOn(ExpiryService, 'startDaily');
    const mocks = [
      jest.spyOn(SessionService, 'start').mockImplementation(() => {}),
      jest.spyOn(IntegrityService, 'start').mockImplementation(() => {}),
      jest.spyOn(IntegrityService, 'checkAfterUnlock').mockResolvedValue(undefined as any),
    ];
    try {
      await AppController.onUnlocked();
      expect(sweep).toHaveBeenCalledTimes(1);
      expect(daily).toHaveBeenCalledTimes(1);
    } finally {
      [sweep, daily, ...mocks].forEach(m => m.mockRestore());
    }
  });

  it('a varredura diária roda sozinha depois do intervalo', async () => {
    jest.useFakeTimers();
    const sweep = jest.spyOn(ExpiryService, 'sweep').mockResolvedValue({ inactivated: 0, expired: 0, old: 0, alerts: 0 });
    try {
      ExpiryService.startDaily(1000);
      jest.advanceTimersByTime(1001);
      expect(sweep).toHaveBeenCalledTimes(1);
      ExpiryService.stopDaily();
      jest.advanceTimersByTime(5000);
      expect(sweep).toHaveBeenCalledTimes(1);
    } finally {
      sweep.mockRestore();
      jest.useRealTimers();
    }
  });
});

describe('Contador de uso', () => {
  beforeEach(clearAll);

  it('"Vezes utilizada" conta as cópias; abrir o detalhe não muda o "Último uso"', async () => {
    const c = await Repo.saveCredential(newCredential({ title: 'Gmail', password: 'Senha#Forte2026' }));
    await Repo.touch(c.id);
    let read = (await Repo.credential(c.id))!;
    expect(read.usageCount).toBe(0);
    expect(read.lastUsageAt ?? null).toBeNull();
    await Repo.recordUsage(c.id);
    await Repo.recordUsage(c.id);
    read = (await Repo.credential(c.id))!;
    expect(read.usageCount).toBe(2);
    expect(read.lastUsageAt).toBeTruthy();
  });
});

describe('BDD Sugestão de troca por idade', () => {
  beforeEach(clearAll);

  const old = (title: string, age: number, extra: Partial<Credential> = {}) =>
    Repo.saveCredential(newCredential({ title, password: 'Senha#Forte2026', createdAt: daysAgo(age), ...extra }));

  it('idade da senha e prazo padrão de 90 dias: "Recomendamos trocar esta senha"', async () => {
    const c = await old('Antiga', 100);
    const fresh = await old('Nova', 10);
    expect(ExpiryService.passwordAgeDays(c)).toBe(100);
    expect(ExpiryService.ageLabel(100)).toBe('Senha alterada há 100 dias');
    expect(ExpiryService.ageLabel(1)).toBe('Senha alterada há 1 dia');
    expect(ExpiryService.ageLabel(0)).toBe('Senha alterada hoje');
    expect(ExpiryService.rotation(c, [])).toMatchObject({ ageDays: 100, maxAgeDays: DEFAULT_MAX_AGE_DAYS, source: 'default', needsChange: true });
    expect(ExpiryService.rotation(fresh, []).needsChange).toBe(false);

    const r = await ExpiryService.sweep();
    expect(r).toMatchObject({ old: 1, alerts: 1 });
    const [alert] = await AlertService.list();
    expect(alert).toMatchObject({ type: 'old', title: 'Recomendamos trocar esta senha', ref: c.id });
    // Não repete
    expect((await ExpiryService.sweep()).alerts).toBe(0);
    // Trocou a senha: sai da lista de antigas
    await Repo.saveCredential({ ...(await Repo.credential(c.id))!, password: 'Trocada#Agora2026' });
    const after = await ExpiryService.sweep();
    expect(after.old).toBe(0);
  });

  it('prazo próprio da credencial, regra da pasta (PolicyService) e ajuste padrão', async () => {
    const folder = { ...newFolder('Trabalho'), policy: { requireReauth: false, minStrength: null, maxAgeDays: 30, blockAutofill: false, blockExport: false, clipboardSeconds: null } };
    await Repo.saveFolder(folder);
    const folders = await Repo.folders();
    const own = await old('Própria', 100, { maxPasswordAgeDays: 120 });
    expect(ExpiryService.rotation(own, folders)).toMatchObject({ maxAgeDays: 120, source: 'credential', needsChange: false });
    const inFolder = await old('Na pasta', 40, { folderId: folder.id });
    expect(ExpiryService.rotation(inFolder, folders)).toMatchObject({ maxAgeDays: 30, source: 'folder', needsChange: true });
    // Pasta e credencial: vale o mais rígido
    const both = await old('Ambos', 40, { folderId: folder.id, maxPasswordAgeDays: 60 });
    expect(ExpiryService.maxAgeFor(both, folders)).toEqual({ days: 30, source: 'folder' });
    // Ajuste do usuário
    const plain = await old('Comum', 50);
    expect(ExpiryService.rotation(plain, folders, Date.now(), { passwordMaxAgeDays: 45 }).needsChange).toBe(true);
    // Valores absurdos (importação/sincronização) caem no padrão
    expect(ExpiryService.maxAgeFor({ ...plain, maxPasswordAgeDays: -5 }, folders, { passwordMaxAgeDays: NaN as any })).toEqual({ days: 90, source: 'default' });
  });

  it('destaque: vencidas e antigas separadas (vencida não aparece duas vezes)', async () => {
    const expired = await old('Vencida e antiga', 200, { expiresAt: ExpiryService.addDays(-1) });
    const aged = await old('Só antiga', 200);
    await old('Em dia', 5);
    const { expired: e, old: o } = ExpiryService.attention(await Repo.credentials(), []);
    expect(e.map(c => c.id)).toEqual([expired.id]);
    expect(o.map(c => c.id)).toEqual([aged.id]);
  });
});

describe('Últimas 10 senhas', () => {
  beforeEach(clearAll);

  it('empilha a anterior a cada troca, no máximo 10, a mais recente primeiro e sem a atual', async () => {
    let c = await Repo.saveCredential(newCredential({ title: 'Banco', password: 'Senha-00' }));
    expect(c.passwordHistory).toEqual([]);
    for (let i = 1; i <= 12; i++) c = await Repo.saveCredential({ ...c, password: `Senha-${String(i).padStart(2, '0')}` });
    const h = (await Repo.credential(c.id))!.passwordHistory;
    expect(h).toHaveLength(MAX_PASSWORD_HISTORY);
    expect(h.map(x => x.password)).toEqual(['Senha-11', 'Senha-10', 'Senha-09', 'Senha-08', 'Senha-07', 'Senha-06', 'Senha-05', 'Senha-04', 'Senha-03', 'Senha-02']);
    expect(h.every(x => !!Date.parse(x.changedAt))).toBe(true);
    // Editar sem trocar a senha não mexe no histórico
    c = await Repo.saveCredential({ ...c, notes: 'só uma nota' });
    expect(c.passwordHistory).toHaveLength(10);
    // Voltar para uma senha antiga: ela sai do histórico (não repete a atual) e a anterior entra no topo
    c = await Repo.saveCredential({ ...c, password: 'Senha-05' });
    expect(c.passwordHistory[0].password).toBe('Senha-12');
    expect(c.passwordHistory.map(x => x.password)).not.toContain('Senha-05');
    expect(new Set(c.passwordHistory.map(x => x.password)).size).toBe(c.passwordHistory.length);
  });

  it('a tela não consegue apagar o histórico mandando uma cópia vazia/desatualizada', async () => {
    let c = await Repo.saveCredential(newCredential({ title: 'Email', password: 'A-1' }));
    c = await Repo.saveCredential({ ...c, password: 'A-2' });
    c = await Repo.saveCredential({ ...c, password: 'A-3', passwordHistory: [] });
    expect(c.passwordHistory.map(x => x.password)).toEqual(['A-2', 'A-1']);
  });

  it('restaurar uma versão não perde entradas do histórico', async () => {
    let c = await Repo.saveCredential(newCredential({ title: 'Loja', password: 'P-A' }));
    c = await Repo.saveCredential({ ...c, password: 'P-B' });
    c = await Repo.saveCredential({ ...c, password: 'P-C' });
    expect(c.passwordHistory.map(x => x.password)).toEqual(['P-B', 'P-A']);
    const first = (await Repo.versions(c.id)).find(v => v.snapshot.password === 'P-A')!;
    expect(first.snapshot.passwordHistory).toEqual([]);
    const restored = await Repo.restoreVersion(first);
    expect(restored.password).toBe('P-A');
    // P-A voltou a ser a atual; P-C e P-B continuam disponíveis
    expect(restored.passwordHistory.map(x => x.password)).toEqual(['P-C', 'P-B']);
  });

  it('importação/sincronização: entradas inválidas ou longas demais são descartadas', () => {
    const bad: any[] = [{ password: 'ok', changedAt: daysAgo(1) }, { password: 'x'.repeat(600), changedAt: daysAgo(1) }, null, { password: 5 }, { password: 'ok', changedAt: daysAgo(2) }];
    expect(pushPasswordHistory(bad, '', 'atual', new Date().toISOString())).toEqual([{ password: 'ok', changedAt: bad[0].changedAt }]);
    expect(pushPasswordHistory(null as any, 'velha', 'atual', 'x')).toEqual([{ password: 'velha', changedAt: 'x' }]);
  });
});
