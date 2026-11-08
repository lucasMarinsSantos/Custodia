// Categorização, ícones personalizados e utilitários
import { CategoryService } from '../services/CategoryService';
import { GLYPHS, ICON_COLORS, IconService } from '../services/IconService';
import { Vault } from '../services/VaultService';
import { System } from '../native';
import { daysBetween, formatDate, hostnameOf, normalizeUrl, registrableDomain, stripAccents, timeAgo } from '../utils';

jest.setTimeout(60000);

describe('Categorização inteligente', () => {
  it('classifica pelo domínio conhecido (alta confiança)', () => {
    expect(CategoryService.suggest('https://www.nubank.com.br/login', '')).toMatchObject({ category: 'finance', confidence: 'alta' });
    expect(CategoryService.suggest('mail.google.com', '')).toMatchObject({ confidence: 'alta' });
    expect(CategoryService.lookup('https://github.com/x')?.category).toBe('development');
  });
  it('classifica pelo nome do serviço e sugere o site', () => {
    expect(CategoryService.suggest('', 'Netflix')).toMatchObject({ category: 'entertainment', confidence: 'alta' });
    expect(CategoryService.domainForName('Nubank')).toBe('nubank.com.br');
    expect(CategoryService.domainForName('x')).toBeNull();
    expect(CategoryService.domainForName('Serviço Inexistente')).toBeNull();
  });
  it('usa palavras-chave quando o domínio não é conhecido', () => {
    expect(CategoryService.suggest('meubanco-digital.com', 'Banco Digital')).toMatchObject({ category: 'finance', confidence: 'média' });
    expect(CategoryService.suggest('portal.escola.edu', '')).toMatchObject({ category: 'education' });
    expect(CategoryService.suggest('', 'Zzz')).toMatchObject({ category: 'other', confidence: 'baixa' });
    expect(CategoryService.count()).toBeGreaterThan(50);
  });
});

describe('Ícones personalizados', () => {
  beforeAll(async () => {
    await Vault.createVault({ masterPassword: 'Icones#Cofre2026' });
  });
  it('oferece glifos e cores para personalização', () => {
    expect(GLYPHS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(ICON_COLORS).size).toBe(ICON_COLORS.length);
  });
  it('baixa o logo do site uma vez e guarda no banco cifrado', async () => {
    const png = 'iVBORw0KGgo' + 'A'.repeat(400);
    const dl = jest.spyOn(System, 'download').mockResolvedValue({ base64: png, mime: 'image/png' });
    const logo = await IconService.logoFor('https://www.github.com/login');
    expect(logo).toBe(`data:image/png;base64,${png}`);
    expect(IconService.cached('github.com')).toBe(logo);
    IconService.resetMemory();
    expect(await IconService.logoFor('github.com')).toBe(logo); // vem do banco, sem novo download
    expect(dl).toHaveBeenCalledTimes(1);
    expect(await IconService.count()).toBe(1);
    // Sem internet: nenhum logo, sem erro
    dl.mockResolvedValue(null);
    expect(await IconService.refresh('github.com')).toBeNull();
    expect(await IconService.logoFor('', true)).toBeNull();
    dl.mockRestore();
  });
});

describe('Utilitários', () => {
  it('URLs e domínios', () => {
    expect(hostnameOf('https://user@www.Exemplo.com.br:8080/a?b')).toBe('exemplo.com.br');
    expect(hostnameOf('')).toBe('');
    expect(registrableDomain('login.itau.com.br')).toBe('itau.com.br');
    expect(registrableDomain('a.b.github.com')).toBe('github.com');
    expect(registrableDomain('10.0.0.1')).toBe('10.0.0.1');
    expect(normalizeUrl('exemplo.com')).toBe('https://exemplo.com');
    expect(normalizeUrl('http://x.com')).toBe('http://x.com');
    expect(normalizeUrl('  ')).toBe('');
  });
  it('datas em pt-BR', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate('inválida')).toBe('—');
    expect(formatDate(new Date(2026, 8, 5, 14, 7).toISOString(), true)).toBe('05/09/2026 14:07');
    expect(timeAgo(null)).toBe('nunca');
    expect(timeAgo(new Date().toISOString())).toBe('agora');
    expect(timeAgo(new Date(Date.now() - 5 * 60000).toISOString())).toBe('há 5 min');
    expect(timeAgo(new Date(Date.now() - 3 * 3600000).toISOString())).toBe('há 3 h');
    expect(timeAgo(new Date(Date.now() - 86400000).toISOString())).toBe('há 1 dia');
    expect(timeAgo(new Date(Date.now() - 10 * 86400000).toISOString())).toBe('há 10 dias');
    expect(timeAgo(new Date(Date.now() - 40 * 86400000).toISOString())).toBe('há 1 mês');
    expect(timeAgo(new Date(Date.now() - 400 * 86400000).toISOString())).toBe('há 1 ano');
    expect(daysBetween(new Date(Date.now() - 2 * 86400000))).toBe(2);
    expect(stripAccents('Ação')).toBe('Acao');
  });
});
