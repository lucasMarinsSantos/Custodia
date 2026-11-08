module.exports = {
  root: true,
  // Regras do SonarJS (as mesmas do SonarQube para JS/TS), sem precisar de servidor Sonar
  extends: ['@react-native', 'plugin:sonarjs/recommended'],
  plugins: ['sonarjs'],
  overrides: [
    {
      // A criptografia depende de operações bit a bit (AES-GCM, PBKDF2, RNG sem viés).
      files: ['src/crypto/**', 'src/services/VaultService.ts', 'src/__tests__/crypto.test.ts'],
      rules: { 'no-bitwise': 'off' },
    },
    {
      // Testes e scripts: o SonarQube os trata como código de teste (fora do "main"), onde
      // repetir literais e ter fluxos longos e lineares é esperado.
      files: ['src/__tests__/**', 'scripts/**', 'jest.setup.js', '__mocks__/**'],
      rules: {
        'sonarjs/no-duplicate-string': 'off',
        'sonarjs/cognitive-complexity': 'off',
        'sonarjs/no-nested-template-literals': 'off',
      },
    },
  ],
};
