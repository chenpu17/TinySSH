package com.tinyssh.app

import android.content.Context
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.hardware.SensorManager
import android.hardware.input.InputManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.InputDevice
import android.view.OrientationEventListener
import android.view.View
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicBoolean

class MainActivity : TauriActivity() {
  private var contentWebView: WebView? = null

  companion object {
    /** 返回键等 WebView 应答的上限：正常几毫秒，超时按渲染进程无应答处理。 */
    private const val BACK_FALLBACK_MS = 400L

    /** 页面取色函数的合法返回值（evaluateJavascript 回给的是 JSON 字面量，带引号）。 */
    private val EDGE_BG = Regex("\"(#[0-9a-fA-F]{6})\"")

    /** 冷启动种子的 SharedPreferences 文件与键（见 [restoreChromeSeed]）。恢复页
     *  「重置本地数据」会连带清掉这个文件。 */
    const val SEED_STORE = "chrome-seed"
    private const val SEED_EDGE_BG = "edge_bg"
    private const val SEED_BARS_LIGHT = "bars_light"

    /** 供 Rust 经 JNI（Application context 的 ClassLoader 载入本类）回调。 */
    private var current: WeakReference<MainActivity>? = null

    /** Activity 不在时（后台/重建窗口）查询物理键盘的兜底来源：Application context
     *  是进程生命期对象，不构成 Activity 泄漏。 */
    private var appContext: Context? = null

    /**
     * 系统栏图标深浅跟随应用主题（KI-060）：应用浅色而系统深色时，纯白状态栏图标
     * 压在浅色背景上不可读。WeakReference 防泄漏；view.post 保证在主线程操作
     * View/WindowInsetsController（JNI 调用可能来自 Rust 后台线程）。
     * 同时把窗口底色重新对齐页面底色（[syncEdgeBackground]）：图标深浅与窗口底色
     * 都由页面驱动，前端在两者可能变化的时机调本命令，命令线不变。
     */
    @JvmStatic
    fun setSystemBarsLight(light: Boolean) {
      val a = current?.get() ?: return
      a.window.decorView.post {
        a.applyBarsLight(light)
        if (a.barsLight != light) {
          a.barsLight = light
          a.saveChromeSeed()
        }
        a.syncEdgeBackground()
      }
    }

    /**
     * 是否有物理键盘（移动端交互）：前端据此隐藏辅助键条、收紧软键盘避让等。
     * 先枚举 InputManager 的输入设备——排除虚拟设备（注入源/框架自造设备也会
     * 带键盘源位），命中「键盘源位 + keyboardType 非 NONE」才算；Activity 不在
     * 时退回 Configuration.keyboard，那是系统按当前连接设备解析出的同一事实。
     * Rust 经 JNI 静态调用本方法，失败只会少一个布局优化。
     */
    @JvmStatic
    fun hasHardwareKeyboard(): Boolean {
      val a = current?.get()
      if (a != null) return a.detectHardwareKeyboard()
      val ctx = appContext ?: return false
      return ctx.resources.configuration.keyboard != Configuration.KEYBOARD_NOKEYS
    }

    /**
     * 自动横屏（GitHub #45）：系统「旋转锁定」打开时，应用请求 `sensor` 方向会被
     * 锁住——只有显式固定方向请求（PORTRAIT/LANDSCAPE）能绕开。这里用物理朝向
     * 事件驱动固定方向请求，因此锁着旋转也能按握持方向转屏。开关状态由前端
     * localStorage 持久化，启动时经命令重放；Activity 重建后前端同样会再调一次，
     * 原生侧不需要落盘。
     */
    @JvmStatic
    fun setAutoOrientation(enabled: Boolean) {
      val a = current?.get() ?: return
      a.window.decorView.post { a.applyAutoOrientation(enabled) }
    }

    /** 推给 WebView 的 JS：只拼常量（'1'/'0'、true/false），无外部输入插值，
     *  不存在注入面；dataset 供 CSS/启动期同步读取，CustomEvent 供运行期订阅。 */
    private fun hardwareKeyboardJs(present: Boolean): String {
      val flag = if (present) "1" else "0"
      val detail = if (present) "true" else "false"
      return "document.documentElement.dataset.hwkb='$flag';" +
        "window.dispatchEvent(new CustomEvent('tinyssh-hwkb',{detail:$detail}))"
    }
  }

