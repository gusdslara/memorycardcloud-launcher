package cloud.memorycard.webtab

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class OpenArgs {
    var url: String? = null
    /** "#rrggbb" for the tab's toolbar (defaults to the app's dark panel colour). */
    var toolbarColor: String? = null
}

/**
 * Web ports that need cross-origin isolation (SharedArrayBuffer / WASM threads) can't run in the
 * Android WebView, which has no COOP/COEP isolation. A Custom Tab runs them on the user's browser engine,
 * drawn over the app: Back or X closes it and the user is back in MemoryCard.
 */
@TauriPlugin
class WebTabPlugin(private val activity: Activity) : Plugin(activity) {

    private fun obj(vararg pairs: Pair<String, Any?>): JSObject {
        val o = JSObject()
        for ((k, v) in pairs) o.put(k, v)
        return o
    }

    @Command
    fun open(invoke: Invoke) {
        val args = invoke.parseArgs(OpenArgs::class.java)
        val url = args.url
        if (url.isNullOrBlank() || !(url.startsWith("https://") || url.startsWith("http://"))) {
            invoke.reject("URL inválida")
            return
        }
        val uri = Uri.parse(url)
        val color = try {
            Color.parseColor(args.toolbarColor ?: "#0f1115")
        } catch (_: IllegalArgumentException) {
            Color.parseColor("#0f1115")
        }

        activity.runOnUiThread {
            // A browser that supports Custom Tabs (Chrome, Edge, Samsung Internet, Firefox…)
            val provider = CustomTabsClient.getPackageName(activity, null)
            if (provider != null) {
                try {
                    val colors = CustomTabColorSchemeParams.Builder().setToolbarColor(color).build()
                    val tab = CustomTabsIntent.Builder()
                        .setDefaultColorSchemeParams(colors)
                        .setShowTitle(true)
                        .setUrlBarHidingEnabled(true)
                        .setShareState(CustomTabsIntent.SHARE_STATE_OFF)
                        .build()
                    tab.intent.setPackage(provider)
                    tab.launchUrl(activity, uri)
                    invoke.resolve(obj("supported" to true, "opened" to true, "customTab" to true))
                    return@runOnUiThread
                } catch (_: ActivityNotFoundException) {
                    // falls through to the plain browser
                }
            }
            try {
                activity.startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
                invoke.resolve(obj("supported" to true, "opened" to true, "customTab" to false))
            } catch (e: ActivityNotFoundException) {
                invoke.reject("Nenhum navegador instalado para abrir o jogo")
            }
        }
    }
}
