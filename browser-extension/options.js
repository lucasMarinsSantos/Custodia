// Custódia Connect: página de opções: endereço do celular, pareamento, teste e desconexão.
const $ = id => document.getElementById(id);
const say = (t, ok) => {
  $('msg').hidden = !t;
  $('msg').textContent = t || '';
  $('msg').className = ok ? 'msg ok' : 'msg';
};

function defaultName() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : 'Chrome';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : 'Linux';
  return `${browser} no ${os}`;
}

async function init() {
  const addr = await CustodiaBridge.address();
  $('address').value = `${addr.host}:${addr.port}`;
  $('name').value = defaultName();
  const s = await CustodiaBridge.session();
  if (s) say(`Pareada como "${s.name}" até ${new Date(s.expiresAt).toLocaleDateString('pt-BR')}.`, true);
}

$('pair').onclick = async () => {
  $('pair').disabled = true;
  $('code').hidden = true;
  try {
    await CustodiaBridge.setAddress($('address').value);
    say('Conectando ao celular…', true);
    await CustodiaBridge.pair($('name').value.trim() || defaultName(), code => {
      $('code').hidden = false;
      $('code').textContent = code;
      say('Confira se o celular mostra este mesmo código e toque em Permitir lá.', true);
    });
    $('code').hidden = true;
    say('Pareamento concluído. Abra um site e clique no ícone do Custódia.', true);
  } catch (e) {
    $('code').hidden = true;
    say(e.message);
  } finally {
    $('pair').disabled = false;
  }
};

$('test').onclick = async () => {
  try {
    await CustodiaBridge.setAddress($('address').value);
    const st = await CustodiaBridge.status();
    if (!st) return say('App Custódia não encontrado nesse endereço. O cofre precisa estar aberto e a extensão ligada no app.');
    const r = await CustodiaBridge.ping();
    say(`Conexão cifrada funcionando (sessão "${r.name}").`, true);
  } catch (e) {
    say(e.message);
  }
};

$('forget').onclick = async () => {
  try {
    await CustodiaBridge.forget();
    say('Desconectado: a sessão foi revogada no celular.', true);
  } catch (e) {
    say(`Sessão apagada só nesta extensão (${e.message}). Revogue também no celular, em Sessões ativas.`);
  }
};

init().catch(e => say(e.message));
