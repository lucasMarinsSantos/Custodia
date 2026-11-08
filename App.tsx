// Custódia: gerenciador de senhas para Android
import React from 'react';
import { StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import AppNavigator from './src/navigation/AppNavigator';
import { AppStateProvider } from './src/context/AppState';
import { ClipboardIndicator, ToastHost } from './src/components/widgets';
import { AppController } from './src/services/AppController';
import { SessionService } from './src/services/SessionService';
import { ErrorBoundary } from './src/components/ErrorBoundary';

AppController.init();

const App: React.FC = () => {
  return (
    <GestureHandlerRootView style={styles.flex}>
      <SafeAreaProvider>
        <StatusBar barStyle="dark-content" />
        <AppStateProvider>
          <View style={styles.flex} onTouchStart={() => SessionService.activity()}>
            <ErrorBoundary>
              <AppNavigator />
            </ErrorBoundary>
            <ClipboardIndicator />
            <ToastHost />
          </View>
        </AppStateProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
};

const styles = StyleSheet.create({ flex: { flex: 1 } });

export default App;
