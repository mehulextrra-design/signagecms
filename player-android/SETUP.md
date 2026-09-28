# SignageCMS Player — Android APK

Native Android (Kotlin) player for SignageCMS digital signage screens.

## Build Requirements

- Android Studio Hedgehog (2023.1.1) or newer
- JDK 17
- Android SDK with API 34

## How to Build APK

1. Open Android Studio → File → Open → select `player-android/` folder
2. Wait for Gradle sync to finish
3. Build → Generate Signed Bundle / APK → APK → Release
4. APK will be at: `app/release/app-release.apk`

For quick debug build:
- Build → Build Bundle(s) / APK(s) → Build APK(s)
- APK at: `app/debug/app-debug.apk`

## How to Install on Device

**Via ADB (any Android device):**
```
adb install app-release.apk
```

**Via USB file transfer:**
1. Copy APK to device
2. Open file manager → tap APK → Install
3. Enable "Unknown sources" if asked

**Via ADB over WiFi (for TV boxes):**
```
adb connect <device-ip>:5555
adb install app-release.apk
```

## First-Time Setup

1. Open **SignageCMS Player** app on device
2. Enter the **Screen Code** from Admin Panel (e.g. `MUM-001`)
3. Tap **Register This Screen**
4. App auto-starts playing if campaigns are scheduled

## Android 5/6 Compatibility (China TV Boards)

- minSdk = 21 (Android 5.0 Lollipop)
- TLS 1.2 force-enabled via OkHttp for old SSL stacks
- ExoPlayer Media3 supports API 21+
- Boot receiver handles `QUICKBOOT_POWERON` (Huawei/China ROM variant)

## Offline Support

| Feature | Behavior |
|---|---|
| Content files | Downloaded to `/files/content/` on device |
| Schedule | Stored in Room SQLite DB |
| Play logs | Queued in DB, synced on next heartbeat |
| Network lost | Plays from local cache automatically |
| Network restored | Syncs logs + fetches new schedule |

## Key Intervals

- Heartbeat: every 60 seconds (configurable from server)
- Schedule sync: every 5 minutes (configurable from server)
- Play log sync: on each heartbeat

## Backend API

Base URL: `https://signagecrm-production.up.railway.app/api/`

| Endpoint | Method | Purpose |
|---|---|---|
| `/player/register` | POST | First-time device registration |
| `/player/schedule` | GET | Fetch active campaigns |
| `/player/heartbeat` | POST | Send status every 60s |
| `/player/proof-of-play` | POST | Batch upload play logs |
