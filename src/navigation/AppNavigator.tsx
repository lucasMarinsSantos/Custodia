// Navegação
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createStackNavigator, CardStyleInterpolators } from '@react-navigation/stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/Feather';
import { useApp } from '../context/AppState';
import { Colors } from '../theme';
import { Loading } from '../components/ui';

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
import AlertsScreen from '../screens/security/AlertsScreen';
import AccessLogScreen from '../screens/security/AccessLogScreen';
import BreachReportScreen from '../screens/security/BreachReportScreen';
import DuplicatesScreen from '../screens/security/DuplicatesScreen';
import RiskScreen from '../screens/security/RiskScreen';
import UrlCheckScreen from '../screens/security/UrlCheckScreen';

import SettingsScreen from '../screens/settings/SettingsScreen';
import SecuritySettingsScreen from '../screens/settings/SecuritySettingsScreen';
import ChangePasswordScreen from '../screens/settings/ChangePasswordScreen';
import RecoveryOptionsScreen from '../screens/settings/RecoveryOptionsScreen';
import AboutScreen from '../screens/settings/AboutScreen';
import SyncScreen from '../screens/settings/SyncScreen';
import PasswordAgeSettingsScreen from '../screens/settings/PasswordAgeSettingsScreen';

// notas seguras e formulários
import NotesScreen from '../screens/notes/NotesScreen';
import NoteDetailScreen from '../screens/notes/NoteDetailScreen';
import NoteEditScreen from '../screens/notes/NoteEditScreen';
import FormsScreen from '../screens/forms/FormsScreen';
import FormEditScreen from '../screens/forms/FormEditScreen';
import ImportExportScreen from '../screens/settings/ImportExportScreen';
import BackupScreen from '../screens/settings/BackupScreen';
// Integrações: preenchimento automático, extensão de navegador
import AutofillScreen from '../screens/settings/AutofillScreen';
import BrowserExtensionScreen from '../screens/settings/BrowserExtensionScreen';
import AutofillRequestScreen from '../screens/autofill/AutofillRequestScreen';
import { IntegrationHost } from '../components/IntegrationHost';
import { navigationRef } from './navigationRef';
import TwoFactorScreen from '../screens/settings/TwoFactorScreen';
import ProfilesScreen from '../screens/settings/ProfilesScreen';
import FolderRulesScreen from '../screens/vault/FolderRulesScreen';

const Stack = createStackNavigator();
const Tab = createBottomTabNavigator();

const TABS = [
  { name: 'Vault', component: VaultScreen, icon: 'key', label: 'Cofre' },
  { name: 'Generator', component: GeneratorScreen, icon: 'refresh-cw', label: 'Gerador' },
  { name: 'Notes', component: NotesScreen, icon: 'file-text', label: 'Notas' },
  { name: 'Security', component: SecurityScreen, icon: 'shield', label: 'Saúde das Senhas' },
  { name: 'Settings', component: SettingsScreen, icon: 'settings', label: 'Ajustes' },
];

function TabIcon({ icon, label, focused }: { icon: string; label: string; focused: boolean }) {
  return (
    <View style={styles.tab}>
      <View style={[styles.tabPill, focused && styles.tabPillActive]}>
        <Icon name={icon} size={21} color={focused ? Colors.primary : Colors.textTertiary} />
      </View>
      <Text style={[styles.tabLabel, focused && styles.tabLabelActive]} maxFontSizeMultiplier={1.3} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
        {label}
      </Text>
    </View>
  );
}

// Funções estáveis (fora do render) para o tabBarIcon.
const TAB_ICONS: Record<string, (p: { focused: boolean }) => React.ReactNode> = Object.fromEntries(
  TABS.map(t => [t.name, ({ focused }: { focused: boolean }) => <TabIcon icon={t.icon} label={t.label} focused={focused} />]),
);

