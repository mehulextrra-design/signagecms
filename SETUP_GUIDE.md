# Pravaah Signage Platform — Setup Guide

## Folder Structure
```
H:\Signagecms\
├── backend\          ← Node.js API server
├── player\           ← Android TV Player APK (Kotlin)
├── cms_mockup.html   ← CMS Advertiser Portal (mockup)
└── admin_mockup.html ← Admin Panel (mockup)
```

---

## 1. Backend Setup

### Prerequisites
- Node.js v18+
- PostgreSQL 14+

### Steps
```bash
cd H:\Signagecms\backend
npm install

# Create .env file from template
copy .env.example .env
# Edit .env — fill in your DB credentials, JWT secrets

# Create database in PostgreSQL
psql -U postgres -c "CREATE DATABASE pravaah_signage;"

# Run migrations
psql -U postgres -d pravaah_signage -f migrations/001_initial_schema.sql

# Start server
npm run dev        # development
npm start          # production
```

Server runs at: `http://localhost:3000`
Health check: `http://localhost:3000/health`

---

## 2. Android TV Player APK

### Prerequisites
- Android Studio Hedgehog (2023.1.1) or newer
- Android SDK 34

### Steps
1. Open Android Studio → `File → Open` → select `H:\Signagecms\player\`
2. Edit `app\build.gradle` — set `API_BASE_URL` to your server IP:
   ```groovy
   buildConfigField "String", "API_BASE_URL", '"http://192.168.1.100:3000/api/"'
   ```
3. Build → `Build → Generate Signed Bundle / APK → APK`
4. Install on Android TV:
   ```bash
   adb connect <TV_IP>:5555
   adb install app-release.apk
   ```

### Kiosk Mode (Device Owner)
Run once after installing the APK to enable true kiosk mode:
```bash
adb shell dpm set-device-owner in.pravaah.player/.services.DeviceAdminReceiver
```

### First Screen Registration
1. Launch the app on the TV
2. Enter the server URL: `http://YOUR_SERVER_IP:3000/api/`
3. Enter the screen code (must match what admin created in the CMS — e.g. `PHX-001`)
4. Tap **Register This Screen**
5. Player starts automatically after registration

---

## 3. API Endpoints Summary

### Player API (used by APK)
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/player/register | First-time device registration → returns JWT token |
| GET | /api/player/schedule | Current + upcoming campaigns for this screen |
| POST | /api/player/heartbeat | 60-second status ping + receive remote commands |
| POST | /api/player/proof-of-play | Batch upload play logs |
| POST | /api/player/offline-log | Report recovered offline period |

### Auth API
| POST | /api/auth/register | Create advertiser account |
| POST | /api/auth/login | Login → returns JWT |
| GET | /api/auth/me | Get current user |
| POST | /api/auth/change-password | Change password |

### Admin API (Bearer token required, admin role)
- `/api/screens` — CRUD screens + register player device
- `/api/campaigns` — List all, approve, reject
- `/api/users` — List advertisers, suspend/activate
- `/api/reports/dashboard` — Revenue + stats summary
- `/api/billing/refund` — Issue refund
- `/api/coupons` — Create/deactivate coupons

---

## 4. Environment Variables (.env)

```
DB_HOST=localhost
DB_PORT=5432
DB_NAME=pravaah_signage
DB_USER=postgres
DB_PASSWORD=your_password

JWT_SECRET=your_min_32_char_secret
PLAYER_JWT_SECRET=player_device_secret

PORT=3000
GST_RATE=18
RAZORPAY_KEY_ID=rzp_live_xxx
RAZORPAY_KEY_SECRET=xxx
```

---

## 5. How It Works

```
[Android TV] ──register──► [Backend API] ◄── [Admin creates PHX-001 in CMS]
      │
      │◄── schedule (every 5 min) ──── campaigns for this screen
      │
      │──── heartbeat (every 60 sec) ──► marks screen online
      │                                  returns remote commands
      │
      │──── proof-of-play (every 5 min) ──► play logs in DB
```

**Content flow:**
1. Advertiser uploads MP4/image in CMS
2. Pays → campaign goes `pending_approval`
3. Admin approves → `approved`
4. Scheduler auto-activates on start_date → `live`
5. Player downloads content, plays by schedule
6. Logs every play → PoP reports in CMS
