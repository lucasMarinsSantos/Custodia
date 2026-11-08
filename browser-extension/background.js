// Custódia Connect: service worker: fala com o app (o popup pode fechar enquanto o celular espera a confirmação),
// preenche a aba e limpa a área de transferência depois de copiar.
if (typeof importScripts === 'function') importScripts('protocol.js', 'bridge.js');

const api = CustodiaBridge.api;
const CLEAR_ALARM = 'custodia-clear-clipboard';
const CLEAR_DELAY = 30000;

/** Limpa a área de transferência (Chrome: documento offscreen; Firefox: a própria página de fundo). */
async function clearClipboard() {
  if (api.offscreen) {
    const has = api.runtime.getContexts ? (await api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0 : false;
    if (!has) await api.offscreen.createDocument({ url: 'offscreen.html', reasons: ['CLIPBOARD'], justification: 'Limpar a senha copiada após 30 s' });
    await api.runtime.sendMessage({ type: 'custodia:offscreen-clear' });
    await api.offscreen.closeDocument().catch(() => {});
    return;
  }
  if (typeof document !== 'undefined') {
    const onCopy = e => {
      e.clipboardData.setData('text/plain', '');
      e.preventDefault();
    };
    document.addEventListener('copy', onCopy);
    document.execCommand('copy');
    document.removeEventListener('copy', onCopy);
  }
}

if (api.alarms) {
  api.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === CLEAR_ALARM) clearClipboard().catch(() => {});
  });
}

/**
 * Função injetada na aba (scripting.executeScript, só com activeTab): preenche usuário e senha se a página
 * ainda estiver no mesmo endereço do pedido. Roda isolada do JavaScript da página.
 */
function fillInPage(expectedOrigin, username, password) {
  if (location.origin !== expectedOrigin) return { filled: false, reason: 'A página mudou de endereço. Tente de novo.' };
  const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const inputs = [...document.querySelectorAll('input')].filter(i => visible(i) && !i.disabled && !i.readOnly);
  const pw = inputs.find(i => i.type === 'password' && !/new-password/.test(i.autocomplete));
  const textLike = i => ['email', 'text', 'tel', ''].includes(i.type);
  let user = inputs.find(i => textLike(i) && /user|login|mail|conta|cpf|usuario|identifier|account/i.test(`${i.name} ${i.id} ${i.autocomplete} ${i.placeholder}`));
  if (!user && pw) user = inputs.slice(0, inputs.indexOf(pw)).reverse().find(textLike);
  const set = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  if (user && username) set(user, username);
  if (pw && password) set(pw, password);
  return { filled: !!(user || pw), reason: user || pw ? '' : 'Nenhum campo de login encontrado nesta página.' };
}

async function fill(tabId, url, id) {
  const cred = await CustodiaBridge.get(url, id);
  const [res] = await api.scripting.executeScript({ target: { tabId }, func: fillInPage, args: [new URL(url).origin, cred.username, cred.password] });
  const out = res && res.result;
  if (!out || !out.filled) throw new Error((out && out.reason) || 'Não foi possível preencher.');
  return { ok: true };
}

async function copy(url, id) {
  const cred = await CustodiaBridge.get(url, id);
  // O popup é quem escreve na área de transferência (precisa de foco); aqui só agenda a limpeza
  if (api.alarms) api.alarms.create(CLEAR_ALARM, { when: Date.now() + CLEAR_DELAY });
  else setTimeout(() => clearClipboard().catch(() => {}), CLEAR_DELAY);
  return { ok: true, password: cred.password };
}

const handlers = {
  'custodia:list': msg => CustodiaBridge.list(msg.url),
  'custodia:fill': msg => fill(msg.tabId, msg.url, msg.id),
  'custodia:copy': msg => copy(msg.url, msg.id),
};

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Só as páginas da própria extensão (popup/opções) conversam com o service worker
  if (sender.id !== api.runtime.id || sender.tab) return false;
  const handler = msg && handlers[msg.type];
  if (!handler) return false;
  handler(msg)
    .then(r => sendResponse({ ok: true, ...r }))
    .catch(e => sendResponse({ ok: false, error: e.message }));
  return true;
});
