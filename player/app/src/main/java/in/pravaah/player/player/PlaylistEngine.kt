package in.pravaah.player.player

import android.util.Log
import in.pravaah.player.models.CampaignSlot
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeFormatter

/**
 * Determines which campaign slots are playable RIGHT NOW based on
 * today's date and current time. Returns an ordered play queue.
 */
class PlaylistEngine {

    companion object {
        private const val TAG = "PlaylistEngine"
        private val DATE_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd")
        private val TIME_FMT = DateTimeFormatter.ofPattern("HH:mm:ss")
    }

    fun buildPlayQueue(allSlots: List<CampaignSlot>): List<CampaignSlot> {
        val today = LocalDate.now()
        val now = LocalTime.now()

        val active = allSlots.filter { slot ->
            try {
                val start = LocalDate.parse(slot.startDate, DATE_FMT)
                val end = LocalDate.parse(slot.endDate, DATE_FMT)
                val timeStart = LocalTime.parse(slot.startTime, TIME_FMT)
                val timeEnd = LocalTime.parse(slot.endTime, TIME_FMT)

                val dateOk = !today.isBefore(start) && !today.isAfter(end)
                val timeOk = !now.isBefore(timeStart) && !now.isAfter(timeEnd)
                dateOk && timeOk
            } catch (e: Exception) {
                Log.e(TAG, "Date parse error for campaign ${slot.campaignCode}: ${e.message}")
                false
            }
        }

        Log.d(TAG, "Active slots: ${active.size} / ${allSlots.size} total at $today $now")
        return active
    }

    /**
     * Round-robin: returns next slot after currentIndex, wraps around.
     * If queue is empty, returns null (player shows fallback/screensaver).
     */
    fun nextSlot(queue: List<CampaignSlot>, currentIndex: Int): Pair<CampaignSlot, Int>? {
        if (queue.isEmpty()) return null
        val nextIndex = (currentIndex + 1) % queue.size
        return Pair(queue[nextIndex], nextIndex)
    }

    /**
     * Returns how many milliseconds until the play window opens for the
     * first upcoming (not yet started) slot. Used for scheduling wakeup.
     * Returns -1 if no upcoming slots.
     */
    fun msUntilNextWindow(allSlots: List<CampaignSlot>): Long {
        val today = LocalDate.now()
        val now = LocalTime.now()
        var minMs = Long.MAX_VALUE

        allSlots.forEach { slot ->
            try {
                val start = LocalDate.parse(slot.startDate, DATE_FMT)
                val timeStart = LocalTime.parse(slot.startTime, TIME_FMT)
                if (!today.isBefore(start) && now.isBefore(timeStart)) {
                    val ms = (timeStart.toNanoOfDay() - now.toNanoOfDay()) / 1_000_000
                    if (ms < minMs) minMs = ms
                }
            } catch (_: Exception) {}
        }
        return if (minMs == Long.MAX_VALUE) -1L else minMs
    }
}
