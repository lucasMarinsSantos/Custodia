package com.custodia.modules

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.IOException
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.net.URL
import java.net.UnknownHostException
import java.security.cert.CertPathValidatorException
import java.security.cert.CertificateExpiredException
import java.security.cert.CertificateNotYetValidException
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException

/**
 * Rede:
 *  • checkTls: conecta por HTTPS ao host informado e devolve se o certificado é válido, o emissor, a validade,
 *    o protocolo negociado, os nomes do certificado e o cabeçalho HSTS. Só aceita nomes de host públicos: IPs,
 *    localhost e endereços que resolvem para redes internas/privadas são recusados (evita SSRF).
 *  • networkInfo: tipo de rede ativa (Wi-Fi, dados móveis…), usado no histórico de acessos. Não usa localização.
 */
class NetModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

  companion object {
    const val NAME = "CustodiaNet"
    private const val TIMEOUT_MS = 8000
    private val HOST_RE = Regex("^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$")
    private val BLOCKED_SUFFIXES = listOf(".localhost", ".local", ".internal", ".lan", ".home", ".intranet", ".corp")
  }

  override fun getName() = NAME

  // ---------------------------------------------------------------------------
  // Verificação TLS
  // ---------------------------------------------------------------------------
  @ReactMethod
  fun checkTls(hostInput: String, promise: Promise) {
    Util.io.execute {
      val host = hostInput.trim().lowercase()
      val map = Arguments.createMap()
      map.putString("host", host)
      var conn: HttpsURLConnection? = null
      try {
        // A validação também é feita no JS; aqui ela se repete porque o nativo não confia em quem chama.
        if (!HOST_RE.matches(host) || host == "localhost" || BLOCKED_SUFFIXES.any { host.endsWith(it) }) {
          return@execute promise.reject("E_HOST", "Endereço interno ou inválido não é verificado")
        }
        val addresses = InetAddress.getAllByName(host)
        if (addresses.isEmpty() || addresses.any { isPrivate(it) }) {
          return@execute promise.reject("E_HOST", "O endereço aponta para uma rede interna e não é verificado")
        }

        var protocol: String? = null
        val defaultVerifier = HttpsURLConnection.getDefaultHostnameVerifier()
        conn = URL("https", host, 443, "/").openConnection() as HttpsURLConnection
        conn.connectTimeout = TIMEOUT_MS
        conn.readTimeout = TIMEOUT_MS
        conn.instanceFollowRedirects = false
        conn.useCaches = false
        conn.requestMethod = "HEAD"
        conn.setRequestProperty("User-Agent", "Custodia-Android")
        // Usa a verificação padrão do Android e só aproveita para ler o protocolo negociado
        conn.hostnameVerifier = HostnameVerifier { h, session ->
          protocol = session.protocol
          defaultVerifier.verify(h, session)
        }
        conn.connect()
        val status = conn.responseCode
        val cert = conn.serverCertificates.firstOrNull() as? X509Certificate
        map.putBoolean("reachable", true)
        map.putInt("status", status)
        if (cert != null) {
          cert.checkValidity()
          map.putString("issuer", friendlyName(cert.issuerX500Principal.name))
          map.putString("subject", friendlyName(cert.subjectX500Principal.name))
          map.putDouble("validFrom", cert.notBefore.time.toDouble())
          map.putDouble("validTo", cert.notAfter.time.toDouble())
          val names = Arguments.createArray()
          certHosts(cert).take(20).forEach { names.pushString(it) }
          map.putArray("certHosts", names)
        }
        protocol?.let { map.putString("protocol", it) }
        val hsts = conn.getHeaderField("Strict-Transport-Security")
        map.putBoolean("hsts", !hsts.isNullOrBlank())
        Regex("max-age=(\\d+)").find(hsts ?: "")?.groupValues?.get(1)?.toDoubleOrNull()?.let { map.putDouble("hstsMaxAge", it) }
        map.putBoolean("valid", cert != null)
        if (cert == null) map.putString("error", "O servidor não apresentou certificado")
      } catch (e: SSLPeerUnverifiedException) {
        invalid(map, "O certificado não pertence a este endereço")
      } catch (e: SSLHandshakeException) {
        invalid(map, handshakeReason(e))
      } catch (e: CertificateExpiredException) {
        invalid(map, "O certificado do site expirou")
      } catch (e: CertificateNotYetValidException) {
        invalid(map, "O certificado do site ainda não é válido")
      } catch (e: UnknownHostException) {
        unreachable(map, "Endereço não encontrado (o domínio não existe ou não há internet)")
      } catch (e: SocketTimeoutException) {
        unreachable(map, "Tempo esgotado ao conectar ao site")
      } catch (e: IOException) {
        unreachable(map, "Não foi possível conectar ao site")
      } catch (e: Exception) {
        unreachable(map, "Falha ao verificar o site")
      } finally {
        conn?.disconnect()
      }
      promise.resolve(map)
    }
  }

  private fun invalid(map: com.facebook.react.bridge.WritableMap, reason: String) {
    map.putBoolean("reachable", true)
    map.putBoolean("valid", false)
    map.putString("error", reason)
  }

  private fun unreachable(map: com.facebook.react.bridge.WritableMap, reason: String) {
    map.putBoolean("reachable", false)
    map.putBoolean("valid", false)
    map.putString("error", reason)
  }

  private fun handshakeReason(e: Throwable): String {
    var cur: Throwable? = e
    while (cur != null) {
      when (cur) {
        is CertificateExpiredException -> return "O certificado do site expirou"
        is CertificateNotYetValidException -> return "O certificado do site ainda não é válido"
        is CertPathValidatorException -> return "O certificado não é emitido por uma autoridade confiável"
      }
      cur = cur.cause
    }
    return "Falha na negociação segura (TLS) com o site"
  }

  /** "CN=R11, O=Let's Encrypt, C=US" → "Let's Encrypt • R11". */
  private fun friendlyName(dn: String): String {
    fun part(key: String) = Regex("(?:^|,\\s*)$key=([^,]+)").find(dn)?.groupValues?.get(1)?.trim()
    val o = part("O")
    val cn = part("CN")
    return listOfNotNull(o, cn).distinct().joinToString(" • ").ifBlank { dn.take(200) }
  }

  /** CN e nomes DNS do subjectAltName. */
  private fun certHosts(cert: X509Certificate): List<String> {
    val out = mutableListOf<String>()
    Regex("(?:^|,\\s*)CN=([^,]+)").find(cert.subjectX500Principal.name)?.groupValues?.get(1)?.let { out.add(it.trim()) }
    try {
      cert.subjectAlternativeNames?.forEach { entry ->
        if (entry.size >= 2 && entry[0] == 2) (entry[1] as? String)?.let { out.add(it) }
      }
    } catch (e: Exception) {
      // certificado sem SAN legível: fica só o CN
    }
    return out.distinct()
  }

  /** Loopback, link-local, redes privadas (RFC 1918), CGNAT 100.64/10, ULA fc00::/7, multicast e "0.0.0.0". */
  private fun isPrivate(addr: InetAddress): Boolean {
    if (addr.isLoopbackAddress || addr.isLinkLocalAddress || addr.isSiteLocalAddress || addr.isAnyLocalAddress || addr.isMulticastAddress) return true
    val b = addr.address
    if (addr is Inet4Address) {
      val a0 = b[0].toInt() and 0xff
      val a1 = b[1].toInt() and 0xff
      return a0 == 0 || a0 == 10 || a0 == 127 || (a0 == 100 && a1 in 64..127) || (a0 == 169 && a1 == 254) ||
          (a0 == 172 && a1 in 16..31) || (a0 == 192 && a1 == 168) || a0 >= 224
    }
    if (addr is Inet6Address) {
      val a0 = b[0].toInt() and 0xff
      return (a0 and 0xfe) == 0xfc
    }
    return false
  }

  // ---------------------------------------------------------------------------
  // Rede atual (histórico de acessos)
  // ---------------------------------------------------------------------------
  @ReactMethod
  fun networkInfo(promise: Promise) {
    val map = Arguments.createMap()
    try {
      val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      val caps = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }
      if (caps == null) {
        map.putBoolean("connected", false)
        map.putString("type", "none")
      } else {
        map.putBoolean("connected", caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET))
        map.putString(
            "type",
            when {
              caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
              caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
              caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
              caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
              else -> "other"
            })
      }
    } catch (e: Exception) {
      // Sem ACCESS_NETWORK_STATE ou serviço indisponível
      map.putBoolean("connected", true)
      map.putString("type", "unknown")
    }
    promise.resolve(map)
  }
}
