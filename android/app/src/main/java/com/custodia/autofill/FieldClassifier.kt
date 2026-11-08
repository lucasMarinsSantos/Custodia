package com.custodia.autofill

import android.view.accessibility.AccessibilityNodeInfo
import java.text.Normalizer

/**
 * Classificação dos campos da tela em foco e plano de preenchimento.
 *
 * Porta fiel de `src/services/AutofillFieldService.ts`, que é a versão de referência testada no Jest
 * (`integracao-autofill.test.ts`, com uma árvore de nós simulada). Mantenha as duas na mesma ordem de regras.
 */
object FieldClassifier {
  const val MAX_FIELD_TEXT = 200
  const val MAX_SCAN_DEPTH = 40
  const val MAX_SCAN_FIELDS = 60

  private val HINTS: Map<String, String> =
      listOf(
              "username" to listOf("username"),
              "password" to listOf("password", "current-password"),
              "new-password" to listOf("newpassword", "new-password"),
              "cc-number" to listOf("creditcardnumber", "cc-number"),
              "cc-name" to listOf("cc-name", "creditcardholdername"),
              "cc-exp-month" to listOf("creditcardexpirationmonth", "cc-exp-month"),
              "cc-exp-year" to listOf("creditcardexpirationyear", "cc-exp-year"),
              "cc-exp" to listOf("creditcardexpirationdate", "cc-exp"),
              "cc-csc" to listOf("creditcardsecuritycode", "cc-csc"),
              "postal-code" to listOf("postalcode", "postal-code", "zipcode"),
              "street-address" to listOf("postaladdress", "streetaddress", "street-address", "address-line1"),
              "address-level2" to listOf("addresslocality", "address-level2"),
              "address-level1" to listOf("addressregion", "address-level1"),
              "name" to listOf("personname", "name"),
              "email" to listOf("emailaddress", "email"),
              "tel" to listOf("phone", "phonenumber", "tel"),
              "cpf" to listOf("cpf"),
          )
          .flatMap { (key, hints) -> hints.map { it to key } }
          .toMap()

  private val SECRET_KEYS = setOf("password", "new-password", "cc-csc")

  private val CSC = Regex("""\b(cvv|cvc|csc|cod(igo)? (de )?seguranca|security code)\b""")

  private val PASSWORD_RULES =
      listOf(
          CSC to "cc-csc",
          Regex("""\b(nova senha|new ?password|confirm(ar|e)? (a )?(nova )?senha|confirm(ation)? password|repita a senha|repeat password|retype)\b""") to "new-password",
      )

  private val TEXT_RULES =
      listOf(
          CSC to "cc-csc",
          Regex("""\b(numero do cartao|n do cartao|card ?number|cc ?number|cartao de credito|credit card)\b""") to "cc-number",
          Regex("""\b(nome (impresso|no cartao|do titular)|titular|holder|name on card|cardholder|cc name)\b""") to "cc-name",
          Regex("""\bmm (aa|yy|aaaa|yyyy)\b""") to "cc-exp",
          Regex("""\b(mes|month)\b.*\b(validade|venc\w*|exp\w*)\b|\b(validade|venc\w*|exp\w*)\b.*\b(mes|month|mm)\b|\bcc exp month\b""") to "cc-exp-month",
          Regex("""\b(ano|year)\b.*\b(validade|venc\w*|exp\w*)\b|\b(validade|venc\w*|exp\w*)\b.*\b(ano|year|aa|yy)\b|\bcc exp year\b""") to "cc-exp-year",
          Regex("""\b(validade|vencimento|expira\w*|expiry|expiration|exp date)\b|\bmm (aa|yy|aaaa|yyyy)\b""") to "cc-exp",
          Regex("""\bcpf\b""") to "cpf",
          Regex("""\b(cep|zip|postal|codigo postal)\b""") to "postal-code",
          Regex("""\b(e ?mail)\b""") to "email",
          Regex("""\b(telefone|celular|phone|tel|whatsapp|mobile)\b""") to "tel",
          Regex("""\b(cidade|city|municipio|localidade)\b""") to "address-level2",
          Regex("""\b(estado|uf|state|province)\b""") to "address-level1",
          Regex("""\b(rua|logradouro|endereco|address|street|avenida)\b""") to "street-address",
          Regex("""\b(usuario|user ?name|login|user|identifier|account)\b""") to "username",
          Regex("""\b(nome completo|nome|full name|name|seu nome)\b""") to "name",
      )

  class Field(val node: AccessibilityNodeInfo, val key: String?, val isPassword: Boolean)

  class Scan(val fields: List<Field>) {
    val hasLogin: Boolean = fields.any { it.isPassword }
    val newPassword: Boolean = fields.any { it.key == "new-password" } || fields.count { it.isPassword } >= 2
    val formKinds: List<String> = FieldClassifier.formKindsOf(fields.mapNotNull { it.key }.toSet(), hasLogin)
  }

  fun normalize(s: String): String {
    val cut = s.take(MAX_FIELD_TEXT)
    val noAccents = Normalizer.normalize(cut, Normalizer.Form.NFD).replace(Regex("\\p{M}+"), "")
    return noAccents.lowercase().replace(Regex("[_\\-./:]+"), " ").replace(Regex("\\s+"), " ").trim()
  }

