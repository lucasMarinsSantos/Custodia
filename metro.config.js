const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
// Porta própria (8082) para não usar por engano o Metro de outro projeto React Native aberto na 8081.
// A mesma porta está em android/gradle.properties (reactNativeDevServerPort).
const config = { server: { port: 8082 } };

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
