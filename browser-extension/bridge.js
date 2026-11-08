// Custódia Connect: cliente do canal com o app (usado pelo service worker e pela página de opções)
// Guarda o endereço do celular em storage.local e a sessão (sid + chave AES não exportável) no IndexedDB.
// Nenhuma senha é guardada: cada senha é pedida ao app na hora e precisa de "Permitir" no celular.
const CustodiaBridge = (() => {
  const api = typeof browser !== 'undefined' ? browser : chrome;
  const P = self.CustodiaProtocol;
  const DEFAULT_ADDRESS = '127.0.0.1:17865';
  /** Pedidos que esperam a confirmação no celular (60 s no app) ganham uma folga. */
  const APPROVAL_TIMEOUT = 75000;
  const QUICK_TIMEOUT = 8000;

  // ---------------------------------------------------------------------------
  // Armazenamento
  // ---------------------------------------------------------------------------
  function db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('custodia-connect', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idb(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  }

  const loadSession = async () => {
    const s = await idb('readonly', st => st.get('session'));
    return s && s.expiresAt > Date.now() ? s : null;
  };
  const saveSession = s => idb('readwrite', st => st.put(s, 'session'));
  const clearSession = () => idb('readwrite', st => st.delete('session'));

  /** "192.168.0.10:17865" ou "127.0.0.1:17865". Só IPv4 ou localhost, com porta. */
  function parseAddress(value) {
    const v = String(value || '').trim() || DEFAULT_ADDRESS;
    const m = v.match(/^(localhost|\d{1,3}(?:\.\d{1,3}){3})(?::(\d{2,5}))?$/);
    if (!m || (m[1] !== 'localhost' && m[1].split('.').some(n => Number(n) > 255))) throw new Error('Endereço inválido. Use, por exemplo, 192.168.0.10:17865.');
    const port = Number(m[2] || 17865);
    if (port < 1024 || port > 65535) throw new Error('Porta inválida.');
    return { host: m[1], port };
  }

  async function address() {
    const { address: a } = await api.storage.local.get('address');
    return a || parseAddress(DEFAULT_ADDRESS);
  }

  const isLoopback = host => host === '127.0.0.1' || host === 'localhost';

  /** Fora do loopback, a extensão precisa de permissão para o IP do celular (pedida no clique de Parear). */
  async function ensurePermission(addr) {
    if (isLoopback(addr.host)) return;
    const origins = [`http://${addr.host}:${addr.port}/*`];
    const granted = (await api.permissions.contains({ origins })) || (await api.permissions.request({ origins }));
    if (!granted) throw new Error('Permissão de acesso ao endereço do celular negada.');
  }

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------
  async function call(path, body, timeout = QUICK_TIMEOUT) {
    const addr = await address();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetch(`http://${addr.host}:${addr.port}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch {
      throw new Error(`App Custódia não encontrado em ${addr.host}:${addr.port}. Desbloqueie o cofre e ligue a extensão em Ajustes › Extensão de navegador.`);
    } finally {
      clearTimeout(timer);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Erro ${res.status}`);
      err.code = data.code;
      throw err;
    }
    return data;
  }

  async function status() {
    try {
      return await call('/v1/status');
    } catch {
      return null;
    }
  }

  /** Pareamento completo. `onCode(code)` mostra o código enquanto o celular espera a confirmação. */
  async function pair(name, onCode) {
    await ensurePermission(await address());
    const { state, message } = await P.beginPairing(name);
    const reply = await call('/v1/pair/start', message);
    const { code, message: finish } = await P.codeFor(state, reply);
    onCode(`${code.slice(0, 3)} ${code.slice(3)}`);
    const result = await call('/v1/pair/finish', finish, APPROVAL_TIMEOUT);
    const session = await P.finishPairing(state, result);
    await saveSession({ ...session, name, pairedAt: Date.now() });
    return session;
  }

  async function rpc(payload, timeout = QUICK_TIMEOUT) {
    const session = await loadSession();
    if (!session) throw new Error('Extensão não pareada. Abra as opções e clique em Parear.');
    const { nonce, body } = await P.sealRequest(session, payload);
    let enc;
    try {
      enc = await call('/v1/rpc', body, timeout);
    } catch (e) {
      // Sessão revogada ou vencida no celular: esquece a chave local
      if (e.code === 'session' || e.code === 'auth') await clearSession();
      throw e;
    }
    const msg = await P.openResponse(session, enc, nonce);
    if (msg.error) throw new Error(msg.error);
    return msg;
  }

  async function forget() {
    try {
      await rpc({ op: 'revoke' });
    } finally {
      await clearSession();
    }
  }

  return {
    api,
    DEFAULT_ADDRESS,
    parseAddress,
    address,
    setAddress: async value => api.storage.local.set({ address: parseAddress(value) }),
    session: loadSession,
    status,
    pair,
    ping: () => rpc({ op: 'ping' }),
    list: url => rpc({ op: 'list', url }),
    get: (url, credentialId) => rpc({ op: 'get', url, credentialId }, APPROVAL_TIMEOUT),
    forget,
  };
})();
if (typeof self !== 'undefined') self.CustodiaBridge = CustodiaBridge;
