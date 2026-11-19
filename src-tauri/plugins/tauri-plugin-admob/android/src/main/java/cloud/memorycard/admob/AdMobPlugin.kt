package cloud.memorycard.admob

import android.app.Activity
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.android.gms.ads.AdError
import com.google.android.gms.ads.AdListener
import com.google.android.gms.ads.AdRequest
import com.google.android.gms.ads.AdSize
import com.google.android.gms.ads.AdView
import com.google.android.gms.ads.FullScreenContentCallback
import com.google.android.gms.ads.LoadAdError
import com.google.android.gms.ads.MobileAds
import com.google.android.gms.ads.RequestConfiguration
import com.google.android.gms.ads.interstitial.InterstitialAd
import com.google.android.gms.ads.interstitial.InterstitialAdLoadCallback
import com.google.android.ump.ConsentDebugSettings
import com.google.android.ump.ConsentRequestParameters
import com.google.android.ump.UserMessagingPlatform
import java.util.concurrent.atomic.AtomicBoolean

@InvokeArg
class InitializeArgs {
    /** Hashed device IDs that always get test ads (logcat prints the hash on first request). */
    var testDeviceIds: Array<String>? = null
    var tagForUnderAgeOfConsent: Boolean = false
    /** "eea" forces the GDPR consent form on a test device (debug only). */
    var debugGeography: String? = null
}

@InvokeArg
class AdUnitArgs {
    var adUnitId: String? = null
}

/**
 * Minimal AdMob bridge for the MemoryCard webview app:
 * - initialize: UMP consent (form only where the law requires it) then MobileAds.initialize
 * - showBanner / hideBanner: anchored adaptive banner pinned to the bottom, above the navigation bar
 * - loadInterstitial / showInterstitial: full-screen ad at a natural pause (never on launch)
 */
@TauriPlugin
class AdMobPlugin(private val activity: Activity) : Plugin(activity) {
    private var banner: AdView? = null
    private var bannerUnitId: String? = null
    private var bannerHeightDp = 0
    private var interstitial: InterstitialAd? = null
    private val sdkStarted = AtomicBoolean(false)

    @Volatile
    private var canRequestAds = false

    private fun obj(vararg pairs: Pair<String, Any?>): JSObject {
        val o = JSObject()
        for ((k, v) in pairs) o.put(k, v)
        return o
    }

