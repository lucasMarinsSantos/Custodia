package com.custodia.autofill

import android.annotation.SuppressLint
import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.TextView
import android.widget.Toast

/**
 * Serviço de preenchimento automático do Custódia.
 *
 * Fluxo:
 *  1. Lê a tela em foco (pacote do app e, nos navegadores conhecidos, a URL da barra de endereço) e reconhece campos
 *     de login, cartão, endereço e identidade com o [FieldClassifier].
 *  2. Mostra o balão "Preencher com Custódia" (sobreposição de acessibilidade, sem permissão extra). Com o cofre
 *     bloqueado o balão pede desbloqueio; sem credencial para o app/site, oferece buscar no cofre.
 *  3. Ao tocar, cria um pedido sem segredos ([AutofillState.createRequest]) e abre o app, que pede o desbloqueio,
 *     verifica domínio/pacote (anti-phishing), credencial inativa e a regra da pasta, e deixa o usuário escolher.
 *  4. Quando o app de destino volta ao primeiro plano, preenche com ACTION_SET_TEXT o par entregue, só se o pacote
 *     (e o host, no navegador) for o mesmo do pedido, e descarta o par.
 *  5. Percebe login e troca de senha digitados pelo usuário (sem ler a senha) e avisa o app, que oferece
 *     salvar/atualizar a credencial.
 */
class CustodiaAccessibilityService : AccessibilityService() {

  companion object {
    // Referência ao serviço em execução (o próprio Android o mantém vivo); é limpa em onUnbind/onDestroy.
    @SuppressLint("StaticFieldLeak")
    @Volatile var instance: CustodiaAccessibilityService? = null

    private val IGNORED_PACKAGES =
        setOf(
            "android",
            "com.android.systemui",
            "com.android.settings",
            "com.android.launcher",
            "com.android.launcher3",
            "com.google.android.apps.nexuslauncher",
            "com.sec.android.app.launcher",
            "com.google.android.inputmethod.latin",
            "com.samsung.android.honeyboard",
            "com.google.android.permissioncontroller",
        )
    private const val SCAN_DELAY_MS = 300L
    private const val OWN_TEXT_GRACE_MS = 1500L
  }

  private val handler = Handler(Looper.getMainLooper())
  private var wm: WindowManager? = null
  private var bubble: TextView? = null
  private var scanScheduled = false

  // Tela atual
  private var currentPkg: String? = null
  private var currentUrl: String? = null
  private var lastScan: FieldClassifier.Scan? = null

  // Login/troca de senha digitados pelo usuário (sem o conteúdo)
  private var typedPassword = false
  private var typedNewPassword = false
  private var typedPkg: String? = null
  private var typedUrl: String? = null
  private var ownTextUntil = 0L

  override fun onServiceConnected() {
    super.onServiceConnected()
    instance = this
    wm = getSystemService(WINDOW_SERVICE) as WindowManager
  }

  override fun onDestroy() {
    hideBubble()
    instance = null
    super.onDestroy()
  }

  override fun onInterrupt() {
    hideBubble()
  }

  // ---------------------------------------------------------------------------
  // Eventos
  // ---------------------------------------------------------------------------
  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    if (event == null) return
    val pkg = event.packageName?.toString() ?: return
    if (pkg == packageName || pkg in IGNORED_PACKAGES) return
    if (!AutofillState.isEnabled(this)) return hideBubble()

