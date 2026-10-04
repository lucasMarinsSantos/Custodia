// Tela de desbloqueio: senha mestra (teclado seguro opcional) e biometria com fallback
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Banner, Button, Icon } from '../../components/ui';
import { MasterPasswordInput } from '../../components/MasterPasswordInput';
import { Colors, Type } from '../../theme';
import { Vault } from '../../services/VaultService';
import { IntegrityService } from '../../services/IntegrityService';
import { Security } from '../../native';
import { useApp } from '../../context/AppState';
import { AppSettings, Profile } from '../../types/models';

export default function LoginScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const { lockReason } = useApp();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [hint, setHint] = useState<string | null>(null);
  const [bioReady, setBioReady] = useState(false);
  const [bioLocked, setBioLocked] = useState(false);
  const [integrity, setIntegrity] = useState<'ok' | 'mismatch' | 'unknown'>('unknown');
  const [lockoutSecs, setLockoutSecs] = useState(0);
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    // Alguns pulsos para chamar a atenção (animação infinita gastaria bateria)
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.12, duration: 1500, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 1500, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
      { iterations: 3 },
    );
    anim.start();
    return () => anim.stop();
  }, [pulse]);

  const refreshLockout = useCallback(async (id: string) => {
    const lo = await Vault.getLockout(id);
    setLockoutSecs(Math.max(0, Math.ceil((lo.lockedUntil - Date.now()) / 1000)));
    setBioLocked((await Vault.biometricLockedUntil(id)) > 0);
  }, []);

  const unlockBiometric = useCallback(
    async (id?: string) => {
      const pid = id || profile?.id;
      if (!pid) return;
      setError(null);
      try {
        const dek = await Vault.verifyBiometric(pid);
        await Vault.completeUnlock(pid, dek, 'biometric');
      } catch (e: any) {
        setError(e.message);
        await refreshLockout(pid);
      }
    },
    [profile, refreshLockout],
  );

  useEffect(() => {
    (async () => {
      const p = await Vault.getProfile();
      if (!p) return;
      setProfile(p);
      const s = await Vault.loadSettings(p.id);
      setSettings(s);
      const hasBio = s.biometricEnabled && (await Security.hasBiometricKey(`bio_${p.id}`).catch(() => false));
      setBioReady(!!hasBio);
      setIntegrity(await IntegrityService.checkFile(p.id));
      await refreshLockout(p.id);
      const locked = (await Vault.biometricLockedUntil(p.id)) > 0;
      if (hasBio && !locked) setTimeout(() => unlockBiometric(p.id), 400);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (lockoutSecs <= 0) return;
    const t = setInterval(() => setLockoutSecs(s => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [lockoutSecs]);

  const unlockPassword = async () => {
    // Evita tentativas em paralelo (Enter repetido no teclado físico, toques rápidos)
    if (!profile || !password || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const dek = await Vault.verifyPassword(profile.id, password);
      setPassword('');
      await Vault.completeUnlock(profile.id, dek, 'password');
    } catch (e: any) {
      setError(e.message);
      await refreshLockout(profile.id);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const canBio = bioReady && !bioLocked;

  return (
    <ScrollView style={styles.root} contentContainerStyle={[styles.content, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
      <View style={styles.brandBox}>
        <View style={styles.logo}>
          <Icon name="shield" size={30} color="#fff" />
        </View>
        <Text style={Type.h1}>Custódia</Text>
        <Text style={[Type.small, styles.mt4]}>Gerenciador de senhas seguro</Text>
      </View>

      {lockReason ? <Banner tone="info" icon="lock" text={`Cofre bloqueado: ${lockReason}.`} /> : null}
      {integrity === 'mismatch' ? (
        <Banner tone="warning" title="Verificação de integridade" text="O arquivo do banco cifrado mudou desde o último registro. O conteúdo será verificado após o desbloqueio." />
      ) : null}

      <TouchableOpacity
        style={styles.bio}
        onPress={() => (canBio ? unlockBiometric() : null)}
        activeOpacity={canBio ? 0.7 : 1}
        accessibilityRole="button"
        accessibilityLabel="Desbloquear com biometria"
        accessibilityState={{ disabled: !canBio }}
      >
        <Animated.View style={[styles.bioRing, !canBio && styles.ringOff, { transform: [{ scale: canBio ? pulse : 1 }] }]} />
        <View style={[styles.bioInner, !canBio && styles.dim]}>
          <Icon name={canBio ? 'aperture' : 'lock'} size={40} color={Colors.primaryDark} />
        </View>
      </TouchableOpacity>
      <Text style={[Type.small, styles.subtitle]}>
        {canBio ? 'Toque no sensor ou digite sua senha mestra' : bioLocked ? 'Biometria desativada temporariamente, use a senha mestra' : 'Digite sua senha mestra'}
      </Text>

      <MasterPasswordInput value={password} onChange={setPassword} secureKeyboard={!!settings?.secureKeyboard} onSubmit={unlockPassword} />
      {error ? <Banner tone="danger" icon="alert-circle" text={error} /> : null}
      {lockoutSecs > 0 ? <Banner tone="warning" icon="clock" text={`Bloqueio temporário após várias falhas. Tente novamente em ${lockoutSecs}s.`} /> : null}
      <Button title="Desbloquear" icon="unlock" onPress={unlockPassword} loading={busy} disabled={!password || lockoutSecs > 0} />

      <View style={styles.links}>
        <TouchableOpacity hitSlop={10} accessibilityRole="button" onPress={async () => profile && setHint((await Vault.getHint(profile.id)) || 'Nenhuma dica cadastrada.')}>
          <Text style={styles.link}>Ver dica</Text>
        </TouchableOpacity>
        <TouchableOpacity hitSlop={10} accessibilityRole="link" onPress={() => navigation.navigate('Recovery', { profileId: profile?.id })}>
          <Text style={styles.link}>Esqueceu a senha?</Text>
        </TouchableOpacity>
      </View>
      {hint ? (
        <Text style={[Type.small, styles.hint]} accessibilityLiveRegion="polite">
          Dica: {hint}
        </Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  content: { paddingHorizontal: 22 },
  brandBox: { alignItems: 'center', marginBottom: 20 },
  mt4: { marginTop: 4 },
  logo: { width: 60, height: 60, borderRadius: 18, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  bio: { width: 170, height: 170, alignSelf: 'center', alignItems: 'center', justifyContent: 'center', marginVertical: 8 },
  bioRing: { position: 'absolute', width: 170, height: 170, borderRadius: 85, borderWidth: 3, borderColor: Colors.primaryLight },
  bioInner: { width: 104, height: 104, borderRadius: 52, backgroundColor: Colors.primarySoft, borderWidth: 2, borderColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  dim: { opacity: 0.5 },
  ringOff: { opacity: 0.4 },
  subtitle: { textAlign: 'center', marginBottom: 22 },
  links: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 16 },
  link: { color: Colors.primary, fontWeight: '700', fontSize: 14 },
  hint: { marginTop: 10, textAlign: 'center' },
});
