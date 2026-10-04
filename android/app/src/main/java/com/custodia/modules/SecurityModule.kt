package com.custodia.modules

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import java.io.File
import java.io.FileInputStream
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * Segurança nativa:
 *  • Android Keystore: chave AES-256-GCM (StrongBox/TEE quando disponível) que cifra as
 *    preferências onde ficam os envelopes da chave do banco;
 *  • Biometria: BiometricPrompt + chave do Keystore que exige autenticação biométrica;
 *  • PBKDF2-HMAC-SHA256, SecureRandom e SHA-256 do arquivo do banco.
 */
class SecurityModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

  companion object {
    const val NAME = "CustodiaSecurity"
    private const val KEYSTORE = "AndroidKeyStore"
    private const val PREFS_ALIAS = "custodia_prefs_key_v1"
    private const val PREFS_FILE = "custodia_secure_prefs"
    private const val BIO_FILE = "custodia_bio_prefs"
    private const val GCM_TAG = 128
  }

  override fun getName() = NAME

  private val keyStore: KeyStore by lazy { KeyStore.getInstance(KEYSTORE).apply { load(null) } }
  private val prefs: SharedPreferences by lazy { ctx.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE) }
  private val bioPrefs: SharedPreferences by lazy { ctx.getSharedPreferences(BIO_FILE, Context.MODE_PRIVATE) }
  private val random = SecureRandom()

  // ---------------------------------------------------------------------------
  // Chaves do Keystore
  // ---------------------------------------------------------------------------
  @Synchronized
  private fun prefsKey(): SecretKey {
    (keyStore.getKey(PREFS_ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    fun spec(strongBox: Boolean): KeyGenParameterSpec {
      val b =
          KeyGenParameterSpec.Builder(PREFS_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
              .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
              .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
              .setKeySize(256)
      if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) b.setIsStrongBoxBacked(true)
      return b.build()
    }
    return try {
      generator.init(spec(true))
      generator.generateKey()
    } catch (e: Exception) {
      generator.init(spec(false))
      generator.generateKey()
    }
  }

  private fun encrypt(key: SecretKey, plain: ByteArray): String {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key)
    return Util.b64(cipher.iv + cipher.doFinal(plain))
  }

  private fun decrypt(key: SecretKey, data: String): ByteArray {
    val raw = Util.unb64(data)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG, raw.copyOfRange(0, 12)))
    return cipher.doFinal(raw.copyOfRange(12, raw.size))
  }

  // ---------------------------------------------------------------------------
  // Preferências cifradas (Keystore)
  // ---------------------------------------------------------------------------
  @ReactMethod
  fun secureSet(key: String, value: String, promise: Promise) {
    Util.io.execute {
      try {
        prefs.edit().putString(key, encrypt(prefsKey(), value.toByteArray(Charsets.UTF_8))).commit()
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("E_SECURE_SET", e.message, e)
      }
    }
  }

  @ReactMethod
  fun secureGet(key: String, promise: Promise) {
    Util.io.execute {
      try {
        val v = prefs.getString(key, null)
        promise.resolve(if (v == null) null else String(decrypt(prefsKey(), v), Charsets.UTF_8))
      } catch (e: Exception) {
        promise.reject("E_SECURE_GET", e.message, e)
      }
    }
  }

  @ReactMethod
  fun secureRemove(key: String, promise: Promise) {
    prefs.edit().remove(key).commit()
    promise.resolve(null)
  }

  @ReactMethod
  fun secureKeys(prefix: String, promise: Promise) {
    val arr = Arguments.createArray()
    prefs.all.keys.filter { it.startsWith(prefix) }.forEach { arr.pushString(it) }
    promise.resolve(arr)
  }

  // ---------------------------------------------------------------------------
  // PBKDF2-HMAC-SHA256 (bytes exatos, compatível com a implementação JS)
  // ---------------------------------------------------------------------------
  @ReactMethod
  fun pbkdf2(passwordB64: String, saltB64: String, iterations: Int, keyLen: Int, promise: Promise) {
    Util.io.execute {
      try {
        val password = Util.unb64(passwordB64)
        val salt = Util.unb64(saltB64)
        if (password.isEmpty()) throw IllegalArgumentException("Senha vazia")
        val out = if (platformPbkdf2Ok && isUtf8RoundTrip(password)) {
          platformPbkdf2(password, salt, iterations, keyLen)
        } else {
          manualPbkdf2(password, salt, iterations, keyLen)
        }
        promise.resolve(Util.b64(out))
      } catch (e: Exception) {
        promise.reject("E_PBKDF2", e.message, e)
      }
    }
  }

  /**
   * PBKDF2 da plataforma (SecretKeyFactory, código do sistema já compilado): rápido mesmo no APK de debug do
   * Android Studio, em que o ART não otimiza o código do app e o laço manual de 310 mil iterações leva dezenas de
   * segundos. Só é usado se reproduzir exatamente o laço manual (RFC 7914 e senha com acentos/emoji).
   */
  private val platformPbkdf2Ok: Boolean by lazy {
    try {
      val rfc = platformPbkdf2("passwd".toByteArray(), "salt".toByteArray(), 1, 64).joinToString("") { "%02x".format(it) }
      val unicode = "Çãé€😀#Senha2026".toByteArray(Charsets.UTF_8)
      rfc == "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783" &&
        platformPbkdf2(unicode, "sal".toByteArray(), 2, 32).contentEquals(manualPbkdf2(unicode, "sal".toByteArray(), 2, 32))
    } catch (e: Exception) {
      false
    }
  }

  private fun isUtf8RoundTrip(bytes: ByteArray): Boolean = String(bytes, Charsets.UTF_8).toByteArray(Charsets.UTF_8).contentEquals(bytes)

  private fun platformPbkdf2(password: ByteArray, salt: ByteArray, iterations: Int, keyLen: Int): ByteArray {
    val chars = String(password, Charsets.UTF_8).toCharArray()
    val spec = PBEKeySpec(chars, salt, iterations, keyLen * 8)
    try {
      return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
    } finally {
      spec.clearPassword()
      chars.fill('\u0000')
    }
  }

  /** PBKDF2-HMAC-SHA256 (RFC 8018) implementado diretamente sobre o HMAC: referência e alternativa. */
  private fun manualPbkdf2(password: ByteArray, salt: ByteArray, iterations: Int, keyLen: Int): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(password, "HmacSHA256"))
    val hLen = 32
    val blocks = (keyLen + hLen - 1) / hLen
    val out = ByteArray(blocks * hLen)
    for (i in 1..blocks) {
      mac.update(salt)
      mac.update(byteArrayOf((i ushr 24).toByte(), (i ushr 16).toByte(), (i ushr 8).toByte(), i.toByte()))
      var u = mac.doFinal()
      val t = u.copyOf()
      for (j in 1 until iterations) {
        u = mac.doFinal(u)
        for (k in t.indices) t[k] = (t[k].toInt() xor u[k].toInt()).toByte()
      }
      System.arraycopy(t, 0, out, (i - 1) * hLen, hLen)
    }
    return out.copyOf(keyLen)
  }

  /** Bytes aleatórios do SecureRandom (API equivalente a react-native-random-bytes). */
  @ReactMethod
  fun randomBytes(size: Int, promise: Promise) {
    val bytes = ByteArray(size.coerceIn(0, 1 shl 20))
    random.nextBytes(bytes)
    promise.resolve(Util.b64(bytes))
  }

  @Suppress("DEPRECATION")
  @ReactMethod
  fun isHardwareBacked(promise: Promise) {
    Util.io.execute {
      try {
        val key = prefsKey()
        val factory = SecretKeyFactory.getInstance(key.algorithm, KEYSTORE)
        val info = factory.getKeySpec(key, KeyInfo::class.java) as KeyInfo
        val secure =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
                info.securityLevel == KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT ||
                    info.securityLevel == KeyProperties.SECURITY_LEVEL_STRONGBOX
            else info.isInsideSecureHardware
        promise.resolve(secure)
      } catch (e: Exception) {
        promise.resolve(false)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Biometria (BiometricPrompt + chave do Keystore vinculada à biometria)
  // ---------------------------------------------------------------------------
  @ReactMethod
  fun biometricAvailable(promise: Promise) {
    val map = Arguments.createMap()
    when (BiometricManager.from(ctx).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)) {
      BiometricManager.BIOMETRIC_SUCCESS -> map.putBoolean("available", true)
      BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> {
        map.putBoolean("available", false)
        map.putString("reason", "Nenhuma digital ou rosto cadastrado no aparelho.")
      }
      BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> {
        map.putBoolean("available", false)
        map.putString("reason", "Este aparelho não possui sensor biométrico.")
      }
      else -> {
        map.putBoolean("available", false)
        map.putString("reason", "Biometria indisponível no momento.")
      }
    }
    promise.resolve(map)
  }

  private fun bioKeyAlias(alias: String) = "custodia_bio_$alias"

  private fun createBioKey(alias: String): SecretKey {
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    val builder =
        KeyGenParameterSpec.Builder(bioKeyAlias(alias), KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
    }
    generator.init(builder.build())
    return generator.generateKey()
  }

  private fun prompt(
      title: String,
      subtitle: String,
      crypto: BiometricPrompt.CryptoObject?,
      onSuccess: (BiometricPrompt.AuthenticationResult) -> Unit,
      onError: (String, String) -> Unit,
  ) {
    val activity = ctx.currentActivity as? FragmentActivity
    if (activity == null) {
      onError("E_NO_ACTIVITY", "Tela indisponível para biometria")
      return
    }
    UiThreadUtil.runOnUiThread {
      try {
        // A promessa é resolvida uma única vez (cancelar a leitura também dispara onAuthenticationError)
        val settled = java.util.concurrent.atomic.AtomicBoolean(false)
        var promptRef: BiometricPrompt? = null
        val prompt =
            BiometricPrompt(
                activity,
                ContextCompat.getMainExecutor(activity),
                object : BiometricPrompt.AuthenticationCallback() {
                  override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    if (settled.compareAndSet(false, true)) onSuccess(result)
                  }

                  // Digital não cadastrada: encerra a leitura e devolve a mensagem ao app,
                  // que oferece a senha mestra. O app conta as falhas e desativa a biometria após 5 seguidas.
                  override fun onAuthenticationFailed() {
                    if (settled.compareAndSet(false, true)) {
                      onError("E_NOT_RECOGNIZED", "Não foi possível reconhecer a biometria")
                      promptRef?.cancelAuthentication()
                    }
                  }

                  override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    if (!settled.compareAndSet(false, true)) return
                    val cancelled =
                        errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
                            errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                            errorCode == BiometricPrompt.ERROR_CANCELED
                    // Após 5 leituras não reconhecidas o Android bloqueia o sensor (ERROR_LOCKOUT)
                    val lockout = errorCode == BiometricPrompt.ERROR_LOCKOUT || errorCode == BiometricPrompt.ERROR_LOCKOUT_PERMANENT
                    when {
                      cancelled -> onError("E_CANCELLED", "cancelled: $errString")
                      lockout -> onError("E_LOCKOUT", "lockout: $errString")
                      else -> onError("E_BIOMETRIC", errString.toString())
                    }
                  }
                })
        val info =
            BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle(subtitle)
                .setNegativeButtonText("Usar senha mestra")
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                .setConfirmationRequired(false)
                .build()
        promptRef = prompt
        if (crypto != null) prompt.authenticate(info, crypto) else prompt.authenticate(info)
      } catch (e: Exception) {
        onError("E_BIOMETRIC", e.message ?: "Falha na biometria")
      }
    }
  }

  @ReactMethod
  fun biometricEnroll(alias: String, secretB64: String, title: String, subtitle: String, promise: Promise) {
    try {
      if (keyStore.containsAlias(bioKeyAlias(alias))) keyStore.deleteEntry(bioKeyAlias(alias))
      val key = createBioKey(alias)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, key)
      prompt(
          title,
          subtitle,
          BiometricPrompt.CryptoObject(cipher),
          { result ->
            try {
              val c = result.cryptoObject!!.cipher!!
              val ct = c.doFinal(Util.unb64(secretB64))
              bioPrefs.edit().putString(alias, Util.b64(c.iv + ct)).commit()
              promise.resolve(null)
            } catch (e: Exception) {
              promise.reject("E_BIOMETRIC", e.message, e)
            }
          },
          { code, msg -> promise.reject(code, msg) })
    } catch (e: Exception) {
      promise.reject("E_BIOMETRIC", e.message, e)
    }
  }

  @ReactMethod
  fun biometricUnlock(alias: String, title: String, subtitle: String, promise: Promise) {
    try {
      val stored = bioPrefs.getString(alias, null) ?: return promise.reject("E_NOT_ENROLLED", "Biometria não configurada")
      val key = keyStore.getKey(bioKeyAlias(alias), null) as? SecretKey ?: return promise.reject("E_NOT_ENROLLED", "Chave biométrica ausente")
      val raw = Util.unb64(stored)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      try {
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG, raw.copyOfRange(0, 12)))
      } catch (e: KeyPermanentlyInvalidatedException) {
        keyStore.deleteEntry(bioKeyAlias(alias))
        bioPrefs.edit().remove(alias).commit()
        return promise.reject("E_INVALIDATED", "As biometrias do aparelho mudaram. Entre com a senha mestra e reative a biometria.")
      }
      prompt(
          title,
          subtitle,
          BiometricPrompt.CryptoObject(cipher),
          { result ->
            try {
              val plain = result.cryptoObject!!.cipher!!.doFinal(raw.copyOfRange(12, raw.size))
              promise.resolve(Util.b64(plain))
            } catch (e: Exception) {
              promise.reject("E_BIOMETRIC", e.message, e)
            }
          },
          { code, msg -> promise.reject(code, msg) })
    } catch (e: Exception) {
      promise.reject("E_BIOMETRIC", e.message, e)
    }
  }

  @ReactMethod
  fun biometricRemove(alias: String, promise: Promise) {
    try {
      if (keyStore.containsAlias(bioKeyAlias(alias))) keyStore.deleteEntry(bioKeyAlias(alias))
    } catch (_: Exception) {}
    bioPrefs.edit().remove(alias).commit()
    promise.resolve(null)
  }

  @ReactMethod
  fun hasBiometricKey(alias: String, promise: Promise) {
    promise.resolve(bioPrefs.contains(alias) && keyStore.containsAlias(bioKeyAlias(alias)))
  }

  /** SHA-256 de um arquivo (nome simples = banco em getDatabasePath). */
  @ReactMethod
  fun sha256File(pathOrName: String, promise: Promise) {
    Util.io.execute {
      try {
        val file = if (pathOrName.contains('/')) File(pathOrName) else ctx.getDatabasePath(pathOrName)
        if (!file.exists()) return@execute promise.resolve(null)
        val md = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
          val buf = ByteArray(64 * 1024)
          while (true) {
            val n = input.read(buf)
            if (n <= 0) break
            md.update(buf, 0, n)
          }
        }
        promise.resolve(Util.hex(md.digest()))
      } catch (e: Exception) {
        promise.resolve(null)
      }
    }
  }
}
