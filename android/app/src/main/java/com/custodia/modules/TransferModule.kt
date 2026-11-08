package com.custodia.modules

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import java.io.ByteArrayOutputStream

/**
 * Seletor de documentos para importar senhas e restaurar backups.
 * Usa o Storage Access Framework (ACTION_OPEN_DOCUMENT): o app não pede permissão de armazenamento e só
 * enxerga o arquivo que o usuário escolheu. Recusa origens que não sejam content:// e arquivos acima do limite.
 */
class TransferModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx), ActivityEventListener {

  companion object {
    const val NAME = "CustodiaTransfer"
    private const val REQ_PICK = 7301
    /** Teto absoluto, mesmo que o JS peça mais. */
    private const val HARD_MAX = 40 * 1024 * 1024
  }

  private var pendingPromise: Promise? = null
  private var pendingMax = HARD_MAX

  init {
    ctx.addActivityEventListener(this)
  }

  override fun getName() = NAME

  @ReactMethod
  fun pickFile(mimeTypes: ReadableArray, maxBytes: Double, promise: Promise) {
    val activity = ctx.currentActivity ?: return promise.reject("E_NO_ACTIVITY", "Tela indisponível")
    val types = (0 until mimeTypes.size()).mapNotNull { mimeTypes.getString(it) }.filter { it.isNotBlank() }
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "*/*"
      if (types.isNotEmpty()) putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
    }
    // Um seletor anterior que ficou aberto é dado como cancelado
    pendingPromise?.resolve(null)
    pendingPromise = promise
    pendingMax = maxBytes.toInt().coerceIn(1, HARD_MAX)
    try {
      activity.startActivityForResult(intent, REQ_PICK)
    } catch (e: Exception) {
      pendingPromise = null
      promise.reject("E_ACTIVITY", e.message, e)
    }
  }

  private fun read(uri: Uri, max: Int): Triple<ByteArray, String, String> {
    if (uri.scheme != "content") throw SecurityException("Origem de arquivo não permitida")
    val cr = ctx.contentResolver
    var name = "arquivo"
    cr.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
      if (c.moveToFirst()) name = c.getString(0) ?: name
    }
    val mime = cr.getType(uri) ?: "application/octet-stream"
    val bytes = cr.openInputStream(uri)?.use { input ->
      val out = ByteArrayOutputStream()
      val buf = ByteArray(64 * 1024)
      var total = 0
      while (true) {
        val n = input.read(buf)
        if (n <= 0) break
        total += n
        if (total > max) throw IllegalStateException("Arquivo maior que ${max / 1024 / 1024} MB")
        out.write(buf, 0, n)
      }
      out.toByteArray()
    } ?: throw IllegalStateException("Não foi possível abrir o arquivo")
    return Triple(bytes, name.take(200), mime)
  }

  override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode != REQ_PICK) return
    val promise = pendingPromise ?: return
    pendingPromise = null
    val uri = data?.data
    if (resultCode != Activity.RESULT_OK || uri == null) return promise.resolve(null)
    val max = pendingMax
    Util.io.execute {
      try {
        val (bytes, name, mime) = read(uri, max)
        promise.resolve(Arguments.createMap().apply {
          putString("name", name)
          putString("mime", mime)
          putDouble("size", bytes.size.toDouble())
          putString("base64", Util.b64(bytes))
        })
      } catch (e: Exception) {
        promise.reject("E_READ", e.message, e)
      }
    }
  }

  override fun onNewIntent(intent: Intent) {}
}
