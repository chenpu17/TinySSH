package com.tinyssh.app

import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * Rust → Kotlin 的保活入口（KI-059 v1）。
 *
 * 真源在 Rust（会话/传输快照），本对象只做「起/停前台服务」两个动作：
 * active=true 时 startForegroundService 并携带计数（服务收到后更新通知文案），
 * false 时 stopService。Android 12+ 后台启动限制等异常在这里吞掉——保活是尽力
 * 而为，异常绝不能抛回 JNI 线程；回前台时前端会调 keepalive_sync 补起。
 */
object KeepaliveBridge {
    private const val TAG = "TinySSHKeepalive"

    @JvmStatic
    fun setActive(context: Context, active: Boolean, sessions: Int, transfers: Int) {
        try {
            if (active) {
                val intent = Intent(context, KeepaliveService::class.java).apply {
                    // singleTask 宿主重复启动时复用同一服务实例，onStartCommand 只更新通知
                    putExtra(KeepaliveService.EXTRA_SESSIONS, sessions)
                    putExtra(KeepaliveService.EXTRA_TRANSFERS, transfers)
                }
                ContextCompat.startForegroundService(context, intent)
            } else {
                context.stopService(Intent(context, KeepaliveService::class.java))
            }
        } catch (t: Throwable) {
            // 典型：Android 12+ 后台启动前台服务被拒（ForegroundServiceStartNotAllowedException）。
            // 只记日志；App 回前台后 keepalive_sync 会重发。
            Log.w(TAG, "setActive(active=$active, sessions=$sessions, transfers=$transfers) 失败", t)
        }
    }
}
