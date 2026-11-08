package com.custodia.modules

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.net.Uri
import android.os.Build
import android.os.PersistableBundle
import android.provider.OpenableColumns
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.max

/**
 * Integração com o sistema: área de transferência segura, sensores de
 * bloqueio por proximidade/acelerômetro, seletor de imagem e salvar arquivo,
 * download de logos e ícone do launcher.
 */
class SystemModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx), ActivityEventListener, SensorEventListener {

  companion object {
    const val NAME = "CustodiaSystem"
    private const val REQ_PICK_IMAGE = 7102
    private const val REQ_SAVE = 7104
    private const val MAX_FILE = 20 * 1024 * 1024
  }

  private val pending = HashMap<Int, Promise>()
  private var pendingSaveBytes: ByteArray? = null

  init {
    ctx.addActivityEventListener(this)
  }

  override fun getName() = NAME

  @ReactMethod fun addListener(eventName: String) {}

  @ReactMethod fun removeListeners(count: Double) {}

  // ---------------------------------------------------------------------------
  // Área de transferência segura
  // ---------------------------------------------------------------------------
  @ReactMethod
  fun setClipboard(text: String, sensitive: Boolean, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      try {
        val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText("Custódia", text)
        if (sensitive) {
          // Android 13+: oculta a pré-visualização do conteúdo copiado (EXTRA_IS_SENSITIVE)
          clip.description.extras = PersistableBundle().apply { putBoolean("android.content.extra.IS_SENSITIVE", true) }
        }
        cm.setPrimaryClip(clip)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("E_CLIPBOARD", e.message, e)
      }
    }
  }

  @ReactMethod
  fun clearClipboardIf(text: String, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      try {
        val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val current = try { cm.primaryClip?.getItemAt(0)?.text?.toString() } catch (_: Exception) { null }
        if (current == null || current == text) {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) cm.clearPrimaryClip() else cm.setPrimaryClip(ClipData.newPlainText("", ""))
        }
        promise.resolve(null)
      } catch (e: Exception) {
        promise.resolve(null)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Sensores: proximidade (bolso) e acelerômetro (virado para baixo)
  // ---------------------------------------------------------------------------
  private var sensorManager: SensorManager? = null
  private var nearSince = 0L
  private var faceDownSince = 0L
  private var fired = false

  @ReactMethod
  fun startSensors(promise: Promise) {
    UiThreadUtil.runOnUiThread {
      val sm = ctx.getSystemService(Context.SENSOR_SERVICE) as SensorManager
      sensorManager?.unregisterListener(this)
      sensorManager = sm
      fired = false
      nearSince = 0
      faceDownSince = 0
      sm.getDefaultSensor(Sensor.TYPE_PROXIMITY)?.let { sm.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL) }
      sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)?.let { sm.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL) }
      promise.resolve(null)
    }
  }

  @ReactMethod
  fun stopSensors(promise: Promise) {
    sensorManager?.unregisterListener(this)
    sensorManager = null
    promise.resolve(null)
  }

  override fun onSensorChanged(event: SensorEvent) {
    if (fired) return
    val now = System.currentTimeMillis()
    when (event.sensor.type) {
      Sensor.TYPE_PROXIMITY -> {
        val near = event.values[0] < event.sensor.maximumRange && event.values[0] < 3f
        nearSince = if (near) (if (nearSince == 0L) now else nearSince) else 0L
      }
      Sensor.TYPE_ACCELEROMETER -> {
        val z = event.values[2]
        faceDownSince = if (z < -8.5f) (if (faceDownSince == 0L) now else faceDownSince) else 0L
      }
    }
    val kind =
        when {
          faceDownSince != 0L && now - faceDownSince > 800 -> "faceDown"
          nearSince != 0L && now - nearSince > 1200 && faceDownSince == 0L -> "pocket"
          else -> null
        }
    if (kind != null) {
      fired = true
      val map = Arguments.createMap()
      map.putString("kind", kind)
      ctx.emitDeviceEvent("CustodiaSensor", map)
    }
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

  // ---------------------------------------------------------------------------
  // Arquivos: seletor de imagem (ícone personalizado) e salvar documento (código de recuperação)
  // ---------------------------------------------------------------------------
  private fun startForResult(intent: Intent, code: Int, promise: Promise) {
    val activity = ctx.currentActivity ?: return promise.reject("E_NO_ACTIVITY", "Tela indisponível")
    pending.remove(code)?.resolve(null)
    pending[code] = promise
    try {
      activity.startActivityForResult(intent, code)
    } catch (e: Exception) {
      pending.remove(code)
      promise.reject("E_ACTIVITY", e.message, e)
    }
  }

  @ReactMethod
  fun pickImage(promise: Promise) {
    val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
      type = "image/*"
      addCategory(Intent.CATEGORY_OPENABLE)
    }
    startForResult(Intent.createChooser(intent, "Selecionar imagem"), REQ_PICK_IMAGE, promise)
  }

  @ReactMethod
  fun saveFile(name: String, mime: String, base64: String, promise: Promise) {
    pendingSaveBytes = Util.unb64(base64)
    val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = mime.ifBlank { "application/octet-stream" }
      putExtra(Intent.EXTRA_TITLE, name)
    }
    startForResult(intent, REQ_SAVE, promise)
  }

  private fun readUri(uri: Uri): Triple<ByteArray, String, String> {
    // Só aceita conteúdo entregue por um provedor (content://). Um app malicioso poderia devolver
    // file:///data/data/... e fazer o Custódia ler os próprios arquivos privados.
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
        if (total > MAX_FILE) throw IllegalStateException("Arquivo maior que 20 MB")
        out.write(buf, 0, n)
      }
      out.toByteArray()
    } ?: ByteArray(0)
    return Triple(bytes, name, mime)
  }

  private fun fileMap(bytes: ByteArray, name: String, mime: String) = Arguments.createMap().apply {
    putString("name", name)
    putString("mime", mime)
    putDouble("size", bytes.size.toDouble())
    putString("base64", Util.b64(bytes))
  }

  /** Reduz imagens grandes (máx. 2400 px) e reencoda em JPEG. */
  private fun normalizeImage(bytes: ByteArray): ByteArray {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    var sample = 1
    while (max(bounds.outWidth, bounds.outHeight) / sample > 2400) sample *= 2
    val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
      ?: throw IllegalArgumentException("O arquivo escolhido não é uma imagem válida")
    val out = ByteArrayOutputStream()
    bmp.compress(Bitmap.CompressFormat.JPEG, 90, out)
    bmp.recycle()
    return out.toByteArray()
  }

  override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
    val promise = pending.remove(requestCode) ?: return
    Util.io.execute {
      try {
        when (requestCode) {
          REQ_PICK_IMAGE -> {
            val uri = data?.data
            if (resultCode != Activity.RESULT_OK || uri == null) return@execute promise.resolve(null)
            val (bytes, name, _) = readUri(uri)
            val jpeg = normalizeImage(bytes)
            promise.resolve(fileMap(jpeg, name.substringBeforeLast('.') + ".jpg", "image/jpeg"))
          }
          REQ_SAVE -> {
            val uri = data?.data
            val bytes = pendingSaveBytes
            pendingSaveBytes = null
            if (resultCode != Activity.RESULT_OK || uri == null || bytes == null) return@execute promise.resolve(false)
            ctx.contentResolver.openOutputStream(uri, "wt")?.use { it.write(bytes) }
            promise.resolve(true)
          }
          else -> promise.resolve(null)
        }
      } catch (e: Exception) {
        promise.reject("E_RESULT", e.message, e)
      }
    }
  }

  override fun onNewIntent(intent: Intent) {}

  // ---------------------------------------------------------------------------
  // Download (logos, feeds binários)
  // ---------------------------------------------------------------------------
  @ReactMethod
  fun download(url: String, promise: Promise) {
    Util.io.execute {
      var conn: HttpURLConnection? = null
      try {
        conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 8000
        conn.readTimeout = 8000
        conn.instanceFollowRedirects = true
        conn.setRequestProperty("User-Agent", "Custodia-Android")
        if (conn.responseCode !in 200..299) return@execute promise.resolve(null)
        val bytes = conn.inputStream.use { input ->
          val out = ByteArrayOutputStream()
          val buf = ByteArray(16 * 1024)
          var total = 0
          while (true) {
            val n = input.read(buf)
            if (n <= 0) break
            total += n
            if (total > 1024 * 1024) break
            out.write(buf, 0, n)
          }
          out.toByteArray()
        }
        promise.resolve(Arguments.createMap().apply {
          putString("base64", Util.b64(bytes))
          putString("mime", conn.contentType ?: "application/octet-stream")
        })
      } catch (e: Exception) {
        promise.resolve(null)
      } finally {
        conn?.disconnect()
      }
    }
  }

  override fun invalidate() {
    sensorManager?.unregisterListener(this)
    ctx.removeActivityEventListener(this)
    super.invalidate()
  }
}
