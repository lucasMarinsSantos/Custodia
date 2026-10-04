// Ciclo de vida do cofre
//  • Ao desbloquear: inicia o monitor de sessão e a verificação de integridade
//  • Ao bloquear: grava o hash do conteúdo e, com o banco fechado, o hash do arquivo cifrado

import { AppState } from 'react-native';
import { bus, Events } from './events';
import { IntegrityService } from './IntegrityService';
import { IconService } from './IconService';
import { SessionService } from './SessionService';
import { Vault } from './VaultService';

let initialized = false;

export const AppController = {
  init() {
    if (initialized) return;
    initialized = true;

    Vault.onBeforeLock(async () => {
      await IntegrityService.flush();
    });
    Vault.onAfterClose(profileId => IntegrityService.recordFileHash(profileId));

    bus.on(Events.UNLOCKED, () => {
      this.onUnlocked().catch(e => console.warn('[App] onUnlocked', e));
    });

    bus.on(Events.LOCKED, () => {
      IntegrityService.stop();
      IconService.resetMemory();
    });

    // App indo para segundo plano: registra o hash imediatamente (o processo pode ser encerrado)
    AppState.addEventListener('change', s => {
      if (s !== 'active' && Vault.isUnlocked) IntegrityService.flush().catch(() => {});
    });
  },

  async onUnlocked() {
    SessionService.start();
    IntegrityService.start();
    await IntegrityService.checkAfterUnlock().catch(e => console.warn('[Integrity]', e));
    bus.emit(Events.INTEGRITY_CHECKED);
  },
};
