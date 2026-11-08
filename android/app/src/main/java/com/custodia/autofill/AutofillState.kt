package com.custodia.autofill

import android.content.Context
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom

/**
 * Estado compartilhado entre o app (JS, via [com.custodia.modules.AutofillModule]) e o serviço de acessibilidade
 *. Desenho de segurança:
 *  - o índice de sugestões tem só metadados (id, título, hosts, domínios associados e pacotes), nunca usuário ou
 *    senha, e existe só na memória, enquanto o cofre está aberto;
 *  - o pedido de preenchimento (pacote + URL da barra) não tem segredo e vale por 2 minutos;
 *  - a entrega (o par usuário/senha ou os campos do formulário escolhidos pelo usuário) fica só na memória por no
 *    máximo `ttl` ms, amarrada ao pedido (mesmo pacote e, nos navegadores, mesmo host), e é descartada ao preencher;
 *  - o único dado persistido é o liga/desliga do balão (SharedPreferences, sem segredo).
 */
object AutofillState {
  /** Mesma lista de `BROWSER_PACKAGES` em `src/services/AutofillService.ts`, com o id da barra de endereço. */
  val URL_BAR_IDS: Map<String, List<String>> =
      mapOf(
          "com.android.chrome" to listOf("url_bar"),
          "com.chrome.beta" to listOf("url_bar"),
          "com.chrome.dev" to listOf("url_bar"),
          "org.mozilla.firefox" to listOf("mozac_browser_toolbar_url_view", "url_bar_title"),
          "org.mozilla.firefox_beta" to listOf("mozac_browser_toolbar_url_view", "url_bar_title"),
          "org.mozilla.fenix" to listOf("mozac_browser_toolbar_url_view"),
          "com.microsoft.emmx" to listOf("url_bar"),
          "com.sec.android.app.sbrowser" to listOf("location_bar_edit_text", "custom_tab_toolbar_url_bar_text"),
          "com.sec.android.app.sbrowser.beta" to listOf("location_bar_edit_text", "custom_tab_toolbar_url_bar_text"),
          "com.brave.browser" to listOf("url_bar"),
          "com.brave.browser_beta" to listOf("url_bar"),
      )

  const val REQUEST_MAX_AGE_MS = 2 * 60_000L
  private const val PREFS = "custodia_autofill"
  private const val MAX_CHANGES = 20

  data class IndexEntry(val id: String, val title: String, val hosts: List<String>, val associated: List<String>, val packages: List<String>)

  data class Request(val id: String, val kind: String, val packageName: String, val url: String?, val newPassword: Boolean, val createdAt: Long) {
    fun toJson(): String =
        JSONObject()
            .put("id", id)
            .put("kind", kind)
            .put("packageName", packageName)
            .put("url", url ?: JSONObject.NULL)
            .put("credentialId", JSONObject.NULL)
            .put("newPassword", newPassword)
            .put("createdAt", createdAt)
            .toString()
  }

  /** Par escolhido no app. `fields` = campos de formulário pelo nome padrão (cc-number, postal-code…). */
  class Delivery(val request: Request, val username: String?, val password: String?, val fields: Map<String, String>, val expiresAt: Long)

  @Volatile var reactContext: ReactApplicationContext? = null
  @Volatile var index: List<IndexEntry> = emptyList()
    private set
  @Volatile var unlocked = false
    private set
  @Volatile private var request: Request? = null
  @Volatile private var delivery: Delivery? = null
  private val changes = mutableListOf<JSONObject>()
  private val random = SecureRandom()

  // ---------------------------------------------------------------------------
  // Liga/desliga (persistido: vale com o app fechado)
  // ---------------------------------------------------------------------------
  fun isEnabled(context: Context): Boolean = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("enabled", true)

