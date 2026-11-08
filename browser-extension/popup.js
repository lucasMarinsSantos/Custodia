// Custódia Connect: popup: lista os logins do site atual (sem senhas) e pede a senha ao app só no clique,
// com confirmação no celular.
const api = CustodiaBridge.api;
const $ = id => document.getElementById(id);
let tab;

function message(text, ok = false) {
  $('msg').hidden = !text;
  $('msg').textContent = text || '';
  $('msg').className = ok ? 'msg ok' : 'msg';
  $('msg').setAttribute('role', ok ? 'status' : 'alert');
}

const send = msg => api.runtime.sendMessage(msg);

function setBusy(buttons, busy) {
  buttons.forEach(b => {
    b.disabled = busy;
  });
}

function item(c) {
  const el = document.createElement('li');
  el.className = 'item';
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = (c.title || '?')[0].toUpperCase();
  const meta = document.createElement('div');
  meta.className = 'meta';
  const title = document.createElement('b');
  title.textContent = c.title;
  const user = document.createElement('span');
  user.textContent = c.username || '(sem usuário)';
  meta.append(title, user);

  const fill = document.createElement('button');
  fill.type = 'button';
  fill.textContent = 'Preencher';
  fill.setAttribute('aria-label', `Preencher login de ${c.title}${c.username ? ` (${c.username})` : ''}`);
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'ghost';
  copy.textContent = 'Copiar';
  copy.title = 'Copiar senha (limpa em 30 s)';
  copy.setAttribute('aria-label', `Copiar senha de ${c.title}`);

  fill.onclick = async () => {
    setBusy([fill, copy], true);
    message('Confirme o pedido no celular (toque em Permitir)…', true);
    const r = await send({ type: 'custodia:fill', tabId: tab.id, url: tab.url, id: c.id });
    setBusy([fill, copy], false);
    if (!r?.ok) return message(r?.error || 'Não foi possível preencher.');
    window.close();
  };
  copy.onclick = async () => {
    setBusy([fill, copy], true);
    message('Confirme o pedido no celular (toque em Permitir)…', true);
    const r = await send({ type: 'custodia:copy', url: tab.url, id: c.id });
    setBusy([fill, copy], false);
    if (!r?.ok) return message(r?.error || 'Não foi possível copiar.');
    try {
      await navigator.clipboard.writeText(r.password);
      message('Senha copiada. A área de transferência será limpa em 30 s.', true);
    } catch {
      message('Não foi possível copiar a senha.');
    }
  };
  el.append(avatar, meta, fill, copy);
  return el;
}

async function load() {
  message('');
  $('list').textContent = '';
  [tab] = await api.tabs.query({ active: true, currentWindow: true });
  try {
    $('domain').textContent = new URL(tab.url).hostname;
  } catch {
    $('domain').textContent = '—';
  }
  const st = await CustodiaBridge.status();
  $('dot').className = st ? 'dot ok' : 'dot';
  $('state').textContent = st ? 'conectado' : 'app offline';
  if (!(await CustodiaBridge.session())) return message('Extensão não pareada. Clique em "Pareamento".');
  if (!/^https?:/.test(tab.url || '')) return message('Abra um site para ver os logins salvos.');
  $('list').setAttribute('aria-busy', 'true');
  const r = await send({ type: 'custodia:list', url: tab.url });
  $('list').setAttribute('aria-busy', 'false');
  if (!r?.ok) return message(r?.error || 'Não foi possível consultar o app.');
  if (r.warning) message(r.warning);
  if (!r.items.length) {
    const li = document.createElement('li');
    li.className = 'card muted';
    li.textContent = `Nenhum login salvo para ${r.domain}.`;
    $('list').append(li);
    return;
  }
  r.items.forEach(c => $('list').append(item(c)));
}

$('refresh').onclick = load;
$('options').onclick = () => api.runtime.openOptionsPage();
load().catch(e => message(e.message));
