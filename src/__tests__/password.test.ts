// Gerador, regras da senha mestra e força das senhas
import { DefaultPasswordOptions, PasswordService } from '../services/PasswordService';
import { MasterPasswordPolicy } from '../services/VaultService';
import { AnalysisService, findReused } from '../services/AnalysisService';
import { newCredential } from '../services/Repository';

const opts = (o: Partial<typeof DefaultPasswordOptions>) => ({ ...DefaultPasswordOptions, ...o });

describe('Gerador de senhas', () => {
  it('BDD: padrão gera 16 caracteres com maiúsculas, minúsculas, números e símbolos', () => {
    expect(DefaultPasswordOptions.length).toBe(16);
    for (let i = 0; i < 50; i++) {
      const p = PasswordService.generate();
      expect(p).toHaveLength(16);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[^A-Za-z0-9]/);
    }
  });
  it('BDD: sem "Símbolos especiais" gera apenas letras e números', () => {
    for (let i = 0; i < 50; i++) expect(PasswordService.generate(opts({ symbols: false }))).toMatch(/^[A-Za-z0-9]+$/);
  });
  it('BDD: controle deslizante em 32 gera exatamente 32 caracteres (e respeita 8–64)', () => {
    expect(PasswordService.generate(opts({ length: 32 }))).toHaveLength(32);
    expect(PasswordService.generate(opts({ length: 8 }))).toHaveLength(8);
    expect(PasswordService.generate(opts({ length: 64 }))).toHaveLength(64);
  });
  it('evita caracteres ambíguos quando solicitado', () => {
    for (let i = 0; i < 50; i++) expect(PasswordService.generate(opts({ length: 40, avoidAmbiguous: true }))).not.toMatch(/[O0oIl1|`'"]/);
  });
  it('apenas uma classe e nenhuma classe (cai para minúsculas)', () => {
    expect(PasswordService.generate(opts({ uppercase: false, lowercase: false, symbols: false, numbers: true }))).toMatch(/^[0-9]+$/);
    expect(PasswordService.generate(opts({ uppercase: false, lowercase: false, symbols: false, numbers: false }))).toMatch(/^[a-z]+$/);
  });
  it('gera senhas pronunciáveis com o comprimento pedido', () => {
    const p = PasswordService.generate(opts({ numbers: false, symbols: false, avoidAmbiguous: false, pronounceable: true }));
    expect(p).toHaveLength(16);
    expect(p.toLowerCase()).toMatch(/^([bcdfghjklmnprstvz][aeiou][bcdfghjklmnprstvz]?)+/);
    const q = PasswordService.generate(opts({ length: 20, pronounceable: true }));
    expect(q).toHaveLength(20);
    expect(q).toMatch(/[0-9]/);
  });
  it('pronunciável respeita todas as opções (sem símbolo/número desligados, caixa, ambíguos, comprimento)', () => {
    for (let i = 0; i < 100; i++) {
      const semSimbolo = PasswordService.generate(opts({ length: 16, symbols: false, numbers: true, pronounceable: true }));
      expect(semSimbolo).toHaveLength(16);
      expect(semSimbolo).not.toMatch(/[^A-Za-z0-9]/);
      expect((semSimbolo.match(/[0-9]/g) || []).length).toBe(2);
      const comSimbolo = PasswordService.generate(opts({ length: 12, symbols: true, numbers: false, pronounceable: true }));
      expect(comSimbolo).toHaveLength(12);
      expect(comSimbolo).toMatch(/[^A-Za-z0-9]$/);
      expect(PasswordService.generate(opts({ length: 20, lowercase: false, pronounceable: true }))).not.toMatch(/[a-z]/);
      expect(PasswordService.generate(opts({ length: 30, uppercase: true, avoidAmbiguous: true, pronounceable: true }))).not.toMatch(/[O0oIl1|`'"]/);
    }
  });
  it('senhas geradas são diferentes entre si (RNG criptográfico)', () => {
    const set = new Set(Array.from({ length: 200 }, () => PasswordService.generate()));
    expect(set.size).toBe(200);
  });
});

