package com.custodia.modules

import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import com.custodia.autofill.AutofillState
import com.custodia.autofill.CustodiaAccessibilityService
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil

/**
 * Ponte JS ↔ serviço de preenchimento automático (`CustodiaAutofill`, usado por `src/native/integration.ts`).
 * Nenhuma senha atravessa esta ponte, exceto o par escolhido pelo usuário em [deliver].
 */
class AutofillModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  companion object {
    const val NAME = "CustodiaAutofill"
  }

  init {
    AutofillState.reactContext = ctx
  }

  override fun getName() = NAME

  @ReactMethod fun addListener(eventName: String) {}

  @ReactMethod fun removeListeners(count: Double) {}

  @ReactMethod
  fun isServiceEnabled(promise: Promise) {
    try {
      val enabled = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: ""
      val component = ComponentName(ctx, CustodiaAccessibilityService::class.java)
      val flat = component.flattenToString()
      val short = component.flattenToShortString()
      promise.resolve(enabled.split(':').any { it.equals(flat, true) || it.equals(short, true) })
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }

  @ReactMethod
  fun openAccessibilitySettings(promise: Promise) {
    try {
      ctx.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("E_SETTINGS", "Não foi possível abrir as configurações de acessibilidade.", e)
    }
  }

  /** "Informações do app": no Android 13+, o menu ⋮ tem "Permitir configurações restritas". */
  @ReactMethod
  fun openAppInfo(promise: Promise) {
    try {
      val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", ctx.packageName, null)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      ctx.startActivity(intent)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("E_SETTINGS", "Não foi possível abrir as informações do app.", e)
    }
  }

  @ReactMethod
  fun setEnabled(enabled: Boolean, promise: Promise) {
    AutofillState.setEnabled(ctx, enabled)
    if (!enabled) CustodiaAccessibilityService.instance?.hideBubble()
    promise.resolve(null)
  }

  @ReactMethod
  fun setIndex(json: String, promise: Promise) {
    try {
      AutofillState.setIndex(json)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("E_INDEX", "Índice de preenchimento inválido.", e)
    }
  }

  @ReactMethod
  fun clearIndex(promise: Promise) {
    AutofillState.clearIndex()
    promise.resolve(null)
  }

  @ReactMethod
  fun takeRequest(promise: Promise) {
    promise.resolve(AutofillState.peekRequest()?.toJson())
  }

  @ReactMethod
  fun deliver(json: String, ttlMs: Double, promise: Promise) {
    try {
      promise.resolve(AutofillState.deliver(json, ttlMs.toLong()))
    } catch (e: Exception) {
      promise.reject("E_DELIVER", "Não foi possível entregar o preenchimento.", e)
    }
  }

  @ReactMethod
  fun cancel(requestId: String, promise: Promise) {
    AutofillState.cancel(requestId)
    promise.resolve(null)
  }

  /** Manda o Custódia para trás: o app de destino volta ao primeiro plano e o serviço preenche. */
  @ReactMethod
  fun returnToTarget(promise: Promise) {
    val activity = ctx.currentActivity ?: return promise.resolve(null)
    UiThreadUtil.runOnUiThread {
      activity.moveTaskToBack(true)
      promise.resolve(null)
    }
  }

  @ReactMethod
  fun takePasswordChanges(promise: Promise) {
    promise.resolve(AutofillState.takeChanges())
  }
}
