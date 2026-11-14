package com.tinyssh.app

import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var contentWebView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // 边到边（Android 15 对 targetSdk 35+ 强制）下软键盘默认是覆盖式：WebView
    // 高度不变，输入法直接压在终端和状态栏上，前端 ResizeObserver 收不到收缩，
    // xterm 一直画到键盘底下（提示行被遮住）。这里把 IME inset 转成内容区
    // 底部内边距，WebView 高度随之缩短，前端布局与终端自动重排。
    // 顶部状态栏仍由边到边交给前端 CSS 处理（这里不重复加内边距）。
    val root = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      v.setPadding(0, 0, 0, ime)
      insets
    }
    // 返回键：TauriActivity 关掉了 Wry 的默认返回导航，系统默认会直接退 App。
    // 交给前端按「栈顶」关弹层/面板（window.__tinysshBack() 返回 true 表示已消费），
    // 前端不认领才 finish()。软键盘打开时返回键由 IME 自己消费，到不了这里。
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val wv = contentWebView
        if (wv == null) { finish(); return }
        wv.evaluateJavascript("(window.__tinysshBack && window.__tinysshBack()) === true") { result ->
          if (result != "true") finish()
        }
      }
    })
  }

  override fun onWebViewCreate(webView: WebView) {
    contentWebView = webView
  }
}