  fun setEnabled(context: Context, enabled: Boolean) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("enabled", enabled).apply()
    if (!enabled) clearAll()
  }

  // ---------------------------------------------------------------------------
  // Índice (só metadados)
  // ---------------------------------------------------------------------------
  private fun strings(arr: JSONArray?, max: Int): List<String> {
    if (arr == null) return emptyList()
    val out = ArrayList<String>()
    for (i in 0 until minOf(arr.length(), max)) {
      val s = arr.optString(i).lowercase()
      if (s.isNotEmpty() && s.length <= 255) out.add(s)
    }
    return out
  }

  fun setIndex(json: String) {
    val arr = JSONArray(json)
    val list = ArrayList<IndexEntry>()
    for (i in 0 until minOf(arr.length(), 5000)) {
      val o = arr.getJSONObject(i)
      list.add(IndexEntry(o.optString("id"), o.optString("title").take(60), strings(o.optJSONArray("hosts"), 5), strings(o.optJSONArray("associated"), 20), strings(o.optJSONArray("packages"), 20)))
    }
    index = list
    unlocked = true
  }

  /** Cofre bloqueado: apaga o índice e o pedido. A entrega já aprovada continua até vencer (máx. 30 s). */
  fun clearIndex() {
    index = emptyList()
    unlocked = false
    request = null
  }

  private fun clearAll() {
    clearIndex()
    delivery = null
    synchronized(changes) { changes.clear() }
  }

  /** Mesma regra de `indexMatches` (TS): pacote (fora de navegador), host salvo ou subdomínio, domínio associado. */
  fun matches(packageName: String, url: String?): List<IndexEntry> {
    val browser = URL_BAR_IDS.containsKey(packageName)
    val host = hostOf(url)
    val pkg = packageName.lowercase()
    return index.filter { e ->
      (!browser && e.packages.contains(pkg)) ||
          (host.isNotEmpty() &&
              (e.hosts.any { sameOrSub(host, it) } || e.associated.any { a -> if (a.startsWith("*.")) sameOrSub(host, a.substring(2)) else host == a }))
    }
  }

  private fun sameOrSub(host: String, base: String) = base.isNotEmpty() && (host == base || host.endsWith(".$base"))

  /** Mesmo `hostnameOf` de `src/utils/index.ts`. */
  fun hostOf(url: String?): String {
    if (url.isNullOrBlank()) return ""
    var s = url.trim().lowercase()
    s = s.replace(Regex("^[a-z][a-z0-9+.-]*://"), "")
    s = s.split('/', '?', '#')[0]
    s = s.substringAfterLast('@')
    s = s.substringBefore(':')
    return s.replace(Regex("^www\\d*\\."), "")
  }

  // ---------------------------------------------------------------------------
  // Pedido e entrega
  // ---------------------------------------------------------------------------
  private fun newId(): String {
    val b = ByteArray(12)
    random.nextBytes(b)
    return b.joinToString("") { "%02x".format(it) }
  }

  fun createRequest(kind: String, packageName: String, url: String?, newPassword: Boolean): Request {
    val r = Request(newId(), kind, packageName, url?.take(2048), newPassword, System.currentTimeMillis())
    request = r
    delivery = null
    emit("request")
    return r
  }

  /** Retira o pedido aberto (o app chama ao voltar ao primeiro plano). Fica guardado até a entrega ou o fim do prazo. */
  fun peekRequest(): Request? {
    val r = request ?: return null
    if (System.currentTimeMillis() - r.createdAt > REQUEST_MAX_AGE_MS) {
      request = null
      return null
    }
    return r
  }

  /** Recebe o par escolhido. Só aceita se for para o pedido aberto e dentro do prazo. */
  fun deliver(json: String, ttlMs: Long): Boolean {
    val o = JSONObject(json)
    val r = peekRequest() ?: return false
    if (o.optString("requestId") != r.id) return false
    val fields = HashMap<String, String>()
    o.optJSONArray("fields")?.let { arr ->
      for (i in 0 until minOf(arr.length(), 30)) {
        val f = arr.getJSONObject(i)
        val key = f.optString("key")
        val value = f.optString("value")
        if (key.isNotEmpty() && value.isNotEmpty() && value.length <= 512) fields[key] = value
      }
    }
    val user = if (o.has("username")) o.optString("username") else null
    val pass = if (o.has("password")) o.optString("password") else null
    delivery = Delivery(r, user, pass, fields, System.currentTimeMillis() + ttlMs.coerceIn(1_000L, 30_000L))
    request = null
    return true
  }

  /** Entrega válida para a tela em foco (mesmo app e, no navegador, mesmo host do pedido). Consome a entrega. */
  fun takeDeliveryFor(packageName: String, url: String?): Delivery? {
    val d = delivery ?: return null
    if (System.currentTimeMillis() > d.expiresAt) {
      delivery = null
      return null
    }
    if (d.request.packageName != packageName) return null
    if (URL_BAR_IDS.containsKey(packageName)) {
      val host = hostOf(url)
      if (host.isEmpty() || host != hostOf(d.request.url)) return null
    }
    delivery = null
    return d
  }

  fun cancel(requestId: String) {
    if (request?.id == requestId) request = null
    if (delivery?.request?.id == requestId) delivery = null
  }

  // ---------------------------------------------------------------------------
  // Logins e trocas de senha percebidos (sem a senha)
  // ---------------------------------------------------------------------------
  fun pushChange(kind: String, packageName: String, url: String?) {
    synchronized(changes) {
      changes.add(JSONObject().put("kind", kind).put("packageName", packageName).put("url", url ?: JSONObject.NULL).put("at", System.currentTimeMillis()))
      while (changes.size > MAX_CHANGES) changes.removeAt(0)
    }
    emit("passwordChange")
  }

  fun takeChanges(): String =
      synchronized(changes) {
        val arr = JSONArray()
        changes.forEach { arr.put(it) }
        changes.clear()
        arr.toString()
      }

  fun emit(type: String) {
    val ctx = reactContext ?: return
    try {
      if (!ctx.hasActiveReactInstance()) return
      val map = Arguments.createMap()
      map.putString("type", type)
      ctx.emitDeviceEvent("CustodiaAutofill", map)
    } catch (_: Exception) {}
  }
}