function MainTabs() {
  const insets = useSafeAreaInsets();
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarShowLabel: false,
        tabBarStyle: {
          height: 66 + insets.bottom,
          paddingTop: 8,
          paddingBottom: insets.bottom + 6,
          backgroundColor: Colors.surface,
          borderTopColor: Colors.borderLight,
          elevation: 12,
        },
      }}
    >
      {TABS.map(t => (
        <Tab.Screen
          key={t.name}
          name={t.name}
          component={t.component}
          options={{
            tabBarAccessibilityLabel: t.label,
            tabBarIcon: TAB_ICONS[t.name],
          }}
        />
      ))}
    </Tab.Navigator>
  );
}

const MAIN_SCREENS: Record<string, React.ComponentType<any>> = {
  CredentialDetail: CredentialDetailScreen,
  CredentialEdit: CredentialEditScreen,
  History: HistoryScreen,
  Folders: FoldersScreen,
  SecuritySettings: SecuritySettingsScreen,
  ChangePassword: ChangePasswordScreen,
  RecoveryOptions: RecoveryOptionsScreen,
  About: AboutScreen,
  ImportExport: ImportExportScreen,
  Backup: BackupScreen,
  GeneratorModal: GeneratorScreen,
  Sync: SyncScreen,
  NoteDetail: NoteDetailScreen,
  NoteEdit: NoteEditScreen,
  Forms: FormsScreen,
  FormEdit: FormEditScreen,
  PasswordAgeSettings: PasswordAgeSettingsScreen,
  // segurança
  Alerts: AlertsScreen,
  AccessLog: AccessLogScreen,
  BreachReport: BreachReportScreen,
  Duplicates: DuplicatesScreen,
  Risk: RiskScreen,
  UrlCheck: UrlCheckScreen,
  Autofill: AutofillScreen,
  BrowserExtension: BrowserExtensionScreen,
  AutofillRequest: AutofillRequestScreen,
  TwoFactor: TwoFactorScreen,
  Profiles: ProfilesScreen,
  FolderRules: FolderRulesScreen,
};

const theme = { ...DefaultTheme, colors: { ...DefaultTheme.colors, background: Colors.background, primary: Colors.primary } };

export default function AppNavigator() {
  const { status, recoveryCode } = useApp();

  if (status === 'loading') {
    return (
      <View style={styles.loading}>
        <Loading text="Abrindo o cofre…" />
      </View>
    );
  }

  return (
    <NavigationContainer theme={theme} ref={navigationRef}>
      <Stack.Navigator
        screenOptions={{
          headerShown: false,
          cardStyle: { backgroundColor: Colors.background },
          cardStyleInterpolator: CardStyleInterpolators.forHorizontalIOS,
          gestureEnabled: true,
        }}
      >
        {status === 'unlocked' ? (
          <>
            {recoveryCode ? <Stack.Screen name="RecoverySetup" component={RecoverySetupScreen} /> : null}
            <Stack.Screen name="Main" component={MainTabs} />
            {Object.entries(MAIN_SCREENS).map(([name, component]) => (
              <Stack.Screen key={name} name={name} component={component} />
            ))}
          </>
        ) : status === 'setup' ? (
          <>
            <Stack.Screen name="Welcome" component={WelcomeScreen} />
            <Stack.Screen name="Setup" component={SetupScreen} />
          </>
        ) : (
          <>
            <Stack.Screen name="Login" component={LoginScreen} />
            <Stack.Screen name="Recovery" component={RecoveryScreen} />
          </>
        )}
      </Stack.Navigator>
      {status === 'unlocked' ? <IntegrationHost /> : null}
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, justifyContent: 'center', backgroundColor: Colors.background },
  tab: { alignItems: 'center', width: 72 }, // 5 abas cabem em 360 dp
  tabPill: { width: 56, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  tabPillActive: { backgroundColor: Colors.primarySoft },
  tabLabel: { fontSize: 11, marginTop: 2, fontWeight: '500', color: Colors.textTertiary },
  tabLabelActive: { fontWeight: '800', color: Colors.primary },
});
