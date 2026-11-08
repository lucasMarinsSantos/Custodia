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
        FilesModule.NAME -> FilesModule(reactContext)
        NetModule.NAME -> NetModule(reactContext)
        NotificationModule.NAME -> NotificationModule(reactContext)
        TransferModule.NAME -> TransferModule(reactContext)
        BackupModule.NAME -> BackupModule(reactContext)
        OcrModule.NAME -> OcrModule(reactContext)
        AutofillModule.NAME -> AutofillModule(reactContext)
        DragModule.NAME -> DragModule(reactContext)
        BrowserBridgeModule.NAME -> BrowserBridgeModule(reactContext)
        else -> null
      }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    listOf(
            SecurityModule.NAME to SecurityModule::class.java.name,
            SystemModule.NAME to SystemModule::class.java.name,
            FilesModule.NAME to FilesModule::class.java.name,
            NetModule.NAME to NetModule::class.java.name,
            NotificationModule.NAME to NotificationModule::class.java.name,
            TransferModule.NAME to TransferModule::class.java.name,
            BackupModule.NAME to BackupModule::class.java.name,
            OcrModule.NAME to OcrModule::class.java.name,
            AutofillModule.NAME to AutofillModule::class.java.name,
            DragModule.NAME to DragModule::class.java.name,
            BrowserBridgeModule.NAME to BrowserBridgeModule::class.java.name,
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
