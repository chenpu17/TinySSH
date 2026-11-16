package com.tinyssh.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * 保活前台服务（KI-059 v1）：有活动会话或活动传输时由 [KeepaliveBridge] 拉起，
 * Rust 侧计数归零即停。常驻通知只承担「告知用户应用仍在后台保持连接」，
 * 不承载任何操作按钮（v1 范围）。
 */
class KeepaliveService : Service() {
    companion object {
        private const val CHANNEL_ID = "tinyssh_keepalive"
        // 固定通知 id；不能为 0——通知插件（BEL/OSC 9）用 id 0，撞上会互相覆盖。
        private const val NOTIFICATION_ID = 0x5453
        const val EXTRA_SESSIONS = "sessions"
        const val EXTRA_TRANSFERS = "transfers"
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val sessions = intent?.getIntExtra(EXTRA_SESSIONS, 0) ?: 0
        val transfers = intent?.getIntExtra(EXTRA_TRANSFERS, 0) ?: 0
        ensureChannel()
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            buildNotification(sessions, transfers),
            // connectedDevice 类型是 Android 14 对 FGS 的合法性要求；API < 29 传 0。
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
            } else {
                0
            }
        )
        // 系统重建进程时无活动会话可读，交给 Rust 下次事件/回前台补口重起。
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        // 归零路径也可能是 stopService（Rust 调）——前台通知必须随之移除。
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.keepalive_channel_name),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = getString(R.string.keepalive_channel_desc)
            setShowBadge(false)
            setSound(null, null)
            enableVibration(false)
            enableLights(false)
        }
        nm.createNotificationChannel(channel)
    }

    private fun buildNotification(sessions: Int, transfers: Int): android.app.Notification {
        // 点击回主界面（manifest 是 singleTask，已在前台则只回栈顶）。
        val launch = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            launch,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_tinyssh)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(statusText(sessions, transfers))
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun statusText(sessions: Int, transfers: Int): String = when {
        sessions > 0 && transfers > 0 ->
            getString(R.string.keepalive_text_both, sessions, transfers)
        transfers > 0 -> getString(R.string.keepalive_text_transfers, transfers)
        else -> getString(R.string.keepalive_text_sessions, sessions)
    }
}
