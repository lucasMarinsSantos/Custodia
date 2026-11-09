// Ciclo de vida das integrações com outros apps
//  • Desbloqueio: envia o índice de sugestões ao serviço de acessibilidade, abre a ponte da extensão (se ligada),
//    busca o pedido de preenchimento pendente e as trocas de senha percebidas.
//  • Bloqueio: apaga o índice e os pedidos, fecha a ponte e nega as confirmações abertas.
//  • Dados ou ajustes mudaram: atualiza o índice e a ponte.

import { AppState } from 'react-native';
import { onIntegrationEvent } from '../native/integration';
import { AutofillService } from './AutofillService';
import { BrowserBridgeService } from './BrowserBridgeService';
import { Vault } from './VaultService';
import { bus, Events, toast } from './events';
import { afterIntegrityCheck } from './unlockGate';

let initialized = false;
let indexTimer: ReturnType<typeof setTimeout> | null = null;

const PW_CHANGE = 'troca de senha';
const REQUEST = 'pedido';

const warn = (where: string) => (e: unknown) => console.warn(`[Integração] ${where}`, e);

function scheduleIndex() {
  if (indexTimer) clearTimeout(indexTimer);
  indexTimer = setTimeout(() => {
    indexTimer = null;
    AutofillService.syncIndex().catch(warn('índice'));
  }, 300);
}

async function syncBridge() {
  try {
    await BrowserBridgeService.sync();
  } catch (e: any) {
    toast(e?.message || 'Não foi possível abrir a ponte com a extensão.', 'error');
  }
}

export const IntegrationController = {
  init() {
    if (initialized) return;
    initialized = true;

    bus.on(Events.UNLOCKED, () => {
      this.onUnlocked().catch(warn('desbloqueio'));
    });
    bus.on(Events.LOCKED, () => {
      if (indexTimer) clearTimeout(indexTimer);
      AutofillService.onLocked().catch(warn('bloqueio'));
      BrowserBridgeService.stop().catch(warn('ponte'));
    });
    bus.on(Events.SETTINGS_CHANGED, () => {
      if (!Vault.isUnlocked) return;
      scheduleIndex();
      syncBridge();
    });
    bus.on(Events.DATA_CHANGED, () => {
      if (Vault.isUnlocked) scheduleIndex();
    });

    onIntegrationEvent('CustodiaAutofill', ev => {
      if (ev?.type === 'request') AutofillService.checkPendingRequest().catch(warn(REQUEST));
      if (ev?.type === 'passwordChange') AutofillService.processPasswordChanges().catch(warn(PW_CHANGE));
    });
    onIntegrationEvent('CustodiaBrowser', ev => {
      BrowserBridgeService.handleEvent(ev).catch(warn('extensão'));
    });

    // Voltando ao app (ex.: aberto pelo balão do Custódia em outro app)
    AppState.addEventListener('change', s => {
      if (s !== 'active') return;
      AutofillService.checkPendingRequest().catch(warn(REQUEST));
      if (Vault.isUnlocked) AutofillService.processPasswordChanges().catch(warn(PW_CHANGE));
    });
    // App aberto a frio pelo serviço: o pedido fica guardado até o desbloqueio
    AutofillService.checkPendingRequest().catch(warn(REQUEST));
  },

  async onUnlocked() {
    await AutofillService.syncIndex().catch(warn('índice'));
    await syncBridge();
    // Preencher um pedido pendente e aplicar trocas de senha gravam no banco: espera a verificação de integridade
    await afterIntegrityCheck();
    await AutofillService.checkPendingRequest().catch(warn(REQUEST));
    await AutofillService.processPasswordChanges().catch(warn(PW_CHANGE));
  },
};
