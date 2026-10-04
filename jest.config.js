module.exports = {
  preset: '@react-native/jest-preset',
  setupFiles: ['<rootDir>/jest/setup.js'],
  moduleNameMapper: {
    '^@op-engineering/op-sqlite$': '<rootDir>/jest/opSqliteMock.js',
  },
  transformIgnorePatterns: ['node_modules/(?!(@react-native|react-native|@react-navigation|@noble)/)'],
  testPathIgnorePatterns: ['/node_modules/', '/android/'],
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/__tests__/**', '!src/data/**'],
  // Cobertura mínima de 80% nos serviços de criptografia
  coverageThreshold: {
    './src/crypto/': { statements: 80, branches: 80, functions: 80, lines: 80 },
    './src/services/VaultService.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
    './src/services/IntegrityService.ts': { statements: 80, lines: 80 },
    './src/db/Database.ts': { statements: 80, lines: 80 },
  },
};
