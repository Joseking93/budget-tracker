package com.basketbudget.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * The one thing this app says when it is closed: a reminder on the last day of
 * the budget month, with the figure the page last worked out.
 *
 * The page cannot run in the background - everything it knows lives in the
 * WebView's own storage - so it leaves the words for this behind in
 * SharedPreferences each time it opens, and sets the alarm. What fires here is
 * therefore as current as the last time the app was opened, which the text
 * itself says. Threshold alerts (a line at 80%, a line gone over) are posted
 * by the page directly through the bridge while it is open; see MainActivity.
 */
class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val title = prefs.getString(KEY_TITLE, null) ?: return
        val text = prefs.getString(KEY_TEXT, "") ?: ""
        post(context, REMINDER_ID, title, text)
    }

    companion object {
        const val PREFS = "reminder"
        const val KEY_TITLE = "title"
        const val KEY_TEXT = "text"
        const val CHANNEL = "budget"
        const val REMINDER_ID = 27

        /** The channel is made once; Android ignores a second creation. */
        fun ensureChannel(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (manager.getNotificationChannel(CHANNEL) != null) return
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "Budget", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "A budget line nearly spent, one gone over, and the last day of the month."
                },
            )
        }

        fun post(context: Context, id: Int, title: String, text: String) {
            ensureChannel(context)
            val open = PendingIntent.getActivity(
                context,
                id,
                Intent(context, MainActivity::class.java).apply {
                    action = Intent.ACTION_MAIN
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                },
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val note = NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(R.drawable.ic_wallet)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(NotificationCompat.BigTextStyle().bigText(text))
                .setContentIntent(open)
                .setAutoCancel(true)
                .build()
            try {
                (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(id, note)
            } catch (e: SecurityException) {
                // No permission to post: nothing to do here, the page asks for it.
            }
        }
    }
}
