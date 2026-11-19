package cloud.memorycard.apkinstaller

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.result.ActivityResult
import androidx.core.content.ContextCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileInputStream
import java.util.concurrent.ConcurrentHashMap

@InvokeArg
class PathArgs {
    var path: String? = null
    /** Delete the downloaded .apk once it is installed (default true). */
    var deleteAfter: Boolean = true
}

@InvokeArg
class PackageArgs {
    var packageName: String? = null
}

/**
 * Game-launcher style APK install for the MemoryCard app:
 * the app downloads the APK itself, then this plugin hands it to the system through a PackageInstaller
 * session. Android shows its own "Instalar?" dialog (always; we can't and don't skip it) and the result
 * comes back to the app, so it can mark the port as installed and show "Jogar".
 */
@TauriPlugin
class ApkInstallerPlugin(private val activity: Activity) : Plugin(activity) {
    private val action = "${activity.packageName}.APK_INSTALL_STATUS"
    private val pending = ConcurrentHashMap<Int, Pair<Invoke, PathArgs>>()
    private var receiverRegistered = false

    private fun obj(vararg pairs: Pair<String, Any?>): JSObject {
        val o = JSObject()
        for ((k, v) in pairs) o.put(k, v)
        return o
    }

    private fun allowed(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) activity.packageManager.canRequestPackageInstalls() else true

    // ---------------------------------------------------------------- permission

    @Command
    fun canInstall(invoke: Invoke) {
        invoke.resolve(obj("supported" to true, "allowed" to allowed()))
    }

