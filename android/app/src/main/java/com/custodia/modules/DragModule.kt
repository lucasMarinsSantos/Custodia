package com.custodia.modules

import com.custodia.R
import android.content.ClipData
import android.content.ClipDescription
import android.graphics.Color
import android.os.Build
import android.os.PersistableBundle
import android.util.TypedValue
import android.view.View
import android.widget.TextView
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil

/**
 * Arrastar o usuário ou a senha para outro app em tela dividida, `CustodiaDrag`.
 * Usa `View.startDragAndDrop` com `DRAG_FLAG_GLOBAL`: o texto vai direto ao campo em que o usuário soltar,
 * sem passar pela área de transferência. A senha vai marcada com `ClipDescription.EXTRA_IS_SENSITIVE` e a
 * sombra do arrastar mostra só o rótulo ("Netflix, senha"), nunca o valor.
 * Chamado durante o toque longo (o dedo ainda está na tela, que é quando o Android aceita iniciar o arrastar).
 */
class DragModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  companion object {
    const val NAME = "CustodiaDrag"
    /** Valor de `ClipDescription.EXTRA_IS_SENSITIVE` (constante só existe a partir do Android 13). */
    private const val EXTRA_IS_SENSITIVE = "android.content.extra.IS_SENSITIVE"
  }

  override fun getName() = NAME

  @ReactMethod
  fun isInMultiWindow(promise: Promise) {
    promise.resolve(ctx.currentActivity?.isInMultiWindowMode ?: false)
  }

  @ReactMethod
  fun startDrag(text: String, label: String, sensitive: Boolean, promise: Promise) {
    val activity = ctx.currentActivity
    val result = Arguments.createMap()
    if (activity == null || !activity.isInMultiWindowMode) {
      result.putBoolean("started", false)
      result.putBoolean("multiWindow", false)
      return promise.resolve(result)
    }
    UiThreadUtil.runOnUiThread {
      var started = false
      try {
        val shadowView =
            TextView(activity).apply {
              this.text = activity.getString(R.string.integracao_drag_label, label)
              setTextColor(Color.WHITE)
              setBackgroundColor(Color.parseColor("#0F766E"))
              setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
              val pad = (12 * resources.displayMetrics.density).toInt()
              setPadding(pad, pad / 2, pad, pad / 2)
            }
        val spec = View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
        shadowView.measure(spec, spec)
        shadowView.layout(0, 0, shadowView.measuredWidth, shadowView.measuredHeight)
        val clip = ClipData(ClipDescription(label, arrayOf(ClipDescription.MIMETYPE_TEXT_PLAIN)), ClipData.Item(text))
        if (sensitive) {
          val key = if (Build.VERSION.SDK_INT >= 33) ClipDescription.EXTRA_IS_SENSITIVE else EXTRA_IS_SENSITIVE
          clip.description.extras = PersistableBundle().apply { putBoolean(key, true) }
        }
        started = activity.window.decorView.startDragAndDrop(clip, View.DragShadowBuilder(shadowView), null, View.DRAG_FLAG_GLOBAL)
      } catch (_: Exception) {
        started = false
      }
      result.putBoolean("started", started)
      result.putBoolean("multiWindow", true)
      promise.resolve(result)
    }
  }
}