  /** 物理键盘插拔（USB/蓝牙/磁吸键盘）：监听器注册时 handler 传 null 即投递到
   *  主线程，回调里重算并推 WebView。 */
  private val inputDeviceListener = object : InputManager.InputDeviceListener {    override fun onInputDeviceAdded(deviceId: Int) {
      refreshHardwareKeyboard()
    }

    override fun onInputDeviceRemoved(deviceId: Int) {
      refreshHardwareKeyboard()
    }

    override fun onInputDeviceChanged(deviceId: Int) {
      refreshHardwareKeyboard()
    }
  }

  /** 遍历非虚拟输入设备找键盘；token 未配 KEYBOARD 源或类型为 NONE 的不算
   *  （gpio-keys 之类的按键设备常只报源位而不报键盘类型）。兜底 Configuration
   *  ——系统已把当前连接设备归并成 keyboard 分类。 */
  private fun detectHardwareKeyboard(): Boolean {
    val im = getSystemService(InputManager::class.java)
    if (im != null) {
      for (id in im.inputDeviceIds) {
        val d = im.getInputDevice(id) ?: continue
        if (d.isVirtual) continue
        if ((d.sources and InputDevice.SOURCE_KEYBOARD) != 0 &&
          d.keyboardType != InputDevice.KEYBOARD_TYPE_NONE
        ) {
          return true
        }
      }
    }
    return resources.configuration.keyboard != Configuration.KEYBOARD_NOKEYS
  }

  /** 重算并推给 WebView；WebView 未创建时静默跳过（前端启动时会主动查询命令）。 */
  private fun refreshHardwareKeyboard() {
    val present = detectHardwareKeyboard()
    val wv = contentWebView ?: return
    val js = hardwareKeyboardJs(present)
    wv.post { wv.evaluateJavascript(js, null) }
  }

  // 自动横屏状态：监听器只在开着时启用（后台 onPause 停掉，省电/不打扰其他应用）；
  // appliedOrientation 记住自己最后一次设置的固定方向，避免同一个方向重复请求
  // 造成无谓的配置变更。
  private var autoOrientation = false
  private var orientationListener: OrientationEventListener? = null
  private var appliedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
  // 最后一次读到的物理朝向（度）。监听器停用期间不更新；重新开启时先按它应用
  // 一档——部分设备/模拟器注册传感器后不会立刻补一个当前值，要等物理转动才
  // 回调，用户「关掉再打开」会看起来没反应。真实设备几十毫秒内会有新事件纠正
  // 停用期间的转动，代价可忽略。
  private var lastOrientation = OrientationEventListener.ORIENTATION_UNKNOWN

  // 软键盘可见性推给前端（dataset.ime='1'/'0'）：助力球等按钮 pointerdown
  // preventDefault 保住 xterm 焦点，但「键盘已被返回键收起、xterm 仍是焦点
  // 元素」时，Chrome 会在下一次触摸上把键盘重新弹起（真机实测）；前端据此
  // 在这种状态下放行默认行为（焦点转给按钮）。唯一真源是下面的 IME inset。
  private var imeVisible = false

  // 返回键一次性闸门：evaluateJavascript 的异步结果到达前（或 WebView 卡死不回
  // 回调时）挡掉连按，避免一按再按连开两轮「退 App」判定。超时回退走
  // moveTaskToBack 而不是 finish——会话可能还在跑，返回键不该直接杀应用。
  private val backGate = AtomicBoolean(false)
  private val mainHandler = Handler(Looper.getMainLooper())
  private var backTimeout: Runnable? = null

  /** 物理朝向 → 固定屏幕方向。对角死区（距四个正方向超过 35°）返回 null，
   *  调用方保持当前方向。 */
  private fun targetFor(orientation: Int): Int? = when (orientation) {
    in 0..35, in 325..359 -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    in 55..125 -> ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
    in 145..215 -> ActivityInfo.SCREEN_ORIENTATION_REVERSE_PORTRAIT
    in 235..305 -> ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE
    else -> null
  }

  private fun applyOrientation(orientation: Int) {
    if (!autoOrientation) return
    val target = targetFor(orientation) ?: return
    if (target == appliedOrientation) return
    appliedOrientation = target
    requestedOrientation = target
  }

  /** 推当前 IME 状态给 WebView（无条件，供页面就绪后补推）。 */
  private fun pushImeVisible() {
    val wv = contentWebView ?: return
    val js = "document.documentElement.dataset.ime='${if (imeVisible) 1 else 0}'"
    wv.post { wv.evaluateJavascript(js, null) }
  }

