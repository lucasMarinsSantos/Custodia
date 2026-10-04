package com.custodia.modules

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/** Registra os módulos nativos do Custódia (Kotlin) no React Native. */
class CustodiaPackage : BaseReactPackage() {

  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      when (name) {
        SecurityModule.NAME -> SecurityModule(reactContext)
        SystemModule.NAME -> SystemModule(reactContext)
        else -> null
      }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    listOf(
            SecurityModule.NAME to SecurityModule::class.java.name,
            SystemModule.NAME to SystemModule::class.java.name,
        )
        .associate { (name, className) ->
          name to
              ReactModuleInfo(
                  name,
                  className,
                  false, // canOverrideExistingModule
                  false, // needsEagerInit
                  false, // isCxxModule
                  false, // isTurboModule (módulo legado via camada de interoperabilidade)
              )
        }
  }
}
