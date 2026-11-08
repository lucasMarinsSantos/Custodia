package com.custodia.modules

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.provider.MediaStore
import androidx.core.content.FileProvider
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.googlecode.tesseract.android.TessBaseAPI
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import kotlin.math.max

/**
 * Importação por foto e por captura de tela: câmera do sistema ou galeria + Tesseract local
 * (tesseract4android, idiomas por+eng, modelos em assets/tessdata). Tudo acontece no aparelho.
 * A imagem não vai para o JS: devolvemos só o texto, a confiança média e a luminância média (aviso de foto
 * escura). A foto da câmera fica num arquivo temporário do cache, apagado assim que o reconhecimento termina.
 */
class OcrModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx), ActivityEventListener {

  companion object {
    const val NAME = "CustodiaOcr"
    private const val REQ_CAMERA = 7321
    private const val REQ_GALLERY = 7322
    private const val MAX_IMAGE = 20 * 1024 * 1024
    private const val MAX_SIDE = 2400
    private val LANGS = setOf("por", "eng")
  }

  private var pendingPromise: Promise? = null
  private var pendingLang = "por+eng"
  private var captureFile: File? = null

  init {
    ctx.addActivityEventListener(this)
  }

  override fun getName() = NAME

  private fun begin(promise: Promise, lang: String): Activity? {
    val activity = ctx.currentActivity
    if (activity == null) {
      promise.reject("E_NO_ACTIVITY", "Tela indisponível")
      return null
    }
    pendingPromise?.resolve(null)
    pendingPromise = promise
    pendingLang = lang
    return activity
  }

  @ReactMethod
  fun recognizeCamera(lang: String, promise: Promise) {
    val activity = begin(promise, lang) ?: return
    try {
      val dir = File(ctx.cacheDir, "ocr").apply { mkdirs() }
      val file = File(dir, "foto_${UUID.randomUUID()}.jpg")
      captureFile = file
      val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.ocrprovider", file)
      val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
        putExtra(MediaStore.EXTRA_OUTPUT, uri)
        addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      activity.startActivityForResult(intent, REQ_CAMERA)
    } catch (e: Exception) {
      pendingPromise = null
      cleanup()
      promise.reject("E_CAMERA", e.message ?: "Câmera indisponível", e)
    }
  }

  @ReactMethod
  fun recognizeGallery(lang: String, promise: Promise) {
    val activity = begin(promise, lang) ?: return
    val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
      type = "image/*"
      addCategory(Intent.CATEGORY_OPENABLE)
    }
    try {
      activity.startActivityForResult(Intent.createChooser(intent, "Escolher captura de tela"), REQ_GALLERY)
    } catch (e: Exception) {
      pendingPromise = null
      promise.reject("E_ACTIVITY", e.message, e)
    }
  }

  override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode != REQ_CAMERA && requestCode != REQ_GALLERY) return
    val promise = pendingPromise ?: return
    pendingPromise = null
    val lang = pendingLang
    val file = captureFile
    val uri = data?.data
    if (resultCode != Activity.RESULT_OK || (requestCode == REQ_GALLERY && uri == null)) {
      cleanup()
      return promise.resolve(null)
    }
    Util.io.execute {
      try {
        val bytes = if (requestCode == REQ_CAMERA) file?.takeIf { it.exists() }?.readBytes() else readUri(uri!!)
        if (bytes == null || bytes.isEmpty()) return@execute promise.resolve(null)
        promise.resolve(recognize(bytes, lang))
      } catch (e: Exception) {
        promise.reject("E_OCR", e.message ?: "Falha no reconhecimento de texto", e)
      } finally {
        cleanup()
      }
    }
  }

  private fun cleanup() {
    captureFile?.delete()
    captureFile = null
  }

  private fun readUri(uri: Uri): ByteArray {
    if (uri.scheme != "content") throw SecurityException("Origem de arquivo não permitida")
    return ctx.contentResolver.openInputStream(uri)?.use { input ->
      val out = ByteArrayOutputStream()
      val buf = ByteArray(64 * 1024)
      var total = 0
      while (true) {
        val n = input.read(buf)
        if (n <= 0) break
        total += n
        if (total > MAX_IMAGE) throw IllegalStateException("Imagem maior que 20 MB")
        out.write(buf, 0, n)
      }
      out.toByteArray()
    } ?: throw IllegalStateException("Não foi possível abrir a imagem")
  }

  /** Decodifica com redução (no máximo MAX_SIDE px) e aplica a rotação do EXIF (fotos da câmera). */
  private fun decode(bytes: ByteArray): Bitmap {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw IllegalArgumentException("Imagem inválida")
    var sample = 1
    while (max(bounds.outWidth, bounds.outHeight) / sample > MAX_SIDE) sample *= 2
    val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
        ?: throw IllegalArgumentException("Imagem inválida")
    val degrees = try {
      when (ExifInterface(ByteArrayInputStream(bytes)).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
        ExifInterface.ORIENTATION_ROTATE_90 -> 90f
        ExifInterface.ORIENTATION_ROTATE_180 -> 180f
        ExifInterface.ORIENTATION_ROTATE_270 -> 270f
        else -> 0f
      }
    } catch (_: Exception) {
      0f
    }
    if (degrees == 0f) return bmp
    val rotated = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, Matrix().apply { postRotate(degrees) }, true)
    if (rotated != bmp) bmp.recycle()
    return rotated
  }

  /** Luminância média (0–255) numa grade de amostras, para o aviso "Ative o flash...". */
  private fun brightness(bmp: Bitmap): Int {
    val stepX = max(1, bmp.width / 64)
    val stepY = max(1, bmp.height / 64)
    var sum = 0L
    var n = 0L
    var y = 0
    while (y < bmp.height) {
      var x = 0
      while (x < bmp.width) {
        val p = bmp.getPixel(x, y)
        sum += (299 * Color.red(p) + 587 * Color.green(p) + 114 * Color.blue(p)) / 1000
        n++
        x += stepX
      }
      y += stepY
    }
    return if (n == 0L) -1 else (sum / n).toInt()
  }

  private fun tessRoot(langs: List<String>): File {
    val root = File(ctx.filesDir, "tesseract")
    val dir = File(root, "tessdata").apply { mkdirs() }
    for (lang in langs) {
      val f = File(dir, "$lang.traineddata")
      if (!f.exists() || f.length() == 0L) {
        ctx.assets.open("tessdata/$lang.traineddata").use { input -> f.outputStream().use { input.copyTo(it) } }
      }
    }
    return root
  }

  private fun recognize(bytes: ByteArray, lang: String) = Arguments.createMap().apply {
    val langs = lang.split('+').filter { it in LANGS }.ifEmpty { listOf("por", "eng") }
    val bmp = decode(bytes)
    var api: TessBaseAPI? = null
    try {
      val light = brightness(bmp)
      api = TessBaseAPI()
      if (!api.init(tessRoot(langs).absolutePath, langs.joinToString("+"))) throw IllegalStateException("Falha ao iniciar o Tesseract")
      api.setPageSegMode(TessBaseAPI.PageSegMode.PSM_AUTO)
      api.setImage(bmp)
      val text = api.getUTF8Text() ?: ""
      putString("text", text.take(20000))
      putInt("confidence", api.meanConfidence())
      putInt("brightness", light)
    } finally {
      try { api?.recycle() } catch (_: Exception) {}
      bmp.recycle()
    }
  }

  override fun onNewIntent(intent: Intent) {}
}
