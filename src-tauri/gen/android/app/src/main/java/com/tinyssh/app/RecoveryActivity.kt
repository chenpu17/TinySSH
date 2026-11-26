package com.tinyssh.app

import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.util.Log
import android.util.TypedValue
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File
import java.security.KeyStore

/**
 * 启动入口。Rust 内核在 MainActivity 的 super.onCreate 里启动，存储库打开失败时
 * 进程直接 exit——原生对话框来不及显示，也不能在 Rust 里阻塞主线程弹窗。因此失败
 * 原因由 Rust 落成标记文件（见 src-tauri/src/lib.rs 的启动失败分支），本
 * Activity 在下一次启动时先于内核读它：有标记就显示恢复页（重试/重置本地数据），
 * 没有就立刻转交 MainActivity。
 *
 * 标记路径与内核一致：filesDir/.tinyssh/startup-fatal.txt（库在同目录）。
 */
class RecoveryActivity : AppCompatActivity() {
  private val marker: File get() = File(File(filesDir, DATA_DIR), FATAL_MARKER)

  override fun onCreate(savedInstanceState: Bundle?) {
    // 应用主题跟随系统深浅色，恢复页固定深色底：显式要求浅色系统栏图标。
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    super.onCreate(savedInstanceState)
    if (!marker.isFile) {
      startMain()
      return
    }
    showRecovery(readMarker())
  }

  /** 标记内容（内核写入的失败原因）；读不到不算致命，恢复页仍按通用文案呈现。 */
  private fun readMarker(): String = runCatching {
    marker.readText().take(MAX_DETAIL_CHARS)
  }.getOrDefault("")

  private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

  private fun showRecovery(detail: String) {
    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setBackgroundColor(Color.parseColor("#0c1017"))
      setPadding(dp(24), dp(24), dp(24), dp(24))
    }
    // Android 15 起 targetSdk 35+ 强制边到边：内容默认画到状态栏/导航栏底下，
    // 这里把系统栏与输入法的 inset 补成内边距（键盘弹出时按钮仍可点）。
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime()
      )
      view.setPadding(dp(24) + bars.left, dp(24) + bars.top, dp(24) + bars.right, dp(24) + bars.bottom)
      insets
    }

    root.addView(TextView(this).apply {
      text = getString(R.string.recovery_title)
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
      setTypeface(typeface, Typeface.BOLD)
    })

    root.addView(TextView(this).apply {
      text = getString(R.string.recovery_message)
      setTextColor(Color.parseColor("#c5d0df"))
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
      setPadding(0, dp(12), 0, dp(12))
    })

    root.addView(
      ScrollView(this).apply {
        addView(TextView(this@RecoveryActivity).apply {
          text = detail
          setTextColor(Color.parseColor("#8b98a9"))
          setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
          typeface = Typeface.MONOSPACE
          // 失败原因常含路径，允许用户选中复制（便于反馈问题）。
          setTextIsSelectable(true)
        })
      },
      LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
    )

    root.addView(actionButton(R.string.recovery_retry) { startMain() })
    root.addView(actionButton(R.string.recovery_reset) { confirmReset() })
    root.addView(actionButton(R.string.recovery_quit) { finishAffinity() })

    setContentView(root)
  }

  private fun actionButton(textRes: Int, onClick: () -> Unit): Button =
    Button(this).apply {
      setText(textRes)
      setOnClickListener { onClick() }
      layoutParams = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
      ).apply { topMargin = dp(8) }
    }

  /** 重试不删标记：内核成功打开存储库后会自己删（见 lib.rs）；再次失败会重写，
   *  下次启动仍进恢复页，不会把失败悄悄盖掉。 */
  private fun startMain() {
    try {
      startActivity(Intent(this, MainActivity::class.java))
      finish()
    } catch (e: Exception) {
      Log.e(TAG, "start MainActivity failed", e)
      AlertDialog.Builder(this)
        .setTitle(R.string.recovery_title)
        .setMessage(getString(R.string.recovery_start_failed, e.message ?: e.javaClass.simpleName))
        .setPositiveButton(android.R.string.ok, null)
        .show()
    }
  }

  private fun confirmReset() {
    AlertDialog.Builder(this)
      .setTitle(R.string.recovery_reset_confirm_title)
      .setMessage(R.string.recovery_reset_confirm_message)
      .setPositiveButton(R.string.recovery_reset_confirm_ok) { _, _ -> resetAndRestart() }
      .setNegativeButton(R.string.recovery_cancel, null)
      .show()
  }

  private fun resetAndRestart() {
    val error = resetLocalData()
    if (error != null) {
      AlertDialog.Builder(this)
        .setTitle(R.string.recovery_title)
        .setMessage(getString(R.string.recovery_reset_failed, error))
        .setPositiveButton(android.R.string.ok, null)
        .show()
      return
    }
    startMain()
  }

  /**
   * 删除本地私有的全部 TinySSH 数据。主密钥是「SharedPreferences 密文 + AndroidKeyStore
   * 别名」两半，android-native-keyring-store 的默认库文件名与别名都是 keyring-default
   * （见 crates/platform-android/src/keystore.rs），必须一并清掉——只删库会留下解不开
   * 的密文，只删密钥会留下读不出密钥的密文，两者都会让下次启动继续失败。
   *
   * 返回 null 表示成功，否则是给用户看的错误描述。Keystore 删除失败只记日志：对应的
   * SharedPreferences 已清空，旧密钥没有密文可配，下次启动会照常生成新凭据。
   */
  private fun resetLocalData(): String? {
    val dataDir = File(filesDir, DATA_DIR)
    if (dataDir.exists() && !dataDir.deleteRecursively()) {
      return getString(R.string.recovery_delete_failed, dataDir.absolutePath)
    }
    runCatching { deleteSharedPreferences(KEYRING_STORE) }
      .onFailure { Log.w(TAG, "delete shared preferences failed", it) }
    // 外观冷启动种子（MainActivity.restoreChromeSeed 落盘的窗口底色与图标深浅）不清
    // 也不会出错，页面就绪后会重取；但它是上一个库留下的界面状态，「重置」不该留它。
    runCatching { deleteSharedPreferences(MainActivity.SEED_STORE) }
      .onFailure { Log.w(TAG, "delete shared preferences failed", it) }
    runCatching {
      val keyStore = KeyStore.getInstance("AndroidKeyStore")
      keyStore.load(null)
      if (keyStore.containsAlias(KEYRING_STORE)) keyStore.deleteEntry(KEYRING_STORE)
    }.onFailure { Log.w(TAG, "delete keystore entry failed", it) }
    return null
  }

  private companion object {
    const val TAG = "TinySSH"
    const val DATA_DIR = ".tinyssh"
    const val FATAL_MARKER = "startup-fatal.txt"
    const val KEYRING_STORE = "keyring-default"
    const val MAX_DETAIL_CHARS = 4000
  }
}