    @Command
    fun initialize(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(InitializeArgs::class.java)
        } catch (e: Exception) {
            InitializeArgs()
        }
        activity.runOnUiThread {
            try {
                val consent = UserMessagingPlatform.getConsentInformation(activity)
                val params = ConsentRequestParameters.Builder()
                    .setTagForUnderAgeOfConsent(args.tagForUnderAgeOfConsent)
                if (args.debugGeography == "eea") {
                    val debug = ConsentDebugSettings.Builder(activity)
                        .setDebugGeography(ConsentDebugSettings.DebugGeography.DEBUG_GEOGRAPHY_EEA)
                    args.testDeviceIds?.forEach { debug.addTestDeviceHashedId(it) }
                    params.setConsentDebugSettings(debug.build())
                }
                consent.requestConsentInfoUpdate(
                    activity,
                    params.build(),
                    {
                        UserMessagingPlatform.loadAndShowConsentFormIfRequired(activity) { formError ->
                            startSdk(args, consent.canRequestAds(), invoke, formError?.message)
                        }
                    },
                    { requestError ->
                        // Offline etc.: a consent given earlier still allows ads.
                        startSdk(args, consent.canRequestAds(), invoke, requestError.message)
                    }
                )
            } catch (e: Exception) {
                invoke.reject(e.message ?: "AdMob initialize failed")
            }
        }
    }

    private fun startSdk(args: InitializeArgs, allowed: Boolean, invoke: Invoke, consentError: String?) {
        canRequestAds = allowed
        val result = obj("supported" to true, "canRequestAds" to allowed, "consentError" to consentError)
        if (!allowed) {
            invoke.resolve(result)
            return
        }
        if (sdkStarted.compareAndSet(false, true)) {
            val ids = args.testDeviceIds?.toList().orEmpty()
            if (ids.isNotEmpty()) {
                MobileAds.setRequestConfiguration(RequestConfiguration.Builder().setTestDeviceIds(ids).build())
            }
            // Google recommends initializing off the main thread.
            Thread { MobileAds.initialize(activity) }.start()
        }
        result.put("initialized", true)
        invoke.resolve(result)
    }

    @Command
    fun showBanner(invoke: Invoke) {
        val unitId = invoke.parseArgs(AdUnitArgs::class.java).adUnitId
        if (unitId.isNullOrBlank()) {
            invoke.reject("adUnitId is required")
            return
        }
        if (!canRequestAds) {
            invoke.resolve(obj("shown" to false, "height" to 0, "reason" to "no-consent-or-not-initialized"))
            return
        }
        activity.runOnUiThread {
            try {
                val current = banner
                if (current != null && bannerUnitId == unitId) {
                    current.visibility = View.VISIBLE
                    current.resume()
                    invoke.resolve(obj("shown" to true, "height" to bannerHeightDp))
                    return@runOnUiThread
                }
                destroyBanner()

                val root = activity.findViewById<ViewGroup>(android.R.id.content)
                val density = activity.resources.displayMetrics.density
                val widthPx = if (root.width > 0) root.width else activity.resources.displayMetrics.widthPixels
                @Suppress("DEPRECATION") // getLargeAnchoredAdaptiveBannerAdSize() is the 25.x replacement
                val size = AdSize.getCurrentOrientationAnchoredAdaptiveBannerAdSize(activity, (widthPx / density).toInt())

                val view = AdView(activity)
                view.adUnitId = unitId
                view.setAdSize(size)
                view.adListener = object : AdListener() {
                    private var settled = false
                    override fun onAdLoaded() {
                        if (settled) return
                        settled = true
                        invoke.resolve(obj("shown" to true, "height" to size.height))
                    }

                    override fun onAdFailedToLoad(error: LoadAdError) {
                        if (settled) return
                        settled = true
                        destroyBanner()
                        invoke.resolve(obj("shown" to false, "height" to 0, "error" to error.message))
                    }
                }

                val lp = FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
                )
                // Edge-to-edge (targetSdk 35+): keep the ad above the navigation bar. If the activity already
                // pads the content view by the system bars (MainActivity does), only add what's still missing.
                val navInset = ViewCompat.getRootWindowInsets(root)
                    ?.getInsets(WindowInsetsCompat.Type.systemBars())?.bottom ?: 0
                lp.bottomMargin = maxOf(0, navInset - root.paddingBottom)
                root.addView(view, lp)
                banner = view
                bannerUnitId = unitId
                bannerHeightDp = size.height
                view.loadAd(AdRequest.Builder().build())
            } catch (e: Exception) {
                invoke.reject(e.message ?: "showBanner failed")
            }
        }
    }

    @Command
    fun hideBanner(invoke: Invoke) {
        activity.runOnUiThread {
            banner?.let {
                it.pause()
                it.visibility = View.GONE
            }
            invoke.resolve(obj("shown" to false, "height" to 0))
        }
    }

    private fun destroyBanner() {
        banner?.let {
            (it.parent as? ViewGroup)?.removeView(it)
            it.destroy()
        }
        banner = null
        bannerUnitId = null
        bannerHeightDp = 0
    }

    @Command
    fun loadInterstitial(invoke: Invoke) {
        val unitId = invoke.parseArgs(AdUnitArgs::class.java).adUnitId
        if (unitId.isNullOrBlank()) {
            invoke.reject("adUnitId is required")
            return
        }
        if (!canRequestAds) {
            invoke.resolve(obj("loaded" to false, "reason" to "no-consent-or-not-initialized"))
            return
        }
        activity.runOnUiThread {
            InterstitialAd.load(activity, unitId, AdRequest.Builder().build(), object : InterstitialAdLoadCallback() {
                override fun onAdLoaded(ad: InterstitialAd) {
                    interstitial = ad
                    invoke.resolve(obj("loaded" to true))
                }

                override fun onAdFailedToLoad(error: LoadAdError) {
                    interstitial = null
                    invoke.resolve(obj("loaded" to false, "error" to error.message))
                }
            })
        }
    }

    @Command
    fun showInterstitial(invoke: Invoke) {
        val ad = interstitial
        if (ad == null) {
            invoke.resolve(obj("shown" to false, "reason" to "not-loaded"))
            return
        }
        interstitial = null // one show per load
        activity.runOnUiThread {
            ad.fullScreenContentCallback = object : FullScreenContentCallback() {
                override fun onAdDismissedFullScreenContent() {
                    invoke.resolve(obj("shown" to true))
                }

                override fun onAdFailedToShowFullScreenContent(error: AdError) {
                    invoke.resolve(obj("shown" to false, "error" to error.message))
                }
            }
            ad.show(activity)
        }
    }

    override fun onPause() {
        banner?.pause()
    }

    override fun onResume() {
        banner?.let { if (it.visibility == View.VISIBLE) it.resume() }
    }

    override fun onDestroy() {
        activity.runOnUiThread { destroyBanner() }
    }
}
