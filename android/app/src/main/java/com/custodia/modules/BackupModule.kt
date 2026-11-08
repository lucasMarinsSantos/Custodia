package com.custodia.modules

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Scope
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.SecureRandom

/**
 * Destinos do backup cifrado. O conteúdo chega do JS já cifrado; aqui só se gravam bytes.
 *  • Armazenamento interno do app (filesDir/backups): pasta privada, fora do alcance de outros apps.
 *  • Pasta escolhida pelo usuário (SAF, ACTION_OPEN_DOCUMENT_TREE, com permissão persistente).
 *  • Token do Google Drive pela Authorization API do Google Play Services (AuthorizationClient),
 *    escopo restrito https://www.googleapis.com/auth/drive.file (o app só enxerga os arquivos que criou).
 */
class BackupModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx), ActivityEventListener {

  companion object {
    const val NAME = "CustodiaBackup"
    private const val REQ_TREE = 7311
    private const val REQ_DRIVE = 7312
    private const val DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file"
    private const val E_NOT_CONFIGURED = "E_DRIVE_NOT_CONFIGURED"
    private const val E_CONSENT = "E_DRIVE_CONSENT"
    private val SAFE_NAME = Regex("^[\\w.-]{1,120}$")
  }

  private var treePromise: Promise? = null
  private var drivePromise: Promise? = null

  init {
    ctx.addActivityEventListener(this)
  }

  override fun getName() = NAME

  // ---------------------------------------------------------------------------
  // Armazenamento interno
  // ---------------------------------------------------------------------------
  private fun internalDir(): File = File(ctx.filesDir, "backups").apply { mkdirs() }

  private fun internalFile(name: String): File {
    if (!SAFE_NAME.matches(name)) throw SecurityException("Nome de arquivo inválido")
    val base = internalDir()
    val f = File(base, name)
    if (f.canonicalFile.parentFile?.canonicalPath != base.canonicalPath) throw SecurityException("Caminho inválido")
    return f
  }

  @ReactMethod
  fun writeInternal(name: String, base64: String, promise: Promise) {
    Util.io.execute {
      try {
        val f = internalFile(name)
        val tmp = File(f.parentFile, "$name.tmp")
        tmp.writeBytes(Util.unb64(base64))
        // Grava num temporário e renomeia: um backup interrompido no meio nunca substitui um arquivo íntegro
        if (!tmp.renameTo(f)) throw IllegalStateException("Falha ao gravar o backup")
        promise.resolve(name)
      } catch (e: Exception) {
        promise.reject("E_WRITE", e.message, e)
      }
    }
  }

  @ReactMethod
  fun listInternal(promise: Promise) {
    Util.io.execute {
      val arr = Arguments.createArray()
      internalDir().listFiles()?.filter { it.isFile && !it.name.endsWith(".tmp") }?.forEach { f ->
        arr.pushMap(doc(f.name, f.name, f.length(), f.lastModified()))
      }
      promise.resolve(arr)
    }
  }

  private fun doc(name: String, uri: String, size: Long, modified: Long) = Arguments.createMap().apply {
    putString("name", name)
    putString("uri", uri)
    putDouble("size", size.toDouble())
    putDouble("modified", modified.toDouble())
  }

