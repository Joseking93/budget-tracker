package com.basketbudget.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.print.PrintAttributes
import android.print.PrintManager
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewFeature
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import android.app.AlarmManager
import android.app.KeyguardManager
import android.app.PendingIntent
import android.content.ContentUris
import android.content.ContentValues
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.CancellationSignal
import android.os.Environment
import android.provider.MediaStore
import android.view.Gravity
import android.widget.Button

/**
 * Budget Tracker: the pages in assets/ (the tracker at index.html, Basket at
 * basket.html) in a WebView, plus the bridges only a phone can offer - the
 * camera and ML Kit for a till slip, and the M-PESA messages in the inbox.
 *
 * The page is served over https://appassets.androidplatform.net rather than
 * file://, so it gets a real origin and its localStorage ("basket-budget-v1")
 * survives restarts and app updates.
 */
class MainActivity : ComponentActivity() {

    private lateinit var web: WebView
    private lateinit var statusStrip: View

    /** Kept in step by the page through Android.setSheetOpen(). */
    private var sheetOpen = false

    /**
     * The page cannot be called into until it has loaded. Android can destroy
     * this activity while the camera is in front, so a result can arrive before
     * the reloaded page is ready; without this the call vanishes silently.
     */
    private var pageReady = false
    private val queuedJs = mutableListOf<String>()

    /** Set when the home-screen widget asked for a scan before the page loaded. */
    private var scanOnLoad = false

    /** The inbox widget asked for a read, so the next one is NOT quiet. */
    private var readOnLoad = false

    /** Whether the SMS read that is waiting on permission wants the whole inbox. */
    private var smsReadAll = false

    private val recognizer by lazy {
        TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    }

    /**
     * Where the camera was told to write. Held as a path and saved into the
     * instance state: the camera app is heavy and this activity is routinely
     * destroyed behind it, which used to lose the photo entirely.
     */
    private var pendingPhotoPath: String? = null
    private var pendingUpdate: Updater.Release? = null

    /** Work that can only happen on the shopping page, waiting for it to load. */
    private var afterBasket: (() -> Unit)? = null

    private val takePicture =
        registerForActivityResult(ActivityResultContracts.TakePicture()) { saved ->
            val file = pendingPhotoPath?.let { File(it) }
            pendingPhotoPath = null
            when {
                // The file on disk is the truth. Some camera apps report
                // RESULT_CANCELED even after writing a perfectly good photo.
                file != null && file.exists() && file.length() > 0 ->
                    recognise(FileProvider.getUriForFile(this, authority(), file))
                saved -> fail("The camera said it saved a photo, but nothing was written.")
                else -> scanCancelled()
            }
        }