  private fun setImeVisible(visible: Boolean) {
    if (visible == imeVisible) return
    imeVisible = visible
    pushImeVisible()
  }

  /**
   * 导航栏下方那条跟着页面底色走。边到边下内容根把 systemBars/IME 的底部 inset 转成
   * 内边距（见 onCreate），露出来的是窗口底色——主题是 Material DayNight，跟的是系统
   * 深浅：系统浅色 + 应用深色时，应用最底下压着一条纯白条（手势导航）或灰条（三键）。
   * 页面在 window.__tinysshEdgeBg 里给出底缘实际颜色，这里取来涂窗口底色。页面没
   * 就绪、取色失败或返回不合规时保持上一次的值不动。表达式只含常量，无注入面。
   * 生效的值连同图标深浅一并落盘，供下次冷启动还原（[restoreChromeSeed]）。
   */
  private var edgeBg: Int? = null

  /** 系统栏图标是否深色（页面浅色时为 true）；null = 页面还没给过。 */
  private var barsLight: Boolean? = null

  private fun applyBarsLight(light: Boolean) {
    val c = WindowCompat.getInsetsController(window, window.decorView)
    c.isAppearanceLightStatusBars = light
    c.isAppearanceLightNavigationBars = light
  }

  /**
   * 冷启动种子。页面要到 React 首次提交后才第一次调 setSystemBarsLight；在那之前
   * 窗口底色与系统栏图标深浅都是主题按**系统**深浅给的——系统浅色 + 应用深色时，
   * 页面首帧已经是深色，底下却压着一条白条、状态栏是深色图标压在深色页面上，直到
   * 页面首次同步才纠正。这里在窗口第一帧之前还原上次页面给的值；页面就绪后照常
   * 重取覆盖，所以种子过期也无害。首次启动没有种子，沿用主题。
   */
  private fun restoreChromeSeed() {
    val p = getSharedPreferences(SEED_STORE, Context.MODE_PRIVATE)
    if (p.contains(SEED_EDGE_BG)) {
      val c = p.getInt(SEED_EDGE_BG, 0)
      edgeBg = c
      window.setBackgroundDrawable(ColorDrawable(c))
    }
    val light = if (p.contains(SEED_BARS_LIGHT)) p.getBoolean(SEED_BARS_LIGHT, false) else null
    barsLight = light
    if (light != null) applyBarsLight(light)
  }

  private fun saveChromeSeed() {
    val e = getSharedPreferences(SEED_STORE, Context.MODE_PRIVATE).edit()
    edgeBg?.let { e.putInt(SEED_EDGE_BG, it) }
    barsLight?.let { e.putBoolean(SEED_BARS_LIGHT, it) }
    e.apply()
  }

  private fun syncEdgeBackground() {
    val wv = contentWebView ?: return
    wv.evaluateJavascript(
      "(function(){try{return (window.__tinysshEdgeBg&&window.__tinysshEdgeBg())||''}catch(e){return ''}})()"
    ) { result ->
      val hex = EDGE_BG.find(result ?: return@evaluateJavascript)?.groupValues?.get(1)
        ?: return@evaluateJavascript
      val color = Color.parseColor(hex)
      if (color == edgeBg) return@evaluateJavascript
      edgeBg = color
      window.setBackgroundDrawable(ColorDrawable(color))
      saveChromeSeed()
    }
  }

