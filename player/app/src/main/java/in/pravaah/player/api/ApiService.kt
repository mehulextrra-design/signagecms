package in.pravaah.player.api

import in.pravaah.player.models.*
import retrofit2.Response
import retrofit2.http.*

interface ApiService {

    // ── Registration ──────────────────────────────────────────────────────
    @POST("player/register")
    suspend fun register(@Body request: RegisterRequest): Response<RegisterResponse>

    // ── Schedule ──────────────────────────────────────────────────────────
    @GET("player/schedule")
    suspend fun getSchedule(): Response<ScheduleResponse>

    // ── Heartbeat ─────────────────────────────────────────────────────────
    @POST("player/heartbeat")
    suspend fun heartbeat(@Body request: HeartbeatRequest): Response<HeartbeatResponse>

    // ── Proof of Play ─────────────────────────────────────────────────────
    @POST("player/proof-of-play")
    suspend fun uploadProofOfPlay(@Body request: PlayLogsRequest): Response<PlayLogsResponse>

    // ── Offline report ────────────────────────────────────────────────────
    @POST("player/offline-log")
    suspend fun reportOffline(@Body request: OfflineLogRequest): Response<GenericResponse>
}