describe('Política da senha mestra', () => {
  it('BDD: 6 caracteres → "A senha deve conter pelo menos 12 caracteres"', () => {
    expect(MasterPasswordPolicy.error('Ab1!xy')).toBe('A senha deve conter pelo menos 12 caracteres');
    expect(MasterPasswordPolicy.isValid('Ab1!xy')).toBe(false);
  });
  it('exige maiúsculas, minúsculas, número e símbolo', () => {
    expect(MasterPasswordPolicy.error('semmaiusculas1!')).toMatch(/maiúsculas/);
    expect(MasterPasswordPolicy.error('SemNumeroAqui!!')).toMatch(/número/);
    expect(MasterPasswordPolicy.error('SemSimbolo12345')).toMatch(/símbolo/);
    expect(MasterPasswordPolicy.error('Cofre#Seguro2026')).toBeNull();
    expect(MasterPasswordPolicy.isValid('Cofre#Seguro2026')).toBe(true);
  });
  it('rejeita senhas comuns', () => {
    expect(MasterPasswordPolicy.isCommon('password')).toBe(true);
    expect(MasterPasswordPolicy.isCommon('')).toBe(false);
  });
});

describe('Força das senhas', () => {
  it('detecta padrões fracos', () => {
    expect(PasswordService.analyze('').strength).toBe('critical');
    expect(PasswordService.analyze('123456').strength).toBe('critical');
    expect(PasswordService.analyze('qwerty2024').patterns).toContain('teclado');
    expect(PasswordService.analyze('aaaaaa').patterns).toContain('repetição');
    expect(PasswordService.analyze('abc12345').patterns).toContain('sequência');
    expect(PasswordService.analyze('Senha@123').patterns).toContain('palavra comum');
    expect(PasswordService.analyze('maria1990').patterns).toContain('data');
    expect(['strong', 'very_strong']).toContain(PasswordService.analyze('x9#Lq!v2Tz$8mWp&Rk4e').strength);
    expect(PasswordService.entropyBits('')).toBe(0);
  });
  it('BDD: senha "123456" é marcada como fraca no relatório', () => {
    const fraca = newCredential({ id: 'a', title: 'Fórum', password: '123456' });
    const forte = newCredential({ id: 'b', title: 'Banco', password: 'x9#Lq!v2Tz$8mWp&Rk4e' });
    const r = AnalysisService.report([fraca, forte]);
    expect(r.weak.map(c => c.id)).toEqual(['a']);
    expect(r.short.map(c => c.id)).toEqual(['a']);
    expect(r.recommendations[0].credentialId).toBe('a');
    expect(r.strongPercent).toBe(50);
    expect(r.total).toBe(2);
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(100);
  });
  it('detecta senhas repetidas em serviços diferentes (não no mesmo domínio)', () => {
    const a = newCredential({ id: '1', title: 'A', url: 'a.com', password: 'Repetida#2026x' });
    const b = newCredential({ id: '2', title: 'B', url: 'b.com', password: 'Repetida#2026x' });
    const c = newCredential({ id: '3', title: 'A2', url: 'login.a.com', password: 'Outra#Senha99z' });
    const d = newCredential({ id: '4', title: 'A3', url: 'www.a.com', password: 'Outra#Senha99z' });
    expect(findReused([a, b, c, d]).map(g => g.map(x => x.id))).toEqual([['1', '2']]);
    const r = AnalysisService.report([a, b]);
    expect(r.recommendations.filter(x => x.id.startsWith('reuse:'))).toHaveLength(2);
  });
  it('cofre vazio tem pontuação máxima e nenhum alerta', () => {
    const r = AnalysisService.report([]);
    expect(r.score).toBe(100);
    expect(r.total).toBe(0);
    expect(r.recommendations).toEqual([]);
  });
});
