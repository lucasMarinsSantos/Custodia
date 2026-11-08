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
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.security.SecureRandom

/**
 * Seletor de arquivos de qualquer tipo para os anexos das notas seguras.
 *
 * Segurança:
 *  - só aceita URIs content:// (um app malicioso poderia devolver file:///data/data/... e fazer o Custódia ler
 *    os próprios arquivos privados);
 *  - para de ler assim que passa do limite pedido pelo JS (e nunca acima de HARD_MAX), sem carregar o arquivo
 *    inteiro na memória;
 *  - não pede permissão de armazenamento: o Storage Access Framework concede acesso só ao arquivo escolhido.
 *
 * Exclusão segura de arquivos temporários: `secureDelete` e `wipeTemp` sobrescrevem o conteúdo com
 * bytes aleatórios do mesmo tamanho (gravados no disco com fsync) antes de apagar. Só atuam dentro das pastas
 * privadas do app (cache e files), nunca em um caminho arbitrário vindo do JS.
 */
class FilesModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx), ActivityEventListener {

  companion object {
    const val NAME = "CustodiaFiles"
    private const val REQ_PICK_FILE = 7201
    private const val HARD_MAX = 20 * 1024 * 1024
    /** Pasta dos temporários do app (exportações, imagens de OCR etc.), dentro do cache privado. */
    const val TEMP_DIR = "custodia-tmp"
    private const val WIPE_CHUNK = 64 * 1024
  }

  private val random = SecureRandom()

  private var pending: Promise? = null
  private var pendingMax: Int = HARD_MAX

  init {
    ctx.addActivityEventListener(this)
  }

  override fun getName() = NAME

  @ReactMethod
  fun pickFile(maxBytes: Double, promise: Promise) {
    val activity = ctx.currentActivity ?: return promise.reject("E_NO_ACTIVITY", "Tela indisponível")
    // Um seletor anterior que ficou aberto é encerrado como "cancelado"
    pending?.resolve(null)
    pending = promise
    pendingMax = maxBytes.toInt().coerceIn(1, HARD_MAX)
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "*/*"
    }
    try {
      activity.startActivityForResult(intent, REQ_PICK_FILE)
    } catch (e: Exception) {
      pending = null
      promise.reject("E_ACTIVITY", e.message, e)
    }
  }

  private fun readLimited(uri: Uri, max: Int): Triple<ByteArray, String, String> {
    if (uri.scheme != "content") throw SecurityException("Origem de arquivo não permitida")
    val cr = ctx.contentResolver
    var name = "anexo"
    var declaredSize = -1L
    cr.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
      if (c.moveToFirst()) {
        name = c.getString(0) ?: name
        if (!c.isNull(1)) declaredSize = c.getLong(1)
      }
    }
    if (declaredSize > max) throw IllegalStateException("O anexo passa do limite de ${max / (1024 * 1024)} MB")
    val mime = cr.getType(uri) ?: "application/octet-stream"
    val bytes = cr.openInputStream(uri)?.use { input ->
      val out = ByteArrayOutputStream()
      val buf = ByteArray(64 * 1024)
      var total = 0
      while (true) {
        val n = input.read(buf)
        if (n <= 0) break
        total += n
        // O tamanho declarado pelo provedor pode mentir: o limite vale para os bytes lidos de fato
        if (total > max) throw IllegalStateException("O anexo passa do limite de ${max / (1024 * 1024)} MB")
        out.write(buf, 0, n)
      }
      out.toByteArray()
    } ?: throw IllegalStateException("Não foi possível ler o arquivo escolhido")
    return Triple(bytes, name, mime)
  }

  override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode != REQ_PICK_FILE) return
    val promise = pending ?: return
    pending = null
    val max = pendingMax
    val uri = data?.data
    if (resultCode != Activity.RESULT_OK || uri == null) return promise.resolve(null)
    Util.io.execute {
      try {
        val (bytes, name, mime) = readLimited(uri, max)
        promise.resolve(
            Arguments.createMap().apply {
              putString("name", name)
              putString("mime", mime)
              putDouble("size", bytes.size.toDouble())
              putString("base64", Util.b64(bytes))
            })
      } catch (e: Exception) {
        promise.reject("E_FILE", e.message, e)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Exclusão segura de arquivos
  // ---------------------------------------------------------------------------

  /** Pasta temporária privada; criada sob demanda. O JS recebe o caminho para gravar os temporários nela. */
  private fun tempDir(): File = File(ctx.cacheDir, TEMP_DIR).apply { mkdirs() }

  /** true se `f` está dentro do cache ou da pasta files do app (caminho canônico, sem "..", sem links para fora). */
  private fun insideAppStorage(f: File): Boolean {
    val path = f.canonicalPath
    return listOf(ctx.cacheDir, ctx.filesDir).any { root ->
      val base = root.canonicalPath
      path.startsWith(base + File.separator)
    }
  }

  /** Sobrescreve o arquivo inteiro com bytes aleatórios, força a gravação no disco e apaga. */
  private fun overwriteAndDelete(f: File): Boolean {
    if (!f.isFile) return false
    var remaining = f.length()
    FileOutputStream(f, false).use { out ->
      val buf = ByteArray(WIPE_CHUNK)
      while (remaining > 0) {
        val n = minOf(remaining, WIPE_CHUNK.toLong()).toInt()
        random.nextBytes(buf)
        out.write(buf, 0, n)
        remaining -= n
      }
      out.flush()
      out.fd.sync()
    }
    return f.delete()
  }

  /** Apaga com segurança tudo o que há na pasta (recursivo). Devolve quantos arquivos foram apagados. */
  private fun wipeDir(dir: File): Int {
    var count = 0
    dir.listFiles()?.forEach { child ->
      if (child.isDirectory) {
        count += wipeDir(child)
        child.delete()
      } else if (overwriteAndDelete(child)) {
        count++
      }
    }
    return count
  }

  @ReactMethod
  fun tempPath(promise: Promise) {
    try {
      promise.resolve(tempDir().absolutePath)
    } catch (e: Exception) {
      promise.reject("E_FILE", e.message, e)
    }
  }

  /** Exclusão segura de um arquivo do app (ex.: temporário de exportação). Recusa caminhos fora do app. */
  @ReactMethod
  fun secureDelete(path: String, promise: Promise) {
    Util.io.execute {
      try {
        val f = File(path)
        if (!insideAppStorage(f)) throw SecurityException("Caminho fora da área do aplicativo")
        promise.resolve(overwriteAndDelete(f))
      } catch (e: Exception) {
        promise.reject("E_FILE", e.message, e)
      }
    }
  }

  /** Apaga com segurança todos os temporários do app (chamado no desbloqueio e no bloqueio do cofre). */
  @ReactMethod
  fun wipeTemp(promise: Promise) {
    Util.io.execute {
      try {
        promise.resolve(wipeDir(tempDir()))
      } catch (e: Exception) {
        promise.reject("E_FILE", e.message, e)
      }
    }
  }

  override fun onNewIntent(intent: Intent) {}

  override fun invalidate() {
    ctx.removeActivityEventListener(this)
    pending?.resolve(null)
    pending = null
    super.invalidate()
  }
}