    private val pickImage =
        registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
            if (uri != null) recognise(uri) else scanCancelled()
        }

    /** For a scan saved as a PDF, which is what phone document scanners make. */
    private val pickDocument =
        registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri != null) recognise(uri) else scanCancelled()
        }

    private val askCamera =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) launchCamera() else {
                scanCancelled()
                Toast.makeText(
                    this,
                    "Camera permission is needed to photograph a receipt. You can still pick a photo or a PDF.",
                    Toast.LENGTH_LONG,
                ).show()
            }
        }

    private val askSms =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                readMessages(smsReadAll)
            } else {
                smsSays(
                    "Android did not allow the messages to be read. You can still paste them " +
                        "in, or import a statement.",
                )
            }
        }

    @SuppressLint("SetJavaScriptEnabled")
    /** A backup file chosen to restore from. The page decides what to do with it. */
    private val pickBackup =
        registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri == null) return@registerForActivityResult
            val text = try {
                contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() }
            } catch (e: Exception) {
                null
            }
            if (text == null) {
                Toast.makeText(this, "Could not read that file.", Toast.LENGTH_LONG).show()
            } else {
                runJs("window.onBackupRead && window.onBackupRead(${JSONObject.quote(text)});")
            }
        }

    /** Android 13+ asks before an app may post notifications. The answer is kept by the system. */
    private val askNotify =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    /** For phones older than the biometric prompt: the lock screen itself. */
    private val confirmCredential =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            if (result.resultCode == RESULT_OK) unlocked() else lockMessage("Not unlocked.")
        }

    /** The opaque sheet over the page while the phone has not said who is holding it. */
    private var lockOverlay: View? = null
    private var unlockedAt = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pendingPhotoPath = savedInstanceState?.getString(KEY_PENDING_PHOTO)

        WindowCompat.setDecorFitsSystemWindows(window, false)
        @Suppress("UNUSED_VARIABLE")
        val brand = ContextCompat.getColor(this, R.color.brand)
        val saved = getSharedPreferences("chrome", MODE_PRIVATE)
        val pageBg = saved.getInt("bg", ContextCompat.getColor(this, R.color.page_bg))

        // A green strip of exactly the status bar's height, with the page below it.
        // Android 15+ ignores window.statusBarColor, so the colour is drawn here.
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(pageBg)
        }
        // The page runs edge to edge in one warm dark, so the strip matches it
        // rather than painting a band across the top.
        statusStrip = View(this).apply { setBackgroundColor(pageBg) }
        root.addView(
            statusStrip,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0),
        )

        web = WebView(this)
        root.addView(
            web,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f),
        )
        setContentView(root, FrameLayout.LayoutParams(-1, -1))

        @Suppress("DEPRECATION")
        window.statusBarColor = pageBg
        @Suppress("DEPRECATION")
        window.navigationBarColor = pageBg
        val bars = WindowInsetsControllerCompat(window, root)
        val startDark = saved.getBoolean("dark", isNight())
        bars.isAppearanceLightStatusBars = !startDark
        bars.isAppearanceLightNavigationBars = !startDark

        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val sys = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            statusStrip.layoutParams = statusStrip.layoutParams.apply { height = sys.top }
            statusStrip.requestLayout()
            // The keyboard must not sit on top of the price field.
            web.setPadding(sys.left, 0, sys.right, maxOf(sys.bottom, ime.bottom))
            insets
        }

        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web.setBackgroundColor(pageBg)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            // The page is entirely local; nothing should ever load off a network.
            blockNetworkLoads = true
            blockNetworkImage = true
            // ...which also means there is nothing to save by caching it. Every
            // asset keeps the same URL from one version of the app to the next,
            // so a cached copy outlives the update that replaced it - which is
            // how a parser fix shipped three times and never reached the phone.
            cacheMode = WebSettings.LOAD_NO_CACHE
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            // OFF. The page carries both themes and switches them itself; left
            // on, WebView darkens the light one into a near-black imitation of
            // the dark one and the switch appears to do nothing.
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(web.settings, false)
        }
        web.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? =
                assets.shouldInterceptRequest(request.url)?.also {
                    // Said out loud as well as asked for: the response headers
                    // are what a WebView honours when it decides to keep a copy.
                    val headers = it.responseHeaders?.toMutableMap() ?: mutableMapOf()
                    headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
                    headers["Pragma"] = "no-cache"
                    it.responseHeaders = headers
                }

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean = request.url.host != ASSET_HOST // stay inside the app

            override fun onPageFinished(view: WebView, url: String) {
                pageReady = true
                for (js in queuedJs) view.evaluateJavascript(js, null)
                queuedJs.clear()
                if (scanOnLoad) {
                    scanOnLoad = false
                    chooseSource()
                }
                if (url.endsWith(BASKET_PAGE)) {
                    afterBasket?.invoke()
                    afterBasket = null
                }
                // Once the permission is given, keep the tracker current by
                // itself: whatever M-PESA has sent since the last look is read
                // on the way in, and says nothing when there is nothing new.
                // Once the permission is given the tracker keeps itself current,
                // and says nothing when there is nothing new. A read the widget
                // asked for is the same read out loud - you asked, so it answers
                // either way.
                if (url.endsWith(HOME_PAGE)) {
                    val asked = readOnLoad
                    readOnLoad = false
                    when {
                        hasSms() -> readMessages(all = false, quiet = !asked)
                        // A widget tap that silently does nothing because the
                        // permission was never given is indistinguishable from
                        // a broken button, so ask for it then.
                        asked -> askSms.launch(Manifest.permission.READ_SMS)
                    }
                }
            }
        }
        // Without a WebChromeClient a WebView shows no alert, no confirm and no
        // console output - it discards them. The page's own "could not save"
        // warning was going nowhere for exactly that reason.
        web.webChromeClient = object : WebChromeClient() {
            override fun onJsAlert(
                view: WebView?,
                url: String?,
                message: String?,
                result: android.webkit.JsResult?,
            ): Boolean {
                AlertDialog.Builder(this@MainActivity)
                    .setMessage(message.orEmpty())
                    .setPositiveButton(android.R.string.ok) { _, _ -> result?.confirm() }
                    .setOnCancelListener { result?.cancel() }
                    .show()
                return true
            }

            override fun onJsConfirm(
                view: WebView?,
                url: String?,
                message: String?,
                result: android.webkit.JsResult?,
            ): Boolean {
                AlertDialog.Builder(this@MainActivity)
                    .setMessage(message.orEmpty())
                    .setPositiveButton(android.R.string.ok) { _, _ -> result?.confirm() }
                    .setNegativeButton(android.R.string.cancel) { _, _ -> result?.cancel() }
                    .setOnCancelListener { result?.cancel() }
                    .show()
                return true
            }
        }
        web.addJavascriptInterface(Bridge(), "Android")
        // The widget goes straight to the shopping page and opens the camera;
        // everything else starts at the tracker.
        //
        // Except when we are being rebuilt. Android restarts a killed task from
        // its BASE intent - the launcher's - so the widget's own intent is gone
        // by then, and a scan taken behind the camera would land back on the
        // tracker. If a photo is still in flight, or the page we were on was
        // saved, that is where to come back to.
        val wantsScan = intent?.getBooleanExtra(ScanWidget.EXTRA_SCAN, false) == true
        readOnLoad = intent?.getBooleanExtra(InboxWidget.EXTRA_INBOX, false) == true
        val returning = pendingPhotoPath != null
        // Not while a photo is already on its way back: that would open the
        // camera a second time for a receipt we are holding.
        scanOnLoad = wantsScan && !returning
        val start = when {
            returning || wantsScan -> BASKET_PAGE
            else -> savedInstanceState?.getString(KEY_PAGE) ?: HOME_PAGE
        }
        web.loadUrl("https://$ASSET_HOST/assets/" + start)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // Back has three jobs, in this order: close what is open, go
                // back a screen, leave. It only ever did the first and the
                // last, so from any screen inside the app - a report, the
                // settings, the transaction list - back quit the app instead
                // of returning to where you came from. The page pushes a
                // history entry per screen, so the WebView already knows.
                when {
                    sheetOpen -> {
                        runJs("window.bbCloseSheet && window.bbCloseSheet();")
                        sheetOpen = false
                    }
                    web.canGoBack() -> web.goBack()
                    else -> finish()
                }
            }
        })
    }

    /** singleTop: the widget reuses this activity rather than stacking a copy. */
    // ------------------------------------------------------------------ lock
    //
    // The lock is a sheet over the page, not a check in the page: a WebView
    // cannot ask the phone who is holding it. It comes down when the app comes
    // to the front after being away, but not after a short hop out to the
    // camera or a file picker, which also comes back through onStart.

    override fun onStart() {
        super.onStart()
        if (lockEnabled() && System.currentTimeMillis() - unlockedAt > LOCK_GRACE_MS) {
            showLock()
            promptUnlock()
        }
    }

    override fun onStop() {
        super.onStop()
        // Leaving while unlocked starts the grace period; leaving while still
        // locked does not, or a hop out and back would walk straight in.
        if (lockOverlay == null) unlockedAt = System.currentTimeMillis()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)

        if (intent.getBooleanExtra(InboxWidget.EXTRA_INBOX, false)) {
            // Already here and on the tracker: just read. Anywhere else, go to
            // the tracker first - the messages become transactions there, and
            // landing on the page that shows them is half the answer.
            if (web.url?.endsWith(HOME_PAGE) == true && pageReady) {
                if (hasSms()) readMessages(all = false) else askSms.launch(Manifest.permission.READ_SMS)
            } else {
                readOnLoad = true
                pageReady = false
                web.loadUrl("https://$ASSET_HOST/assets/" + HOME_PAGE)
            }
            return
        }

        if (!intent.getBooleanExtra(ScanWidget.EXTRA_SCAN, false)) return
        val onBasket = web.url?.endsWith(BASKET_PAGE) == true
        if (onBasket && pageReady) {
            chooseSource()
        } else {
            // Scanning adds to the shopping list, so it has to happen there.
            scanOnLoad = true
            pageReady = false
            web.loadUrl("https://$ASSET_HOST/assets/" + BASKET_PAGE)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        pendingPhotoPath?.let { outState.putString(KEY_PENDING_PHOTO, it) }
        web.url?.substringAfterLast('/')?.let { outState.putString(KEY_PAGE, it) }
    }

    override fun onDestroy() {
        recognizer.close()
        super.onDestroy()
    }

    private fun isNight(): Boolean =
        (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES

    private fun authority() = "$packageName.fileprovider"

    /** Calls into the page, waiting for it to load if a result beat it there. */
    private fun runJs(js: String) {
        if (pageReady) web.evaluateJavascript(js, null) else queuedJs.add(js)
    }

    // ---------------------------------------------------------------- bridge

    inner class Bridge {
        /** Fallback for navigator.clipboard, which a WebView can refuse. */
        @JavascriptInterface
        fun copyToClipboard(text: String) {
            runOnUiThread {
                val clip = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                clip.setPrimaryClip(ClipData.newPlainText("Basket Budget list", text))
            }
        }

        /** So the hardware back button closes an open sheet before the app. */
        @JavascriptInterface
        fun setSheetOpen(open: Boolean) {
            sheetOpen = open
        }

        /**
         * Writes a backup where an uninstall cannot reach it. Everything the app
         * knows lives in the WebView's storage, which goes with the app; a file
         * in Downloads does not. Returns "ok:<where>" or "err:<why>".
         */
        @JavascriptInterface
        fun saveBackup(name: String, json: String): String = writeBackup(name, json)

        @JavascriptInterface
        fun restoreBackup() {
            runOnUiThread { pickBackup.launch(arrayOf("application/json", "text/*", "*/*")) }
        }

        /** A budget line nearly spent, or gone over. Posted while the app is open. */
        @JavascriptInterface
        fun notify(id: Int, title: String, text: String) {
            runOnUiThread {
                if (!ensureNotifyPermission()) return@runOnUiThread
                ReminderReceiver.post(this@MainActivity, id, title, text)
            }
        }

        /** The words for the last-day reminder, and when. Replaces the previous one. */
        @JavascriptInterface
        fun scheduleReminder(atMillis: Double, title: String, text: String) {
            runOnUiThread { scheduleReminderAt(atMillis.toLong(), title, text) }
        }

        /** Whether this phone has a screen lock to lean on at all. */
        @JavascriptInterface
        fun canLock(): Boolean =
            (getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isDeviceSecure

        @JavascriptInterface
        fun isLockEnabled(): Boolean = lockEnabled()

        @JavascriptInterface
        fun setLockEnabled(on: Boolean) {
            getSharedPreferences(LOCK_PREFS, MODE_PRIVATE).edit().putBoolean(KEY_LOCK, on).apply()
            // Switching it on counts as having just unlocked: no prompt on the
            // very next tap.
            if (on) unlockedAt = System.currentTimeMillis()
        }

        /**
         * Hands the page to Android's print system, whose dialog offers "Save
         * as PDF". No library, and nothing to download - which matters for an
         * app with no internet permission.
         */
        @JavascriptInterface
        fun printPage(name: String) {
            runOnUiThread {
                val title = name.replace(Regex("""[^A-Za-z0-9 ._-]"""), "")
                    .trim().ifEmpty { "Receipt" }
                val manager = getSystemService(Context.PRINT_SERVICE) as PrintManager
                manager.print(
                    title,
                    web.createPrintDocumentAdapter(title),
                    PrintAttributes.Builder()
                        .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                        .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                        .build(),
                )
            }
        }

        /** The page owns the colours; the system bars have to be told. */
        @JavascriptInterface
        fun setChrome(color: String, darkTheme: Boolean) {
            runOnUiThread {
                val tint = try {
                    android.graphics.Color.parseColor(color)
                } catch (e: IllegalArgumentException) {
                    return@runOnUiThread
                }
                // Remembered so the next launch opens in the right colour
                // instead of flashing the other theme.
                getSharedPreferences("chrome", MODE_PRIVATE).edit()
                    .putInt("bg", tint).putBoolean("dark", darkTheme).apply()
                statusStrip.setBackgroundColor(tint)
                findViewById<View>(android.R.id.content).rootView.setBackgroundColor(tint)
                web.setBackgroundColor(tint)
                @Suppress("DEPRECATION")
                window.statusBarColor = tint
                @Suppress("DEPRECATION")
                window.navigationBarColor = tint
                WindowInsetsControllerCompat(window, window.decorView).apply {
                    isAppearanceLightStatusBars = !darkTheme
                    isAppearanceLightNavigationBars = !darkTheme
                }
            }
        }

        /** What this build calls itself, for the update row. */
        @JavascriptInterface
        fun appVersion(): String = BuildConfig.VERSION_NAME

        /** Asks GitHub whether there is a newer build. Only ever on request. */
        @JavascriptInterface
        fun checkUpdate() {
            Thread {
                val release = Updater.latest()
                runOnUiThread {
                    pendingUpdate = release
                    when {
                        release == null ->
                            updateSays("Could not reach GitHub. Check the connection and try again.", false)
                        Updater.isNewer(release.version, BuildConfig.VERSION_NAME) ->
                            updateSays("Version " + release.version + " is ready to install.", true)
                        else ->
                            updateSays("You are on the newest version.", false)
                    }
                }
            }.start()
        }

        @JavascriptInterface
        fun installUpdate() {
            // A bridge method arrives on the JavaBridge thread, and every WebView
            // call has to be on the UI thread. Saying "Downloading" from here threw
            // before the download had even started, and the page's own catch
            // swallowed it - which is exactly why the button appeared to do
            // nothing at all. Everything that talks to the page goes through here.
            runOnUiThread { downloadUpdate() }
        }

        @JavascriptInterface
        fun scanReceipt() {
            runOnUiThread { chooseSource() }
        }

        /** So the page only offers the button on a phone that can do it. */
        /**
         * The page's own summary of the cycle, for the home-screen widget.
         *
         * The transactions live in the WebView's storage, which Android cannot
         * read, so the figure has to come the other way. Sent on every render
         * of the home screen - cheap, and it means the widget is never older
         * than the last time the app was open.
         */
        @JavascriptInterface
        fun setSpendSummary(amount: String, note: String, pct: Int) {
            runOnUiThread { SpendWidget.say(this@MainActivity, amount, note, pct) }
        }

        @JavascriptInterface
        fun canReadSms(): Boolean = true

        /**
         * Reads M-PESA's messages out of the inbox and hands them to the page,
         * which already knows how to turn them into transactions.
         *
         * @param all true re-reads the whole inbox; false only what is new
         *            since the last read, which is what the button does.
         */
        @JavascriptInterface
        fun readSms(all: Boolean) {
            runOnUiThread {
                smsReadAll = all
                if (hasSms()) {
                    readMessages(all)
                } else {
                    askSms.launch(Manifest.permission.READ_SMS)
                }
            }
        }
    }

    private fun downloadUpdate() {
        val release = pendingUpdate ?: run {
            updateSays("Check for an update first.", false)
            return
        }
        updateSays("Downloading…", false)
        Thread {
            val dir = File(cacheDir, "updates").apply { mkdirs() }
            val file = Updater.download(release.apkUrl, dir)
            runOnUiThread {
                if (file == null) {
                    updateSays("The download did not finish. Try again.", true)
                } else {
                    updateSays("Opening the installer…", false)
                    openInstaller(file)
                }
            }
        }.start()
    }

    // ------------------------------------------------------------------ sms

    private fun hasSms(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.READ_SMS) ==
            PackageManager.PERMISSION_GRANTED

    /**
     * @param quiet a read nobody asked for, on the way into the app: it says
     *   nothing unless it actually found something.
     */
    private fun readMessages(all: Boolean, quiet: Boolean = false) {
        val prefs = getSharedPreferences(SMS_PREFS, MODE_PRIVATE)
        // Only what has arrived since last time, so re-reading is quick. The
        // page ignores duplicates anyway - every transaction is keyed by its
        // M-PESA receipt - so this is about speed, not correctness.
        // When the reader learns new senders (6.47: M-Shwari, NCBA) the old
        // messages from them are older than the last look, so the first read
        // after the update is a full one. Duplicates are dropped by the page.
        val fullOnce = prefs.getInt(KEY_READER_GEN, 0) < READER_GEN
        val since = if (all || fullOnce) 0L else prefs.getLong(KEY_NEWEST_SMS, 0L)
        if (!quiet) {
            smsSays(
                if (all) "Reading every M-PESA message" + ELLIPSIS
                else "Looking for new messages" + ELLIPSIS
            )
        }
        Thread {
            val batch = try {
                SmsReader.read(this, since)
            } catch (e: Exception) {
                // A handset that keeps its inbox somewhere else, or a security
                // policy that refuses: say so instead of appearing to hang.
                if (!quiet) {
                    runOnUiThread { smsSays("Android would not hand over the messages on this phone.") }
                }
                return@Thread
            }
            runOnUiThread {
                if (batch.newest > since) {
                    prefs.edit().putLong(KEY_NEWEST_SMS, batch.newest).apply()
                }
                if (fullOnce) prefs.edit().putInt(KEY_READER_GEN, READER_GEN).apply()
                // The widget carries the answer whichever way the read was
                // started, so "is the tracker up to date" can be settled from
                // the home screen without opening anything.
                InboxWidget.say(this, widgetLine(batch.messages.size))
                if (quiet && batch.messages.isEmpty()) return@runOnUiThread
                deliverSms(batch.messages, batch.truncated, batch.newest)
            }
        }.start()
    }

    /**
     * In batches, because one evaluateJavascript carrying a whole inbox is a
     * single enormous string across a process boundary and can simply fail.
     */
    private fun deliverSms(messages: List<String>, truncated: Boolean = false, newest: Long = 0L) {
        if (messages.isEmpty()) {
            runJs("window.onSmsBatch && window.onSmsBatch('', true, 0, false, 0);")
            return
        }
        val chunks = messages.chunked(SMS_CHUNK)
        chunks.forEachIndexed { index, chunk ->
            val text = JSONObject.quote(chunk.joinToString(BLANK_LINE))
            val last = index == chunks.size - 1
            runJs(
                // The newest message's own timestamp goes over too. When a read
                // brings in thousands and the app still looks empty, the only
                // question worth asking is how recent the INBOX is, and nothing
                // could answer it without going to look in another app.
                "window.onSmsBatch && window.onSmsBatch(" + text + ", " + last + ", " +
                    messages.size + ", " + truncated + ", " + newest + ");"
            )
        }
    }

    /** What the widget shows until the next read. */
    private fun widgetLine(found: Int): String {
        val at = java.text.SimpleDateFormat("HH:mm", java.util.Locale.UK).format(java.util.Date())
        return when (found) {
            0 -> "Up to date " + BULLET + " " + at
            1 -> "1 new " + BULLET + " " + at
            else -> "" + found + " new " + BULLET + " " + at
        }
    }

    private fun smsSays(message: String) {
        runJs("window.onSmsStatus && window.onSmsStatus(" + JSONObject.quote(message) + ");")
    }

    // ------------------------------------------------------------- scanning

    private fun chooseSource() {
        AlertDialog.Builder(this)
            .setTitle("Scan a receipt")
            .setItems(arrayOf("Take a photo", "Choose a photo", "Choose a PDF or image")) { _, which ->
                when (which) {
                    0 -> startCamera()
                    1 -> pickImage.launch(
                        PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                    )
                    else -> pickDocument.launch(arrayOf("application/pdf", "image/*"))
                }
            }
            .setOnCancelListener { scanCancelled() }
            .show()
    }

    private fun startCamera() {
        // Asked for only now, when the camera is actually the chosen route.
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            launchCamera()
        } else {
            askCamera.launch(Manifest.permission.CAMERA)
        }
    }

    private fun launchCamera() {
        try {
            val dir = File(cacheDir, "receipts").apply { mkdirs() }
            val file = File(dir, "receipt-${System.currentTimeMillis()}.jpg")
            val uri = FileProvider.getUriForFile(this, authority(), file)
            pendingPhotoPath = file.absolutePath
            takePicture.launch(uri)
        } catch (e: Exception) {
            pendingPhotoPath = null
            scanCancelled()
            Toast.makeText(this, "Could not open the camera.", Toast.LENGTH_LONG).show()
        }
    }

    /**
     * Runs [block] on the shopping page, loading it first if we are not there.
     *
     * Everything a scan reports - the progress sheet, the lines it read, a
     * failure - is a function that only basket.html defines. Calling one from
     * the tracker is not an error anywhere; it simply does nothing, which is
     * exactly what a scan looked like when the camera had taken the activity
     * down with it.
     */
    private fun onBasketPage(block: () -> Unit) {
        val here = web.url?.endsWith(BASKET_PAGE) == true
        if (here && pageReady) {
            block()
            return
        }
        afterBasket = block
        if (!here) {
            pageReady = false
            web.loadUrl("https://$ASSET_HOST/assets/" + BASKET_PAGE)
        }
    }

    private fun recognise(uri: Uri) = onBasketPage { recogniseOnBasket(uri) }

    private fun recogniseOnBasket(uri: Uri) {
        runJs("window.onReceiptScanning && window.onReceiptScanning();")
        sheetOpen = true
        try {
            if (looksLikePdf(uri)) recognisePdf(uri) else recogniseImage(uri)
        } catch (e: Exception) {
            fail("That file could not be opened.")
        }
    }

    private fun recogniseImage(uri: Uri) {
        recognizer.process(InputImage.fromFilePath(this, uri))
            .addOnSuccessListener { text ->
                val (scan, rows) = parse(linesOf(text, 0))
                deliver(scan, rows)
            }
            .addOnFailureListener { fail("The text on that photo could not be read.") }
    }

    /** A phone document scanner saves a PDF, so each page is rendered and read. */
    private fun recognisePdf(uri: Uri) {
        val pages = mutableListOf<Bitmap>()
        contentResolver.openFileDescriptor(uri, "r").use { descriptor ->
            if (descriptor == null) {
                fail("That PDF could not be opened.")
                return
            }
            PdfRenderer(descriptor).use { renderer ->
                val count = minOf(renderer.pageCount, MAX_PDF_PAGES)
                for (index in 0 until count) {
                    renderer.openPage(index).use { page ->
                        val scale = (PDF_TARGET_WIDTH.toFloat() / page.width).coerceIn(1f, 4f)
                        val bitmap = Bitmap.createBitmap(
                            (page.width * scale).toInt(),
                            (page.height * scale).toInt(),
                            Bitmap.Config.ARGB_8888,
                        )
                        // PDF pages render onto transparency; OCR needs paper.
                        bitmap.eraseColor(Color.WHITE)
                        page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                        pages.add(bitmap)
                    }
                }
            }
        }
        if (pages.isEmpty()) fail("That PDF has no pages.") else recognisePages(pages)
    }

    private fun recognisePages(pages: List<Bitmap>) {
        val lines = mutableListOf<OcrLine>()
        fun step(index: Int) {
            if (index >= pages.size) {
                val (scan, rows) = parse(lines)
                deliver(scan, rows)
                return
            }
            recognizer.process(InputImage.fromBitmap(pages[index], 0))
                .addOnSuccessListener { text ->
                    // Pages are pushed far apart so no row spans two of them.
                    lines += linesOf(text, index * PAGE_STRIDE)
                    step(index + 1)
                }
                .addOnFailureListener { fail("That PDF could not be read.") }
        }
        step(0)
    }

    /**
     * ML Kit reports axis-aligned boxes, so a slip photographed at an angle puts
     * the amount column a whole line below the name it belongs to. The page's
     * tilt is measured from the text itself and taken out here, so the rows
     * group the way they read on paper.
     */
    private fun linesOf(text: Text, yOffset: Int): List<OcrLine> {
        val lines = text.textBlocks.flatMap { it.lines }
        val slope = tiltOf(lines)
        return lines.mapNotNull { line ->
            line.boundingBox?.let { box ->
                val level = (slope * (box.left + box.right) / 2.0).toInt()
                OcrLine(
                    line.text,
                    box.left,
                    box.top + yOffset - level,
                    box.right,
                    box.bottom + yOffset - level,
                )
            }
        }
    }

    /** Average rise over run across the page's text, in pixels. */
    private fun tiltOf(lines: List<Text.Line>): Double {
        var rise = 0.0
        var run = 0.0
        for (line in lines) {
            val corners = line.cornerPoints ?: continue
            if (corners.size < 2) continue
            val dx = (corners[1].x - corners[0].x).toDouble()
            if (dx < 40) continue // too short to say anything about the tilt
            rise += corners[1].y - corners[0].y
            run += dx
        }
        return if (run <= 0.0) 0.0 else (rise / run).coerceIn(-0.35, 0.35)
    }

    /** The rows are kept so the raw read can be copied out when it goes wrong. */
    private fun parse(lines: List<OcrLine>): Pair<ReceiptScan, List<String>> {
        val rows = ReceiptParser.rowsFrom(lines)
        return ReceiptParser.parse(rows) to rows
    }

    private fun looksLikePdf(uri: Uri): Boolean {
        if (contentResolver.getType(uri) == "application/pdf") return true
        return try {
            contentResolver.openInputStream(uri)?.use { stream ->
                val head = ByteArray(5)
                stream.read(head) == 5 && String(head) == "%PDF-"
            } ?: false
        } catch (e: Exception) {
            false
        }
    }

    private fun deliver(
        scan: ReceiptScan,
        rows: List<String> = emptyList(),
        message: String? = null,
    ) {
        val items = JSONArray()
        for (item in scan.items) {
            items.put(
                JSONObject()
                    .put("name", item.name)
                    .put("qty", item.qty)
                    .put("price", item.price)
                    .put("total", item.total)
            )
        }
        val payload = JSONObject()
            .put("items", items)
            .put("receiptTotal", scan.receiptTotal ?: JSONObject.NULL)
            .put("lineCount", scan.lineCount ?: JSONObject.NULL)
            .put("message", message ?: JSONObject.NULL)
            .put("rows", JSONArray(rows))
        runJs("window.onReceiptScanned($payload);")
        sheetOpen = true
    }

    private fun updateSays(message: String, canInstall: Boolean) {
        runJs("window.onUpdateStatus && window.onUpdateStatus(" +
            JSONObject.quote(message) + "," + canInstall + ");")
    }

    private fun openInstaller(file: File) {
        // Android 8 and later require this app to be trusted to install others.
        // Say so rather than letting the system's refusal read as a dead button.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !packageManager.canRequestPackageInstalls()) {
            updateSays(
                "Android has to let this app install updates: allow \"Install unknown apps\" " +
                    "when it asks, then tap Install it again.",
                true,
            )
        }
        try {
            val uri = FileProvider.getUriForFile(this, authority(), file)
            startActivity(
                android.content.Intent(android.content.Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, "application/vnd.android.package-archive")
                    addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            )
        } catch (e: Exception) {
            updateSays("Android would not open the installer.", true)
        }
    }

    // ---------------------------------------------------------------- backup

    private fun writeBackup(name: String, json: String): String {
        try {
            val bytes = json.toByteArray()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val dir = Environment.DIRECTORY_DOWNLOADS + "/" + BACKUP_DIR
                val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI
                // The same day's file is replaced, not kept beside it as "(1)".
                contentResolver.query(
                    collection,
                    arrayOf(MediaStore.Downloads._ID),
                    "${MediaStore.Downloads.RELATIVE_PATH} LIKE ? AND ${MediaStore.Downloads.DISPLAY_NAME} = ?",
                    arrayOf("$dir%", name),
                    null,
                )?.use { c ->
                    while (c.moveToNext()) {
                        contentResolver.delete(ContentUris.withAppendedId(collection, c.getLong(0)), null, null)
                    }
                }
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, name)
                    put(MediaStore.Downloads.MIME_TYPE, "application/json")
                    put(MediaStore.Downloads.RELATIVE_PATH, dir)
                }
                val uri = contentResolver.insert(collection, values)
                    ?: return "err:Android gave no file to write to"
                contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                    ?: return "err:could not open the file"
                pruneBackups(dir)
                return "ok:Download/$BACKUP_DIR/$name"
            }
            // Before Android 10 there is no way into Downloads without a storage
            // permission. The app's own external folder survives updates, not an
            // uninstall - and the page says so.
            val dir = File(getExternalFilesDir(null), "backups").apply { mkdirs() }
            File(dir, name).writeBytes(bytes)
            dir.listFiles { f -> f.name.startsWith(BACKUP_PREFIX) }
                ?.sortedByDescending { it.name }
                ?.drop(KEEP_BACKUPS)
                ?.forEach { it.delete() }
            return "ok:${File(dir, name).absolutePath}"
        } catch (e: Exception) {
            return "err:${e.message ?: e.javaClass.simpleName}"
        }
    }

    /** Keeps the newest KEEP_BACKUPS files this app wrote there; the names sort by date. */
    private fun pruneBackups(dir: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI
        val found = mutableListOf<Pair<String, Long>>()
        contentResolver.query(
            collection,
            arrayOf(MediaStore.Downloads._ID, MediaStore.Downloads.DISPLAY_NAME),
            "${MediaStore.Downloads.RELATIVE_PATH} LIKE ? AND ${MediaStore.Downloads.DISPLAY_NAME} LIKE ?",
            arrayOf("$dir%", "$BACKUP_PREFIX%"),
            null,
        )?.use { c ->
            while (c.moveToNext()) found.add(c.getString(1) to c.getLong(0))
        }
        found.sortedByDescending { it.first }.drop(KEEP_BACKUPS).forEach { (_, id) ->
            try {
                contentResolver.delete(ContentUris.withAppendedId(collection, id), null, null)
            } catch (e: Exception) {
                // Someone else's file of the same name pattern: leave it.
            }
        }
    }

    // --------------------------------------------------------- notifications

    private fun ensureNotifyPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) askNotify.launch(Manifest.permission.POST_NOTIFICATIONS)
        return granted
    }

    private fun scheduleReminderAt(at: Long, title: String, text: String) {
        getSharedPreferences(ReminderReceiver.PREFS, MODE_PRIVATE).edit()
            .putString(ReminderReceiver.KEY_TITLE, title)
            .putString(ReminderReceiver.KEY_TEXT, text)
            .apply()
        if (at <= System.currentTimeMillis()) return
        val fire = PendingIntent.getBroadcast(
            this,
            ReminderReceiver.REMINDER_ID,
            Intent(this, ReminderReceiver::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val alarms = getSystemService(Context.ALARM_SERVICE) as AlarmManager
        // Inexact is fine for a morning reminder, and needs no alarm permission.
        alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, fire)
    }

    // ------------------------------------------------------------------ lock

    private fun lockEnabled() =
        getSharedPreferences(LOCK_PREFS, MODE_PRIVATE).getBoolean(KEY_LOCK, false)

    private fun showLock() {
        if (lockOverlay != null) return
        val bg = getSharedPreferences("chrome", MODE_PRIVATE)
            .getInt("bg", ContextCompat.getColor(this, R.color.page_bg))
        val button = Button(this).apply {
            text = "Unlock"
            setOnClickListener { promptUnlock() }
        }
        val overlay = FrameLayout(this).apply {
            setBackgroundColor(bg)
            isClickable = true // swallows every touch meant for the page under it
            addView(button, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))
        }
        // On the window's own content frame, so it sits OVER the page rather
        // than being stacked below it by the vertical layout the page lives in.
        addContentView(overlay, ViewGroup.LayoutParams(-1, -1))
        lockOverlay = overlay
    }

    private fun hideLock() {
        val overlay = lockOverlay ?: return
        (overlay.parent as? ViewGroup)?.removeView(overlay)
        lockOverlay = null
    }

    private fun unlocked() {
        unlockedAt = System.currentTimeMillis()
        hideLock()
    }

    private fun lockMessage(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    private fun promptUnlock() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val builder = BiometricPrompt.Builder(this)
                .setTitle("Budget Tracker")
                .setSubtitle("Unlock to continue")
            when {
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ->
                    builder.setAllowedAuthenticators(
                        BiometricManager.Authenticators.BIOMETRIC_WEAK or
                            BiometricManager.Authenticators.DEVICE_CREDENTIAL,
                    )
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ->
                    @Suppress("DEPRECATION")
                    builder.setDeviceCredentialAllowed(true)
                else ->
                    // Android 9 has fingerprints but no PIN fallback in the prompt.
                    builder.setNegativeButton("Use PIN", mainExecutor) { _, _ -> keyguardUnlock() }
            }
            builder.build().authenticate(
                CancellationSignal(),
                mainExecutor,
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        unlocked()
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        lockMessage(errString.toString())
                    }
                },
            )
        } else {
            keyguardUnlock()
        }
    }

    private fun keyguardUnlock() {
        val keyguard = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        @Suppress("DEPRECATION")
        val intent = keyguard.createConfirmDeviceCredentialIntent("Budget Tracker", "Unlock to continue")
        if (intent == null) unlocked() else confirmCredential.launch(intent)
    }

    /** Says what went wrong in the sheet. Silence is what made this hard to find. */
    private fun fail(message: String) = onBasketPage {
        deliver(ReceiptScan(emptyList(), null), emptyList(), message)
    }

    /** Nothing was photographed or picked, so leave the page as it was. */
    private fun scanCancelled() {
        if (web.url?.endsWith(BASKET_PAGE) != true) return
        runJs("window.bbCloseSheet && window.bbCloseSheet();")
        sheetOpen = false
    }

    private companion object {
        const val ASSET_HOST = "appassets.androidplatform.net"
        const val HOME_PAGE = "index.html"
        const val BASKET_PAGE = "basket.html"
        const val SMS_PREFS = "sms"
        const val KEY_NEWEST_SMS = "newest"
        const val KEY_READER_GEN = "readerGen"
        /** Bump when the reader starts handing over messages it used to skip. */
        const val READER_GEN = 3
        const val SMS_CHUNK = 200
        /** A blank line between messages is what the page's splitter expects. */
        const val BLANK_LINE = "\n\n"
        const val ELLIPSIS = "\u2026"
        const val BULLET = "\u00b7"
        const val KEY_PENDING_PHOTO = "pendingPhotoPath"
        const val KEY_PAGE = "page"
        const val LOCK_PREFS = "lock"
        const val KEY_LOCK = "on"
        /** A hop out to the camera or a picker and back does not re-ask. */
        const val LOCK_GRACE_MS = 90_000L
        const val BACKUP_DIR = "BudgetTracker"
        const val BACKUP_PREFIX = "budget-backup-"
        const val KEEP_BACKUPS = 10
        const val MAX_PDF_PAGES = 5
        const val PDF_TARGET_WIDTH = 1600
        const val PAGE_STRIDE = 1_000_000
    }
}
