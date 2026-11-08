// Ciclo de vida do cofre
//  • Ao desbloquear: inicia o monitor de sessão e a verificação de integridade
//  • Ao bloquear: grava o hash do conteúdo e, com o banco fechado, o hash do arquivo cifrado

import { AppState } from 'react-native';
import { bus, Events } from './events';
import { IntegrityService } from './IntegrityService';
import { AlertService } from './AlertService';
import { ExpiryService } from './ExpiryService';
import { Files } from '../native/files';
import { BackupService } from './BackupService';
import { IconService } from './IconService';
import { SessionService } from './SessionService';
import { Vault } from './VaultService';
import { SyncService } from './SyncService';
import { SecurityMonitor } from './SecurityMonitor';
import { IntegrationController } from './IntegrationController';

let initialized = false;

export const AppController = {
  init() {
    if (initialized) return;
    initialized = true;
    // histórico de acessos, notificações e verificação automática de vazamentos
    SecurityMonitor.init();
    // verifica o backup automático quando o app volta ao primeiro plano
    BackupService.init();

    Vault.onBeforeLock(async () => {
      await IntegrityService.flush();
    });
    Vault.onAfterClose(profileId => IntegrityService.recordFileHash(profileId));
    // Sincronização: push/pull no desbloqueio, periódico com o cofre aberto e parada ao bloquear
    SyncService.init();
    // Preenchimento automático, arrastar e extensão de navegador
    IntegrationController.init();

    bus.on(Events.UNLOCKED, () => {
      this.onUnlocked().catch(e => console.warn('[App] onUnlocked', e));
    });

    bus.on(Events.LOCKED, () => {
      IntegrityService.stop();
      IconService.resetMemory();
      ExpiryService.stopDaily();
      // temporários (exportações, anexos abertos, imagens) não sobrevivem ao bloqueio
      Files.wipeTemp().catch(e => console.warn('[Arquivos] limpeza dos temporários', e));
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
    await AlertService.flushPending().catch(e => console.warn('[Alertas]', e));
    // vencidas ficam inativas e geram alertas; repete uma vez por dia com o cofre aberto
    await ExpiryService.sweep().catch(e => console.warn('[Validade]', e));
    ExpiryService.startDaily();
    // restos de uma sessão encerrada à força (processo morto antes do bloqueio)
    await Files.wipeTemp().catch(e => console.warn('[Arquivos] limpeza dos temporários', e));
    // backup automático vencido (nunca lança; a falha vira alerta "backup")
    await BackupService.autoBackupIfDue();
  },
};
