// Custódia Connect: protocolo do canal com o app (Web Crypto, sem dependências)
//
// Versão gêmea de `src/services/BridgeProtocol.ts` (app). As duas são testadas uma contra a outra no Jest
// (`src/__tests__/integracao-extensao.test.ts`): qualquer mudança aqui precisa ser repetida lá.
//
// Pareamento (código de 6 dígitos comparado no celular, sem segredo digitado):
//   1. start:  envia { v, name, commit = SHA-256(rótulo|commit ‖ pkE ‖ nE) }
//   2. o app responde { pairId, pk = pkP, nonce = nP }
//   3. a extensão calcula o código = SHA-256(rótulo|sas ‖ pkE ‖ pkP ‖ nE ‖ nP) mod 10⁶, mostra na tela e envia
//      finish { pairId, pk = pkE, nonce = nE }; o celular mostra o mesmo código e o usuário confirma.
//   4. chave = HKDF-SHA256(ECDH P-256, sal = nE ‖ nP, info = rótulo|key); o app prova que tem a mesma chave
//      com HMAC(chave, rótulo|paired|sid|expiresAt). A chave AES fica não exportável (CryptoKey).
// Pedidos: { sid, iv, ct } com AES-256-GCM e dado associado "rótulo|req|sid"; respostas com "rótulo|res|sid"
// e o nonce do pedido em `re`.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CustodiaProtocol = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const VERSION = 1;
  const LABEL = 'custodia-bridge-v1';
  const subtle = () => globalThis.crypto.subtle;
  const random = n => globalThis.crypto.getRandomValues(new Uint8Array(n));
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const b64 = bytes => {
    let s = '';
    const arr = new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return btoa(s);
  };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const label = suffix => enc.encode(`${LABEL}|${suffix}`);
  const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };
  const sha256 = async data => new Uint8Array(await subtle().digest('SHA-256', data));

  /** Base64 com tamanho exato (resposta da rede). */
  function exact(value, bytes, what) {
    if (typeof value !== 'string' || value.length > 200 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error(`${what} inválido`);
    const out = unb64(value);
    if (out.length !== bytes) throw new Error(`${what} inválido`);
    return out;
  }

  function publicKey(value) {
    const pk = exact(value, 65, 'Chave pública');
    if (pk[0] !== 4) throw new Error('Chave pública inválida');
    return pk;
  }

  async function commitment(pkE, nE) {
    return sha256(concat(label('commit'), pkE, nE));
  }

  async function pairingCode(pkE, pkP, nE, nP) {
    const h = await sha256(concat(label('sas'), pkE, pkP, nE, nP));
    const n = ((h[0] * 256 + h[1]) * 256 + h[2]) * 256 + h[3];
    return String(n % 1000000).padStart(6, '0');
  }

  /** Passo 1: gera o par ECDH e o nonce; devolve o estado (fica só na memória) e a mensagem de início. */
  async function beginPairing(name) {
    const keyPair = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const pk = new Uint8Array(await subtle().exportKey('raw', keyPair.publicKey));
    const nonce = random(16);
    const commit = await commitment(pk, nonce);
    return {
      state: { keyPair, pk, nonce },
      message: { v: VERSION, name: String(name || 'Navegador').slice(0, 40), commit: b64(commit) },
    };
  }

  /** Passo 2: com a resposta do app, calcula o código a mostrar e a mensagem de conclusão. */
  async function codeFor(state, reply) {
    if (!reply || reply.v !== VERSION || typeof reply.pairId !== 'string' || reply.pairId.length > 64) throw new Error('Resposta de pareamento inválida');
    state.peerPk = publicKey(reply.pk);
    state.peerNonce = exact(reply.nonce, 16, 'Nonce');
    state.pairId = reply.pairId;
    const code = await pairingCode(state.pk, state.peerPk, state.nonce, state.peerNonce);
    return { code, message: { pairId: reply.pairId, pk: b64(state.pk), nonce: b64(state.nonce) } };
  }

  /** Passo 3: deriva a chave da sessão e confere a prova do app. Devolve a sessão (chave AES não exportável). */
  async function finishPairing(state, result) {
    if (!result || typeof result.sid !== 'string' || !/^[\w-]{8,64}$/.test(result.sid) || typeof result.expiresAt !== 'number') {
      throw new Error('Resposta de pareamento inválida');
    }
    const peer = await subtle().importKey('raw', state.peerPk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: peer }, state.keyPair.privateKey, 256));
    const ikm = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveBits']);
    shared.fill(0);
    const raw = new Uint8Array(
      await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: concat(state.nonce, state.peerNonce), info: label('key') }, ikm, 256),
    );
    try {
      const mac = await subtle().importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
      const proofOk =
        typeof result.proof === 'string' &&
        (await subtle().verify('HMAC', mac, exact(result.proof, 32, 'Prova'), label(`paired|${result.sid}|${result.expiresAt}`)));
      if (!proofOk) throw new Error('O app não comprovou a chave. Pareamento cancelado.');
      const key = await subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
      return { sid: result.sid, expiresAt: result.expiresAt, key };
    } finally {
      raw.fill(0);
    }
  }

  /** Cifra um pedido: acrescenta horário e nonce únicos. */
  async function sealRequest(session, payload) {
    const nonce = b64(random(18));
    const iv = random(12);
    const plain = enc.encode(JSON.stringify({ ...payload, ts: Date.now(), nonce }));
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: label(`req|${session.sid}`) }, session.key, plain);
    return { nonce, body: { sid: session.sid, iv: b64(iv), ct: b64(ct) } };
  }

  /** Decifra a resposta e confere que ela responde a este pedido. */
  async function openResponse(session, body, nonce) {
    const iv = exact(body && body.iv, 12, 'Resposta');
    if (typeof body.ct !== 'string' || body.ct.length > 100000) throw new Error('Resposta inválida');
    let plain;
    try {
      plain = await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: label(`res|${session.sid}`) }, session.key, unb64(body.ct));
    } catch {
      throw new Error('Resposta do app não autenticada.');
    }
    const msg = JSON.parse(dec.decode(plain));
    if (!msg || msg.re !== nonce) throw new Error('Resposta não corresponde ao pedido.');
    return msg;
  }

  return { VERSION, LABEL, b64, unb64, commitment, pairingCode, beginPairing, codeFor, finishPairing, sealRequest, openResponse };
});