  /**
   * 开关自动横屏。关掉时把 requestedOrientation 还原成 UNSPECIFIED，交还系统
   * （含旋转锁原语义）；开着时注册物理朝向监听——设备平放/方向不明时上报
   * ORIENTATION_UNKNOWN，保持上一档，不做判断。
   *
   * 判定带 ±10° 死区（只在距四个正方向 35° 内换档）：45°/135° 对角线附近手抖
   * 会让横竖反复切换，死区把边界推成 55°/125° 这类宽区间。90°/270° 的正反
   * 横屏、0°/180° 的正反竖屏都跟随物理朝向，不要求用户固定某一侧。
   */
  private fun applyAutoOrientation(enabled: Boolean) {
    autoOrientation = enabled
    if (!enabled) {
      orientationListener?.disable()
      if (appliedOrientation != ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED) {
        appliedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
      }
      return
    }
    val listener = orientationListener ?: object : OrientationEventListener(
      this, SensorManager.SENSOR_DELAY_UI
    ) {
      override fun onOrientationChanged(orientation: Int) {
        if (orientation == OrientationEventListener.ORIENTATION_UNKNOWN) return
        lastOrientation = orientation
        applyOrientation(orientation)
      }
    }.also { orientationListener = it }
    listener.enable()
    // 先按上一次已知朝向应用一档（见 lastOrientation 注释）。
    applyOrientation(lastOrientation)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    // 紧跟着还原冷启动种子：enableEdgeToEdge 刚按系统深浅设过图标外观，这里用上次
    // 页面给的值盖掉，第一个窗口帧起就和应用外观一致（见 restoreChromeSeed）。
    restoreChromeSeed()
    super.onCreate(savedInstanceState)
    current = WeakReference(this)
    appContext = applicationContext
    // 物理键盘插拔后前端要即时换布局（辅助键条/软键盘避让），事件驱动而不是
    // 靠前端轮询；注销在 onDestroy。
    getSystemService(InputManager::class.java)?.registerInputDeviceListener(inputDeviceListener, null)
    // 边到边（Android 15 对 targetSdk 35+ 强制）下软键盘默认是覆盖式：WebView
    // 高度不变，输入法直接压在终端和状态栏上，xterm 一直画到键盘底下（提示行被
    // 遮住）。这里把 IME inset 转成内容区底部内边距，WebView 高度随之缩短，
    // 前端布局与终端自动重排。IME 收缩由原生唯一负责（前端 ResizeObserver 只
    // 跟随 WebView 尺寸变化，不另行补偿）。
    // 三键导航/手势条的 systemBars 底部 inset 从未被补偿（KI-058），终端辅助键条
    // 等贴底控件被压在导航栏下：与 IME 取 max——键盘弹出时 IME 通常更大，键盘
    // 收起时补导航栏高度（两者重叠，相加会重复留白）。
    // 顶部状态栏仍由边到边交给前端 CSS 处理（这里不重复加内边距）。
    val root = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()).bottom
      v.setPadding(0, 0, 0, maxOf(ime, bars))
      setImeVisible(ime > 0)
      insets
    }
    // 返回键：TauriActivity 关掉了 Wry 的默认返回导航，系统默认会直接退 App。
    // 交给前端按「栈顶」关弹层/面板（window.__tinysshBack() 返回 true 表示已消费），
    // 前端不认领才 finish()。软键盘打开时返回键由 IME 自己消费，到不了这里。
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val wv = contentWebView
        if (wv == null) { finish(); return }
        // 回调未到前连按无效；等待期间 WebView 渲染进程卡死时回调永远不会来，
        // 400ms 后回退到「退到后台」（不 finish，避免误杀有活动会话的 App）。
        if (!backGate.compareAndSet(false, true)) return
        val timeout = Runnable {
          if (backGate.compareAndSet(true, false)) moveTaskToBack(true)
        }
        backTimeout = timeout
        mainHandler.postDelayed(timeout, BACK_FALLBACK_MS)
        wv.evaluateJavascript("(window.__tinysshBack && window.__tinysshBack()) === true") { result ->
          // 超时先到：这一轮已按「WebView 无应答」处理，迟到结果不再触发 finish。
          if (!backGate.compareAndSet(true, false)) return@evaluateJavascript
          mainHandler.removeCallbacks(timeout)
          if (result != "true") finish()
        }
      }
    })
  }

  override fun onWebViewCreate(webView: WebView) {
    contentWebView = webView
    // onWebViewCreate 早于页面 JS 就绪，立即推一次可能落在空世界；前端启动时
    // 会主动调 has_hardware_keyboard（命令路径不会丢），这里再延迟补推一次，
    // 覆盖冷启动/重建窗口的时序空窗。
    refreshHardwareKeyboard()
    webView.postDelayed({ refreshHardwareKeyboard() }, 800)
    // IME 状态同理：页面就绪后补推一次，冷启动时 insets 可能早于文档创建。
    webView.postDelayed({ pushImeVisible() }, 800)
  }

  override fun onResume() {
    super.onResume()
    // 后台期间显示器/外设可能变化，且这次挂起前可能错过一次推送：回前台重算。
    refreshHardwareKeyboard()
    // 朝向监听在 onPause 停掉（不占后台传感器），回前台按开关恢复。
    if (autoOrientation) orientationListener?.enable()
  }

  override fun onPause() {
    orientationListener?.disable()
    super.onPause()
  }

  override fun onDestroy() {
    backTimeout?.let { mainHandler.removeCallbacks(it) }
    getSystemService(InputManager::class.java)?.unregisterInputDeviceListener(inputDeviceListener)
    if (current?.get() === this) current = null
    super.onDestroy()
  }
}
