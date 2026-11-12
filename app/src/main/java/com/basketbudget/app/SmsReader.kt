package com.basketbudget.app

import android.content.Context
import android.provider.Telephony

/**
 * Reads M-PESA's own messages out of the phone's inbox.
 *
 * The page already knows how to turn those messages into transactions — that
 * is what the paste box has always done. This only fetches them, so nothing
 * has to be copied by hand and a statement PDF stops being the way in.
 *
 * Nothing is sent anywhere. The text goes straight to the page running in this
 * app and is stored on the device, like everything else here.
 */
object SmsReader {

    /**
      * Safaricom sends from MPESA; some handsets record it with a hyphen. The
      * banks send under their own names, exactly as they appear in Messages.
      * LIKE is case-insensitive for ASCII in SQLite, so the spelling of the
      * sender's name does not have to be guessed exactly.
      */
    private val SENDER_NAMES = listOf(
        "MPESA", "M-PESA", "KCB", "KCB M-PESA", "StanChart",
        // The lenders. M-Shwari reminders come from "M-Shwari", not from MPESA,
        // and were never handed over at all; the same for NCBA's Loop.
        "M-Shwari", "MSHWARI", "NCBA", "NCBA LOOP", "LOOP", "Fuliza", "Zenka", "Tala",
    )

    private val SENDERS = SENDER_NAMES.joinToString(" OR ") { "address LIKE '" + it + "'" }

    /**
     * A confirmed M-PESA transaction always opens with its receipt code.
     *
     * Case-insensitively: Safaricom writes "Confirmed" on most messages and
     * "confirmed" on others, and the salary is one of the others - "UJS8NBWA2Y
     * confirmed. You have received Ksh166,671.00 ... via TerraPay". With a
     * capital C required, every message written the other way was never handed
     * to the page at all, which is why money in read as zero.
     */
    private val LOOKS_LIKE_TRANSACTION =
        Regex("""^[A-Za-z0-9]{10}\s+confirmed""", RegexOption.IGNORE_CASE)

    /**
     * A bank message is worth reading if it mentions an amount of money - or a
     * loan: "your KCB M-PESA loan No. N is now fully paid" names no sum, and
     * it is the one message that closes a loan.
     */
    private val HAS_MONEY = Regex(
        """(?:KES|Kshs?\.?)\s?[\d,]+|fully (?:re)?paid|\bloan\b""",
        RegexOption.IGNORE_CASE,
    )

    /**
     * Never read, never handed over, never stored.
     *
     * A one-time code is a credential. It has no business in a budget, and a
     * message holding one must not reach the page even to be reported as
     * unrecognised - the not-recognised panel prints what it could not read.
     */
    private val IS_A_SECRET = Regex(
        """activation code|one[- ]?time|\bOTP\b|\bPIN\b(?!\s+yako)|code:\s*\d|do not share""",
        RegexOption.IGNORE_CASE,
    )

    private fun worthReading(sender: String, body: String): Boolean {
        if (IS_A_SECRET.containsMatchIn(body)) return false
        val mpesa = sender.equals("MPESA", true) || sender.equals("M-PESA", true)
        return if (mpesa) LOOKS_LIKE_TRANSACTION.containsMatchIn(body) else HAS_MONEY.containsMatchIn(body)
    }

    data class Batch(
        val messages: List<String>,
        val newest: Long,
        /** True when [limit] stopped the read before the inbox ran out. */
        val truncated: Boolean = false,
    )

    /**
     * Every M-PESA message newer than [since], oldest first so the page reads
     * them in the order they happened.
     *
     * @param since epoch millis; 0 reads the whole inbox.
     */
    fun read(context: Context, since: Long = 0L, limit: Int = 50_000): Batch {
        val where = StringBuilder("($SENDERS)")
        if (since > 0) where.append(" AND date > ").append(since)

        val bodies = ArrayList<String>()
        var newest = since

        context.contentResolver.query(
            Telephony.Sms.Inbox.CONTENT_URI,
            arrayOf(Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.ADDRESS),
            where.toString(),
            null,
            "${Telephony.Sms.DATE} ASC",
        )?.use { cursor ->
            val body = cursor.getColumnIndexOrThrow(Telephony.Sms.BODY)
            val date = cursor.getColumnIndexOrThrow(Telephony.Sms.DATE)
            val from = cursor.getColumnIndexOrThrow(Telephony.Sms.ADDRESS)
            while (cursor.moveToNext() && bodies.size < limit) {
                val text = cursor.getString(body)?.trim().orEmpty()
                val sender = cursor.getString(from)?.trim().orEmpty()
                // Balance enquiries and adverts come from the same senders and
                // would only land in the page's "could not read" pile.
                if (text.isNotEmpty() && worthReading(sender, text)) {
                    val at = cursor.getLong(date)
                    // Several M-PESA messages carry no date of their own - a Fuliza
                    // repayment is the common one, and there are hundreds of those.
                    // The page cannot place a transaction it cannot date, so each
                    // body goes over with the moment the message arrived, which is
                    // within seconds of when it happened. The parser reads the
                    // stamp, uses it only where the text gives no date, and strips
                    // it before storing anything.
                    // The sender travels with the message: it is what tells
                    // the page which account a row belongs to, and M-PESA and a
                    // bank describe the same movement in different words.
                    bodies.add("#at " + at + " " + sender + "\n" + text)
                    if (at > newest) newest = at
                }
            }
        }

        return Batch(bodies, newest, truncated = bodies.size >= limit)
    }
}