  // ---------------------------------------------------------------------------
  // Pasta escolhida (SAF)
  // ---------------------------------------------------------------------------
  @ReactMethod
  fun pickFolder(promise: Promise) {
    val activity = ctx.currentActivity ?: return promise.reject("E_NO_ACTIVITY", "Tela indisponível")
    treePromise?.resolve(null)
    treePromise = promise
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
    }
    try {
      activity.startActivityForResult(intent, REQ_TREE)
    } catch (e: Exception) {
      treePromise = null
      promise.reject("E_ACTIVITY", e.message, e)
    }
  }

  private fun permitted(uri: String): Boolean =
      ctx.contentResolver.persistedUriPermissions.any { it.isWritePermission && (uri == it.uri.toString() || uri.startsWith(it.uri.toString() + "/")) }

  private fun requireTree(treeUri: String): Uri {
    if (!permitted(treeUri)) throw SecurityException("Sem permissão para a pasta escolhida. Escolha a pasta novamente.")
    return Uri.parse(treeUri)
  }

  private fun treeDocUri(tree: Uri): Uri = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))

  @ReactMethod
  fun hasFolderPermission(treeUri: String, promise: Promise) {
    promise.resolve(permitted(treeUri))
  }

  @ReactMethod
  fun writeToFolder(treeUri: String, name: String, mime: String, base64: String, promise: Promise) {
    Util.io.execute {
      try {
        if (!SAFE_NAME.matches(name)) throw SecurityException("Nome de arquivo inválido")
        val tree = requireTree(treeUri)
        val cr = ctx.contentResolver
        val created = DocumentsContract.createDocument(cr, treeDocUri(tree), mime.ifBlank { "application/octet-stream" }, name)
            ?: throw IllegalStateException("Não foi possível criar o arquivo na pasta escolhida")
        try {
          cr.openOutputStream(created, "wt")?.use { it.write(Util.unb64(base64)) } ?: throw IllegalStateException("Falha ao gravar o arquivo")
        } catch (e: Exception) {
          // Não deixa um arquivo pela metade na pasta do usuário
          try { DocumentsContract.deleteDocument(cr, created) } catch (_: Exception) {}
          throw e
        }
        promise.resolve(created.toString())
      } catch (e: Exception) {
        promise.reject("E_WRITE", e.message, e)
      }
    }
  }

  @ReactMethod
  fun listFolder(treeUri: String, promise: Promise) {
    Util.io.execute {
      try {
        val tree = requireTree(treeUri)
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        val cols = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        )
        val arr: WritableArray = Arguments.createArray()
        ctx.contentResolver.query(children, cols, null, null, null)?.use { c ->
          while (c.moveToNext()) {
            val id = c.getString(0) ?: continue
            val name = c.getString(1) ?: continue
            arr.pushMap(doc(name, DocumentsContract.buildDocumentUriUsingTree(tree, id).toString(), c.getLong(2), c.getLong(3)))
          }
        }
        promise.resolve(arr)
      } catch (e: Exception) {
        promise.reject("E_LIST", e.message, e)
      }
    }
  }

  @ReactMethod
  fun readDocument(uri: String, maxBytes: Double, promise: Promise) {
    Util.io.execute {
      try {
        val max = maxBytes.toLong().coerceIn(1, 64L * 1024 * 1024)
        val bytes = if (uri.startsWith("content://")) {
          if (!permitted(uri)) throw SecurityException("Sem permissão para a pasta escolhida. Escolha a pasta novamente.")
          ctx.contentResolver.openInputStream(Uri.parse(uri))?.use { input ->
            val out = ByteArrayOutputStream()
            val buf = ByteArray(64 * 1024)
            var total = 0L
            while (true) {
              val n = input.read(buf)
              if (n <= 0) break
              total += n
              if (total > max) throw IllegalStateException("Backup grande demais para restaurar")
              out.write(buf, 0, n)
            }
            out.toByteArray()
          } ?: throw IllegalStateException("Arquivo de backup não encontrado")
        } else {
          val f = internalFile(uri)
          if (!f.exists()) throw IllegalStateException("Arquivo de backup não encontrado")
          if (f.length() > max) throw IllegalStateException("Backup grande demais para restaurar")
          f.readBytes()
        }
        promise.resolve(Util.b64(bytes))
      } catch (e: Exception) {
        promise.reject("E_READ", e.message, e)
      }
    }
  }

  @ReactMethod
  fun deleteDocument(uri: String, promise: Promise) {
    Util.io.execute {
      try {
        if (uri.startsWith("content://")) {
          if (!permitted(uri)) throw SecurityException("Sem permissão para a pasta escolhida")
          DocumentsContract.deleteDocument(ctx.contentResolver, Uri.parse(uri))
        } else {
          val f = internalFile(uri)
          if (f.exists()) {
            // O arquivo já é cifrado; a sobrescrita é defesa extra contra recuperação do bloco no flash
            val len = f.length().coerceAtMost(64L * 1024 * 1024).toInt()
            f.writeBytes(ByteArray(len).also { SecureRandom().nextBytes(it) })
            f.delete()
          }
        }
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("E_DELETE", e.message, e)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Google Drive (AuthorizationClient, escopo drive.file)
  // ---------------------------------------------------------------------------
  @ReactMethod
  fun driveAuthorize(interactive: Boolean, promise: Promise) {
    val activity = ctx.currentActivity ?: return promise.reject("E_NO_ACTIVITY", "Tela indisponível")
    try {
      val request = AuthorizationRequest.builder().setRequestedScopes(listOf(Scope(DRIVE_SCOPE))).build()
      Identity.getAuthorizationClient(activity)
          .authorize(request)
          .addOnSuccessListener { result ->
            val pi = result.pendingIntent
            if (result.hasResolution() && pi != null) {
              // O backup automático não abre tela de consentimento sozinho
              if (!interactive) return@addOnSuccessListener promise.reject(E_CONSENT, "É preciso autorizar o Google Drive")
              drivePromise?.reject("E_DRIVE", "Autorização substituída")
              drivePromise = promise
              try {
                activity.startIntentSenderForResult(pi.intentSender, REQ_DRIVE, null, 0, 0, 0, null)
              } catch (e: Exception) {
                drivePromise = null
                promise.reject("E_DRIVE", e.message, e)
              }
            } else {
              val token = result.accessToken
              if (token != null) promise.resolve(token) else promise.reject("E_DRIVE", "Token não recebido")
            }
          }
          .addOnFailureListener { e -> rejectDrive(promise, e) }
    } catch (e: Exception) {
      rejectDrive(promise, e)
    }
  }

  /** DEVELOPER_ERROR (10): não há OAuth Client ID Android para este pacote + SHA-1 no Google Cloud. */
  private fun rejectDrive(promise: Promise, e: Exception) {
    val status = (e as? ApiException)?.statusCode
    if (status == CommonStatusCodes.DEVELOPER_ERROR) promise.reject(E_NOT_CONFIGURED, "Google Drive não configurado", e)
    else promise.reject("E_DRIVE", e.message ?: "Falha ao autorizar o Google Drive", e)
  }

  // ---------------------------------------------------------------------------
  // Resultados das atividades
  // ---------------------------------------------------------------------------
  override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
    when (requestCode) {
      REQ_TREE -> onTree(resultCode, data)
      REQ_DRIVE -> onDrive(activity, resultCode, data)
    }
  }

  private fun onTree(resultCode: Int, data: Intent?) {
    val promise = treePromise ?: return
    treePromise = null
    val uri = data?.data
    if (resultCode != Activity.RESULT_OK || uri == null) return promise.resolve(null)
    try {
      ctx.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
      var name = "Pasta escolhida"
      ctx.contentResolver.query(treeDocUri(uri), arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) name = c.getString(0) ?: name
      }
      promise.resolve(Arguments.createMap().apply {
        putString("uri", uri.toString())
        putString("name", name.take(120))
      })
    } catch (e: Exception) {
      promise.reject("E_FOLDER", e.message, e)
    }
  }

  private fun onDrive(activity: Activity, resultCode: Int, data: Intent?) {
    val promise = drivePromise ?: return
    drivePromise = null
    if (resultCode != Activity.RESULT_OK || data == null) return promise.reject("E_DRIVE", "Autorização do Google Drive cancelada")
    try {
      val token = Identity.getAuthorizationClient(activity).getAuthorizationResultFromIntent(data).accessToken
      if (token == null) promise.reject("E_DRIVE", "Token não recebido") else promise.resolve(token)
    } catch (e: Exception) {
      rejectDrive(promise, e)
    }
  }

  override fun onNewIntent(intent: Intent) {}
}