    if (event.eventType == AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED && System.currentTimeMillis() > ownTextUntil) {
      val src = event.source
      if (src != null && src.isPassword) {
        typedPassword = true
        typedPkg = pkg
        typedUrl = currentUrl
        if (FieldClassifier.classify(src) == "new-password" || (lastScan?.newPassword == true)) typedNewPassword = true
      }
    }
    if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED && pkg != currentPkg) concludeTyping()
    scheduleScan()
  }

  private fun scheduleScan() {
    if (scanScheduled) return
    scanScheduled = true
    handler.postDelayed(
        {
          scanScheduled = false
          try {
            scan()
          } catch (_: Exception) {
            hideBubble()
          }
        },
        SCAN_DELAY_MS)
  }

  /** O usuário digitou uma senha e saiu da tela (formulário enviado ou outro app): avisa o app, sem a senha. */
  private fun concludeTyping() {
    val pkg = typedPkg
    if (typedPassword && pkg != null) AutofillState.pushChange(if (typedNewPassword) "change" else "login", pkg, typedUrl)
    typedPassword = false
    typedNewPassword = false
    typedPkg = null
    typedUrl = null
  }

  // ---------------------------------------------------------------------------
  // Varredura
  // ---------------------------------------------------------------------------
  private fun browserUrl(root: AccessibilityNodeInfo, pkg: String): String? {
    val ids = AutofillState.URL_BAR_IDS[pkg] ?: return null
    for (id in ids) {
      val text = root.findAccessibilityNodeInfosByViewId("$pkg:id/$id")?.firstOrNull()?.text?.toString()
      if (!text.isNullOrBlank() && text.length <= 2048) return text.trim()
    }
    return null
  }

  private fun scan() {
    val root = rootInActiveWindow ?: return hideBubble()
    val pkg = root.packageName?.toString() ?: return hideBubble()
    if (pkg == packageName || pkg in IGNORED_PACKAGES) return hideBubble()
    val browser = AutofillState.URL_BAR_IDS.containsKey(pkg)
    val prevPkg = currentPkg
    currentPkg = pkg
    // No navegador, sem a barra visível, vale a última URL lida no mesmo navegador
    currentUrl = if (browser) browserUrl(root, pkg) ?: (if (pkg == prevPkg) currentUrl else null) else null
    val scan = FieldClassifier.scan(root)
    lastScan = scan

    // Campos de senha sumiram depois de o usuário digitar: formulário enviado
    if (typedPassword && typedPkg == pkg && !scan.hasLogin) concludeTyping()

    if (fillIfDelivered(pkg, scan)) return
    if (scan.hasLogin || scan.formKinds.isNotEmpty()) showBubble(pkg, scan) else hideBubble()
  }

  // ---------------------------------------------------------------------------
  // Preenchimento
  // ---------------------------------------------------------------------------
  private fun setText(node: AccessibilityNodeInfo, value: String): Boolean {
    val args = Bundle()
    args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value)
    return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
  }

  /** Preenche o par entregue pelo app, se for para esta tela. Devolve true quando preencheu. */
  private fun fillIfDelivered(pkg: String, scan: FieldClassifier.Scan): Boolean {
    if (scan.fields.isEmpty()) return false
    val d = AutofillState.takeDeliveryFor(pkg, currentUrl) ?: return false
    val plan = if (d.request.kind == "login") FieldClassifier.planLogin(scan, d.username, d.password) else FieldClassifier.planForm(scan, d.fields)
    ownTextUntil = System.currentTimeMillis() + OWN_TEXT_GRACE_MS
    var filled = 0
    for ((index, value) in plan) if (setText(scan.fields[index].node, value)) filled++
    hideBubble()
    Toast.makeText(this, if (filled > 0) "Preenchido pelo Custódia" else "Custódia: nenhum campo compatível nesta tela", Toast.LENGTH_SHORT).show()
    return true
  }

  // ---------------------------------------------------------------------------
  // Balão
  // ---------------------------------------------------------------------------
  private fun dp(v: Int): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

  /** Mesmo `bubbleLabel` do TS. */
  private fun label(pkg: String, scan: FieldClassifier.Scan): String {
    if (!AutofillState.unlocked) return "🔒 Preencher com Custódia (desbloquear)"
    val matches = if (scan.hasLogin) AutofillState.matches(pkg, currentUrl).size else 0
    return if (matches > 0 || scan.formKinds.isNotEmpty()) "🔑 Preencher com Custódia" else "🔍 Nenhuma credencial salva · Buscar no cofre"
  }

  private fun showBubble(pkg: String, scan: FieldClassifier.Scan) {
    val text = label(pkg, scan)
    bubble?.let {
      it.text = text
      return
    }
    val tv =
        TextView(this).apply {
          this.text = text
          contentDescription = text
          setTextColor(Color.WHITE)
          setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
          background = GradientDrawable().apply {
            setColor(Color.parseColor("#0F766E"))
            cornerRadius = dp(24).toFloat()
          }
          setPadding(dp(16), dp(12), dp(16), dp(12))
          minHeight = dp(48)
          elevation = dp(6).toFloat()
          importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
          setOnClickListener { onBubbleClick() }
        }
    val params =
        WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT)
            .apply {
              gravity = Gravity.BOTTOM or Gravity.END
              x = dp(16)
              y = dp(120)
            }
    try {
      wm?.addView(tv, params)
      bubble = tv
    } catch (_: Exception) {
      bubble = null
    }
  }

  fun hideBubble() {
    handler.post {
      bubble?.let {
        try {
          wm?.removeView(it)
        } catch (_: Exception) {}
      }
      bubble = null
    }
  }

  private fun onBubbleClick() {
    val pkg = currentPkg ?: return
    val scan = lastScan ?: return
    val kind = if (scan.hasLogin) "login" else scan.formKinds.firstOrNull() ?: return
    AutofillState.createRequest(kind, pkg, currentUrl, scan.newPassword)
    hideBubble()
    val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    try {
      startActivity(launch)
    } catch (_: Exception) {
      Toast.makeText(this, "Não foi possível abrir o Custódia", Toast.LENGTH_LONG).show()
    }
  }
}
