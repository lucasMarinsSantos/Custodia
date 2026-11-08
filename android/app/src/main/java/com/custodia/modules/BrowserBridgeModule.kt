package com.custodia.modules

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECFieldFp
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import javax.crypto.KeyAgreement

/**
 * Servidor HTTP local da ponte com a extensão "Custódia Connect", `CustodiaBrowser`.
 *
 * Este módulo é só transporte e ECDH: não conhece as chaves das sessões nem as senhas. Ele confere o básico
 * (rota conhecida, Origin de extensão, tamanhos, conexões simultâneas), repassa o corpo, já cifrado pela
 * extensão, ao JS (`BrowserBridgeService.handleEvent`) e devolve a resposta que o JS mandar em [respond].
 * O protocolo está em `src/services/BridgeProtocol.ts` e `browser-extension/protocol.js`.
 *
 * Por padrão escuta só em 127.0.0.1 (USB com `adb forward`); com `lan`, em todas as interfaces (rede Wi-Fi).
 * O servidor só existe com o cofre aberto e a ponte ligada nos Ajustes (o JS chama [start]/[stop]).
 */
class BrowserBridgeModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  companion object {
    const val NAME = "CustodiaBrowser"
    private val EXTENSION_SCHEMES = listOf("chrome-extension://", "moz-extension://")
    private val ROUTES = setOf("GET /v1/status", "POST /v1/pair/start", "POST /v1/pair/finish", "POST /v1/rpc")
    private const val MAX_HEADER = 8 * 1024
    private const val MAX_BODY = 64 * 1024
    private const val MAX_CONNECTIONS = 8
    /** O JS pode esperar até 60 s pelo "Permitir" no celular. */
    private const val JS_TIMEOUT_S = 90L
    private const val MAX_KEYS = 8
  }

  private class Pending(val latch: CountDownLatch = CountDownLatch(1)) {
    @Volatile var status = 503
    @Volatile var body = """{"code":"unavailable","error":"App indisponível"}"""
  }

  @Volatile private var server: ServerSocket? = null
  private val pending = ConcurrentHashMap<String, Pending>()
  private val keys = ConcurrentHashMap<String, KeyPair>()
  private val slots = Semaphore(MAX_CONNECTIONS)
  private val random = SecureRandom()

  override fun getName() = NAME

  @ReactMethod fun addListener(eventName: String) {}

  @ReactMethod fun removeListeners(count: Double) {}

  // ---------------------------------------------------------------------------
  // Servidor
  // ---------------------------------------------------------------------------
  @ReactMethod
  fun start(port: Int, lan: Boolean, promise: Promise) {
    stopServer()
    try {
      val bind = if (lan) InetAddress.getByName("0.0.0.0") else InetAddress.getByName("127.0.0.1")
      val srv = ServerSocket(port, 16, bind)
      server = srv
      Util.io.execute { acceptLoop(srv) }
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("E_BRIDGE", e.message ?: "bind", e)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    stopServer()
    promise.resolve(null)
  }

  @ReactMethod
  fun isRunning(promise: Promise) {
    promise.resolve(server?.isClosed == false)
  }

  @ReactMethod
  fun localAddresses(promise: Promise) {
    val out = JSONArray()
    try {
      for (ni in NetworkInterface.getNetworkInterfaces().toList()) {
        if (!ni.isUp || ni.isLoopback) continue
        for (addr in ni.inetAddresses.toList()) if (addr is Inet4Address && addr.isSiteLocalAddress) out.put(addr.hostAddress)
      }
    } catch (_: Exception) {}
    promise.resolve(out.toString())
  }

  @ReactMethod
  fun respond(requestId: String, status: Int, body: String, promise: Promise) {
    pending.remove(requestId)?.let {
      it.status = status
      it.body = body
      it.latch.countDown()
    }
    promise.resolve(null)
  }

  private fun stopServer() {
    try {
      server?.close()
    } catch (_: Exception) {}
    server = null
    for (p in pending.values) p.latch.countDown()
    pending.clear()
    keys.clear()
  }

  private fun acceptLoop(srv: ServerSocket) {
    while (!srv.isClosed) {
      val socket =
          try {
            srv.accept()
          } catch (_: Exception) {
            break
          }
      if (!slots.tryAcquire()) {
        try {
          socket.close()
        } catch (_: Exception) {}
        continue
      }
      Util.io.execute {
        try {
          handle(socket)
        } finally {
          slots.release()
        }
      }
    }
  }

  private fun write(socket: Socket, status: Int, body: String) {
    val bytes = body.toByteArray(Charsets.UTF_8)
    val reason = when (status) { 200 -> "OK"; 400 -> "Bad Request"; 401 -> "Unauthorized"; 403 -> "Forbidden"; 404 -> "Not Found"; 423 -> "Locked"; 429 -> "Too Many Requests"; 504 -> "Gateway Timeout"; else -> "Error" }
    // Sem cabeçalhos CORS: só a extensão (com host_permissions) lê as respostas.
    val header =
        "HTTP/1.1 $status $reason\r\n" +
            "Content-Type: application/json; charset=utf-8\r\n" +
            "Content-Length: ${bytes.size}\r\n" +
            "Cache-Control: no-store\r\n" +
            "X-Content-Type-Options: nosniff\r\n" +
            "Connection: close\r\n\r\n"
    socket.getOutputStream().apply {
      write(header.toByteArray(Charsets.US_ASCII))
      write(bytes)
      flush()
    }
  }

  private fun handle(socket: Socket) {
    socket.use { s ->
      try {
        s.soTimeout = 10_000
        val input = BufferedInputStream(s.getInputStream())
        val head = ByteArrayOutputStream()
        var last4 = 0
        while (true) {
          val b = input.read()
          if (b < 0) return
          head.write(b)
          last4 = (last4 shl 8) or b
          if (last4 == 0x0D0A0D0A) break
          if (head.size() > MAX_HEADER) return write(s, 400, """{"code":"protocol","error":"Cabeçalho grande demais"}""")
        }
        val lines = head.toString("US-ASCII").split("\r\n")
        val parts = lines[0].split(" ")
        val method = parts.getOrElse(0) { "" }
        val path = parts.getOrElse(1) { "" }
        fun header(name: String) = lines.firstOrNull { it.lowercase().startsWith("$name:") }?.substringAfter(':')?.trim()
        // Páginas web (http/https) e documentos sem origem ("null") não falam com a ponte
        val origin = header("origin")?.lowercase()
        if (origin != null && EXTENSION_SCHEMES.none { origin.startsWith(it) }) return write(s, 403, """{"code":"origin","error":"Origem não permitida"}""")
        if ("$method $path" !in ROUTES) return write(s, 404, """{"code":"route","error":"Rota não encontrada"}""")
        val length = header("content-length")?.toIntOrNull() ?: 0
        if (length < 0 || length > MAX_BODY) return write(s, 400, """{"code":"protocol","error":"Pedido grande demais"}""")
        val body = ByteArray(length)
        var read = 0
        while (read < length) {
          val n = input.read(body, read, length - read)
          if (n < 0) break
          read += n
        }
        val (status, response) = forwardToJs(method, path, String(body, 0, read, Charsets.UTF_8))
        write(s, status, response)
      } catch (_: Exception) {
        try {
          write(s, 500, """{"code":"error","error":"Erro interno"}""")
        } catch (_: Exception) {}
      }
    }
  }

  /** Entrega o pedido ao JS e espera a resposta (o JS cifra e decide; aqui só transporte). */
  private fun forwardToJs(method: String, path: String, body: String): Pair<Int, String> {
    if (!ctx.hasActiveReactInstance()) return 503 to """{"code":"unavailable","error":"App indisponível"}"""
    val id = ByteArray(12).also { random.nextBytes(it) }.joinToString("") { "%02x".format(it) }
    val p = Pending()
    pending[id] = p
    val map = Arguments.createMap()
    map.putString("type", "http")
    map.putString("requestId", id)
    map.putString("method", method)
    map.putString("path", path)
    map.putString("body", body)
    ctx.emitDeviceEvent(NAME, map)
    if (!p.latch.await(JS_TIMEOUT_S, TimeUnit.SECONDS)) {
      pending.remove(id)
      return 504 to """{"code":"timeout","error":"O celular não respondeu a tempo."}"""
    }
    return p.status to p.body
  }

  // ---------------------------------------------------------------------------
  // ECDH P-256: a chave privada nunca sai deste módulo
  // ---------------------------------------------------------------------------
  private fun fixed(n: BigInteger): ByteArray {
    val raw = n.toByteArray()
    val out = ByteArray(32)
    val src = if (raw.size > 32) raw.copyOfRange(raw.size - 32, raw.size) else raw
    System.arraycopy(src, 0, out, 32 - src.size, src.size)
    return out
  }

  @ReactMethod
  fun ecdhGenerate(promise: Promise) {
    try {
      val gen = KeyPairGenerator.getInstance("EC")
      gen.initialize(ECGenParameterSpec("secp256r1"), random)
      val pair = gen.generateKeyPair()
      val w = (pair.public as ECPublicKey).w
      val raw = byteArrayOf(4) + fixed(w.affineX) + fixed(w.affineY)
      val handle = ByteArray(9).also { random.nextBytes(it) }.joinToString("") { "%02x".format(it) }
      if (keys.size >= MAX_KEYS) keys.keys.firstOrNull()?.let { keys.remove(it) }
      keys[handle] = pair
      promise.resolve(JSONObject().put("handle", handle).put("publicKey", Util.b64(raw)).toString())
    } catch (e: Exception) {
      promise.reject("E_ECDH", "Não foi possível gerar a chave de pareamento.", e)
    }
  }

  @ReactMethod
  fun ecdhAgree(handle: String, peerB64: String, promise: Promise) {
    val pair = keys.remove(handle) ?: return promise.reject("E_ECDH", "Chave de pareamento expirada")
    try {
      val raw = Util.unb64(peerB64)
      if (raw.size != 65 || raw[0] != 4.toByte()) throw IllegalArgumentException("Chave pública inválida")
      val params = (pair.public as ECPublicKey).params
      val x = BigInteger(1, raw.copyOfRange(1, 33))
      val y = BigInteger(1, raw.copyOfRange(33, 65))
      // Confere que o ponto está na curva (evita ataque de curva inválida)
      val p = (params.curve.field as ECFieldFp).p
      val rhs = x.pow(3).add(params.curve.a.multiply(x)).add(params.curve.b).mod(p)
      if (x >= p || y >= p || y.pow(2).mod(p) != rhs) throw IllegalArgumentException("Ponto fora da curva")
      val peer = KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), params))
      val ka = KeyAgreement.getInstance("ECDH")
      ka.init(pair.private)
      ka.doPhase(peer, true)
      val secret = ka.generateSecret()
      promise.resolve(Util.b64(secret))
      secret.fill(0)
    } catch (e: Exception) {
      promise.reject("E_ECDH", "Chave pública da extensão inválida.", e)
    }
  }

  @ReactMethod
  fun ecdhDiscard(handle: String, promise: Promise) {
    keys.remove(handle)
    promise.resolve(null)
  }

  override fun invalidate() {
    stopServer()
    super.invalidate()
  }
}
