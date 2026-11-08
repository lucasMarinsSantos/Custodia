package com.custodia.modules

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Notificações de segurança: canal "Alertas de segurança" com visibilidade privada na tela de bloqueio
 * (o conteúdo só aparece com o aparelho desbloqueado; bloqueado, aparece "Custódia: alerta de segurança").
 * O JS nunca manda segredos (senhas, usuários ou nomes de serviço) no título ou no texto.
 * No Android 13+ exige a permissão POST_NOTIFICATIONS, pedida pelo JS (PermissionsAndroid).
 */
class NotificationModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

  companion object {
    const val NAME = "CustodiaNotifications"
    private const val CHANNEL = "custodia_security_alerts"
    private const val MAX_TEXT = 300
  }

  override fun getName() = NAME

  private fun ensureChannel() {
    val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (nm.getNotificationChannel(CHANNEL) != null) return
    val ch = NotificationChannel(CHANNEL, "Alertas de segurança", NotificationManager.IMPORTANCE_HIGH)
    ch.description = "Tentativas de acesso que falharam, senhas vazadas e sites suspeitos"
    ch.lockscreenVisibility = NotificationCompat.VISIBILITY_PRIVATE
    nm.createNotificationChannel(ch)
  }

  private fun granted(): Boolean =
      Build.VERSION.SDK_INT < 33 ||
          ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

  @ReactMethod
  fun enabled(promise: Promise) {
    promise.resolve(granted() && NotificationManagerCompat.from(ctx).areNotificationsEnabled())
  }

  @SuppressLint("MissingPermission")
  @ReactMethod
  fun notify(id: Double, title: String, body: String, promise: Promise) {
    try {
      ensureChannel()
      val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
      val pi = launch?.let {
        PendingIntent.getActivity(ctx, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      }
      val icon = android.R.drawable.ic_lock_idle_lock
      // Versão mostrada na tela de bloqueio: sem nenhum detalhe
      val lockScreenVersion =
          NotificationCompat.Builder(ctx, CHANNEL)
              .setSmallIcon(icon)
              .setContentTitle("Custódia: alerta de segurança")
              .build()
      val text = body.take(MAX_TEXT)
      val builder =
          NotificationCompat.Builder(ctx, CHANNEL)
              .setSmallIcon(icon)
              .setColor(Color.parseColor("#0F766E"))
              .setContentTitle(title.take(80))
              .setContentText(text)
              .setStyle(NotificationCompat.BigTextStyle().bigText(text))
              .setPriority(NotificationCompat.PRIORITY_HIGH)
              .setCategory(NotificationCompat.CATEGORY_STATUS)
              .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
              .setPublicVersion(lockScreenVersion)
              .setAutoCancel(true)
      if (pi != null) builder.setContentIntent(pi)
      if (granted()) NotificationManagerCompat.from(ctx).notify(id.toInt(), builder.build())
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("E_NOTIFY", e.message ?: "Falha ao mostrar a notificação", e)
    }
  }
}
