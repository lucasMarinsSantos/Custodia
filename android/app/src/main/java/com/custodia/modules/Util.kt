package com.custodia.modules

import android.util.Base64
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** Utilitários compartilhados pelos módulos nativos. */
object Util {
  /** Executor para operações bloqueantes (criptografia, rede, arquivos). */
  val io: ExecutorService = Executors.newCachedThreadPool()

  fun b64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

  fun unb64(value: String): ByteArray = Base64.decode(value, Base64.DEFAULT)

  fun hex(bytes: ByteArray): String {
    val sb = StringBuilder(bytes.size * 2)
    for (b in bytes) sb.append(String.format("%02x", b))
    return sb.toString()
  }
}
