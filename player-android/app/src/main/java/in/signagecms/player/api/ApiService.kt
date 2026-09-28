package `in`.signagecms.player.api

import `in`.signagecms.player.api.models.*
import retrofit2.Response
import retrofit2.http.*

interface ApiService {

    @POST("player/register")
    suspend fun register(@Body request: RegisterRequest): Response<RegisterResponse>

    @GET("player/schedule")
    suspend fun getSchedule(
        @Header("Authorization") auth: String
    ): Response<ScheduleResponse>

    @POST("player/heartbeat")
    suspend fun heartbeat(
        @Header("Authorization") auth: String,
        @Body request: HeartbeatRequest
    ): Response<HeartbeatResponse>

    @POST("player/proof-of-play")
    suspend fun submitProofOfPlay(
        @Header("Authorization") auth: String,
        @Body request: ProofOfPlayRequest
    ): Response<ProofOfPlayResponse>

    @POST("player/offline-log")
    suspend fun logOffline(
        @Header("Authorization") auth: String,
        @Body body: Map<String, String>
    ): Response<Any>
}
