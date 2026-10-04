// Cópia segura
// Marca o conteúdo como sensível (oculta a pré-visualização/notificação no Android 13+) e limpa a
// área de transferência após 30 s (configurável) ou quando o app é minimizado.

import { AppState } from 'react-native';
import { System } from '../native';
import { Vault } from './VaultService';
import { bus, Events, toast } from './events';

export const CLIPBOARD_EVENT = 'clipboard';

export interface ClipboardState {
  label: string;
  expiresAt: number;
}

let lastCopied: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let state: ClipboardState | null = null;

function publish(s: ClipboardState | null) {
  state = s;
  bus.emit(CLIPBOARD_EVENT, s);
}

AppState.addEventListener('change', s => {
  if (s !== 'active') ClipboardService.clearNow();
});
// Ao bloquear o cofre (manual, inatividade ou sensor) a senha copiada também é apagada
bus.on(Events.LOCKED, () => {
  ClipboardService.clearNow();
});

export const ClipboardService = {
  /** Copia o texto. Conteúdo sensível (senhas) é limpo automaticamente. */
  async copy(text: string, label: string, sensitive = true) {
    await System.setClipboard(text, sensitive);
    const fem = /^(senha|url|nota|chave|frase)\b|a$/i.test(label.trim().split(' ')[0]);
    if (!sensitive) {
      toast(`${label} ${fem ? 'copiada' : 'copiado'}`, 'success');
      return;
    }
    lastCopied = text;
    if (timer) clearTimeout(timer);
    const secs = Vault.settings.clipboardSeconds || 30;
    timer = setTimeout(() => ClipboardService.clearNow(), secs * 1000);
    publish({ label, expiresAt: Date.now() + secs * 1000 });
    // Texto do cenário BDD: "Senha copiada, será apagada em breve" (a contagem fica no indicador)
    toast(fem ? `${label} copiada, será apagada em breve` : `${label} copiado, será apagado em breve`, 'success');
  },

  async clearNow() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (state) publish(null);
    if (lastCopied) {
      const t = lastCopied;
      lastCopied = null;
      await System.clearClipboardIf(t).catch(() => {});
    }
  },

  get state(): ClipboardState | null {
    return state;
  },
};