    @Command
    fun openInstallSettings(invoke: Invoke) {
        if (allowed() || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            invoke.resolve(obj("allowed" to allowed()))
            return
        }
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))
        startActivityForResult(invoke, intent, "installSettingsResult")
    }

    @ActivityCallback
    fun installSettingsResult(invoke: Invoke, @Suppress("UNUSED_PARAMETER") result: ActivityResult) {
        invoke.resolve(obj("allowed" to allowed()))
    }

    // ---------------------------------------------------------------- package info

    @Suppress("DEPRECATION")
    private fun archiveInfo(path: String): PackageInfo? {
        val pm = activity.packageManager
        val info = pm.getPackageArchiveInfo(path, 0) ?: return null
        info.applicationInfo?.let {
            it.sourceDir = path
            it.publicSourceDir = path
        }
        return info
    }

    @Suppress("DEPRECATION")
    private fun versionCodeOf(info: PackageInfo): Long =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()

    @Command
    fun packageInfo(invoke: Invoke) {
        val args = invoke.parseArgs(PathArgs::class.java)
        val path = args.path
        if (path.isNullOrBlank() || !File(path).isFile) {
            invoke.reject("Arquivo APK não encontrado")
            return
        }
        val info = archiveInfo(path)
        if (info == null) {
            invoke.reject("Este arquivo não é um APK válido")
            return
        }
        val label = info.applicationInfo?.loadLabel(activity.packageManager)?.toString()
        invoke.resolve(
            obj(
                "packageName" to info.packageName,
                "versionName" to info.versionName,
                "versionCode" to versionCodeOf(info),
                "label" to label,
            )
        )
    }

    @Suppress("DEPRECATION")
    private fun installedInfo(packageName: String): PackageInfo? =
        try {
            activity.packageManager.getPackageInfo(packageName, 0)
        } catch (e: PackageManager.NameNotFoundException) {
            null
        }

    @Command
    fun isInstalled(invoke: Invoke) {
        val name = invoke.parseArgs(PackageArgs::class.java).packageName
        if (name.isNullOrBlank()) {
            invoke.reject("packageName vazio")
            return
        }
        val info = installedInfo(name)
        invoke.resolve(obj("installed" to (info != null), "versionName" to info?.versionName))
    }

    // ---------------------------------------------------------------- install

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val sessionId = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
            val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                // The system "Instalar?" dialog: bring it up over the app
                @Suppress("DEPRECATION")
                val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                if (confirm != null) {
                    confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    try {
                        activity.startActivity(confirm)
                        return
                    } catch (e: Exception) {
                        finish(sessionId, false, false, "Não foi possível abrir o instalador: ${e.message}", null)
                        return
                    }
                }
            }
            val pkg = intent.getStringExtra(PackageInstaller.EXTRA_PACKAGE_NAME)
            val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
            when (status) {
                PackageInstaller.STATUS_SUCCESS -> finish(sessionId, true, false, null, pkg)
                PackageInstaller.STATUS_FAILURE_ABORTED -> finish(sessionId, false, true, "Instalação cancelada", pkg)
                PackageInstaller.STATUS_FAILURE_CONFLICT ->
                    finish(sessionId, false, false, "Já existe uma versão deste jogo assinada por outra pessoa. Desinstale a versão antiga e tente de novo.", pkg)
                PackageInstaller.STATUS_FAILURE_INCOMPATIBLE ->
                    finish(sessionId, false, false, "Este APK não é compatível com este aparelho.", pkg)
                PackageInstaller.STATUS_FAILURE_STORAGE ->
                    finish(sessionId, false, false, "Sem espaço no aparelho para instalar.", pkg)
                PackageInstaller.STATUS_FAILURE_BLOCKED ->
                    finish(sessionId, false, false, "A instalação foi bloqueada pelo Android.", pkg)
                else -> finish(sessionId, false, false, message ?: "A instalação falhou.", pkg)
            }
        }
    }

    private fun ensureReceiver() {
        if (receiverRegistered) return
        ContextCompat.registerReceiver(activity, receiver, IntentFilter(action), ContextCompat.RECEIVER_NOT_EXPORTED)
        receiverRegistered = true
    }

    private fun finish(sessionId: Int, installed: Boolean, cancelled: Boolean, message: String?, pkg: String?) {
        val (invoke, args) = pending.remove(sessionId) ?: return
        val info = pkg?.let { installedInfo(it) }
        if (installed && args.deleteAfter) args.path?.let { runCatching { File(it).delete() } }
        invoke.resolve(
            obj(
                "installed" to installed,
                "cancelled" to cancelled,
                "packageName" to pkg,
                "versionName" to info?.versionName,
                "message" to message,
            )
        )
    }

    @Command
    fun install(invoke: Invoke) {
        val args = invoke.parseArgs(PathArgs::class.java)
        val path = args.path
        val file = path?.let { File(it) }
        if (file == null || !file.isFile) {
            invoke.reject("Arquivo APK não encontrado")
            return
        }
        if (!allowed()) {
            invoke.reject("Permita \"Instalar apps desconhecidos\" para o MemoryCard", "INSTALL_NOT_ALLOWED")
            return
        }
        val info = archiveInfo(file.absolutePath)
        if (info == null) {
            invoke.reject("Este arquivo não é um APK válido")
            return
        }
        ensureReceiver()
        Thread {
            var sessionId = -1
            try {
                val installer = activity.packageManager.packageInstaller
                val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
                params.setAppPackageName(info.packageName)
                params.setSize(file.length())
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
                }
                sessionId = installer.createSession(params)
                pending[sessionId] = invoke to args
                installer.openSession(sessionId).use { session ->
                    session.openWrite("base.apk", 0, file.length()).use { out ->
                        FileInputStream(file).use { input -> input.copyTo(out, 1 shl 16) }
                        session.fsync(out)
                    }
                    var flags = PendingIntent.FLAG_UPDATE_CURRENT
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags = flags or PendingIntent.FLAG_MUTABLE
                    val status = PendingIntent.getBroadcast(
                        activity,
                        sessionId,
                        Intent(action).setPackage(activity.packageName),
                        flags,
                    )
                    session.commit(status.intentSender)
                }
            } catch (e: Exception) {
                if (sessionId >= 0) pending.remove(sessionId)
                invoke.reject("Não foi possível instalar: ${e.message}", e)
            }
        }.start()
    }

    // ---------------------------------------------------------------- open / uninstall

    @Command
    fun launch(invoke: Invoke) {
        val name = invoke.parseArgs(PackageArgs::class.java).packageName
        val intent = name?.let { activity.packageManager.getLaunchIntentForPackage(it) }
        if (intent == null) {
            invoke.resolve(obj("launched" to false))
            return
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        activity.startActivity(intent)
        invoke.resolve(obj("launched" to true))
    }

    @Command
    fun uninstall(invoke: Invoke) {
        val name = invoke.parseArgs(PackageArgs::class.java).packageName
        if (name.isNullOrBlank() || installedInfo(name) == null) {
            invoke.resolve(obj("uninstalled" to true))
            return
        }
        @Suppress("DEPRECATION")
        val intent = Intent(Intent.ACTION_UNINSTALL_PACKAGE, Uri.parse("package:$name"))
            .putExtra(Intent.EXTRA_RETURN_RESULT, true)
        uninstallTarget = name
        startActivityForResult(invoke, intent, "uninstallResult")
    }

    private var uninstallTarget: String? = null

    @ActivityCallback
    fun uninstallResult(invoke: Invoke, @Suppress("UNUSED_PARAMETER") result: ActivityResult) {
        val name = uninstallTarget
        uninstallTarget = null
        invoke.resolve(obj("uninstalled" to (name == null || installedInfo(name) == null)))
    }

    override fun onDestroy() {
        if (receiverRegistered) {
            runCatching { activity.unregisterReceiver(receiver) }
            receiverRegistered = false
        }
        super.onDestroy()
    }
}