  private fun describe(node: AccessibilityNodeInfo): String {
    val parts = mutableListOf<String>()
    node.hintText?.let { parts.add(it.toString()) }
    node.viewIdResourceName?.let { id -> parts.add(id.substringAfter(":id/").replace(Regex("([a-z])([A-Z])"), "$1 $2")) }
    node.contentDescription?.let { parts.add(it.toString()) }
    val t = node.text
    if (!node.isPassword && t != null && t.length < 40) parts.add(t.toString())
    return normalize(parts.joinToString(" "))
  }

  /**
   * Classifica um campo. O `AccessibilityNodeInfo` não expõe os `autofillHints` da View (nem o `autocomplete` do
   * HTML): as dicas entram só pela [classifyHints], usada quando a origem as conhece; aqui vale o texto do campo
   * (dica, id da view, descrição e texto curto), exatamente como na segunda etapa do `classifyField` do TS.
   */
  fun classify(node: AccessibilityNodeInfo): String? {
    val desc = describe(node)
    if (node.isPassword) return PASSWORD_RULES.firstOrNull { it.first.containsMatchIn(desc) }?.second ?: "password"
    return TEXT_RULES.firstOrNull { it.first.containsMatchIn(desc) }?.second
  }

  /** Primeira etapa do `classifyField` do TS: dica declarada pelo app; campo mascarado só aceita chave secreta. */
  fun classifyHints(hints: List<String>, isPassword: Boolean): String? =
      hints.firstNotNullOfOrNull { h -> HINTS[h.lowercase()]?.takeIf { !isPassword || it in SECRET_KEYS } }

  fun formKindsOf(set: Set<String>, hasPassword: Boolean): List<String> {
    val out = mutableListOf<String>()
    fun count(keys: List<String>) = keys.count { it in set }
    if ("cc-number" in set || ("cc-csc" in set && count(listOf("cc-exp", "cc-exp-month", "cc-name")) > 0)) out.add("card")
    if (count(listOf("postal-code", "street-address", "address-level2", "address-level1")) >= 2) out.add("address")
    if (!hasPassword && count(listOf("name", "email", "tel", "cpf")) >= 2) out.add("identity")
    return out
  }

  /** Coleta os campos editáveis e visíveis, em ordem de leitura, com limites de profundidade e quantidade. */
  fun scan(root: AccessibilityNodeInfo?): Scan {
    val fields = mutableListOf<Field>()
    fun walk(node: AccessibilityNodeInfo?, depth: Int) {
      if (node == null || depth > MAX_SCAN_DEPTH || fields.size >= MAX_SCAN_FIELDS) return
      if (node.isEditable && node.isVisibleToUser) fields.add(Field(node, classify(node), node.isPassword))
      for (i in 0 until node.childCount) walk(node.getChild(i), depth + 1)
    }
    walk(root, 0)
    return Scan(fields)
  }

  /** Mesmo `planLoginFill` do TS: índice do campo → valor. */
  fun planLogin(scan: Scan, username: String?, password: String?): List<Pair<Int, String>> {
    val f = scan.fields
    val out = mutableListOf<Pair<Int, String>>()
    val pw = f.indexOfFirst { it.isPassword && it.key != "new-password" && it.key != "cc-csc" }
    if (pw >= 0 && !password.isNullOrEmpty()) out.add(pw to password)
    val end = if (pw >= 0) pw else f.size
    var user = -1
    for (i in 0 until end) if (!f[i].isPassword && (f[i].key == "username" || f[i].key == "email")) user = i
    if (user < 0 && pw >= 0) {
      var i = pw - 1
      while (i >= 0 && user < 0) {
        if (!f[i].isPassword) user = i
        i--
      }
    }
    if (user < 0 && pw < 0) user = f.indexOfFirst { it.node.isFocused && !it.isPassword }
    if (user >= 0 && !username.isNullOrEmpty()) out.add(user to username)
    return out
  }

  /** Mesmo `planFormFill` do TS: campo reconhecido recebe o valor de mesmo nome; validade única vira MM/AA. */
  fun planForm(scan: Scan, values: Map<String, String>): List<Pair<Int, String>> {
    val byKey = HashMap(values)
    if (!byKey.containsKey("name")) byKey["cc-name"]?.let { byKey["name"] = it }
    val month = byKey["cc-exp-month"]
    val year = byKey["cc-exp-year"]
    if (!byKey.containsKey("cc-exp") && !month.isNullOrEmpty() && !year.isNullOrEmpty()) byKey["cc-exp"] = "${month.padStart(2, '0')}/${year.takeLast(2)}"
    val used = HashSet<String>()
    val out = mutableListOf<Pair<Int, String>>()
    scan.fields.forEachIndexed { i, field ->
      val key = field.key ?: return@forEachIndexed
      if (key in used) return@forEachIndexed
      if (field.isPassword && key != "cc-csc") return@forEachIndexed
      val value = byKey[key]
      if (value.isNullOrEmpty()) return@forEachIndexed
      used.add(key)
      out.add(i to value)
    }
    return out
  }
}
