---
name: apk-update-process
description: How to release a new APK version — GitHub Actions builds it, Railway env var controls which version TVs auto-update to
metadata:
  type: project
---

## APK Release Process (as of v1.53+)

### Automatic build
- Push any change to `player-android/**` → GitHub Actions builds APK and creates a GitHub Release
- APK URL format: `https://github.com/mehulextrra-design/signagecms/releases/download/v1.{N}/app-release.apk`
- Run number = version code (e.g. run #53 → versionCode 53, versionName "1.53")

### Deploy new version
1. Wait for GitHub Actions build to complete (check Actions tab)
2. Note the run number from the build summary
3. In Railway: set `APK_VERSION_CODE = {run_number}`
4. **APK_DOWNLOAD_URL is NOT needed** — backend auto-constructs URL from APK_VERSION_CODE + GITHUB_REPO env var

### TV auto-update
- TVs poll `/api/player/app-version` every 5 minutes
- If server versionCode > installed versionCode → downloads and silently installs
- Silent install works because of Device Owner flags (added in v1.50):
  - `INSTALL_REASON_POLICY` (Android 8+)
  - `USER_ACTION_NOT_REQUIRED` (Android 12+)
- **No manual appops needed** from v1.50 onwards — Device Owner handles it permanently

### Verify update
- Press Back on TV remote → SetupActivity shows current version
- SetupActivity auto-starts player after 60 seconds (added in v1.53)

**Why:** Previously used Cloudinary (required authenticated URLs, not publicly accessible). Switched to GitHub Releases in v1.51 for public, free, predictable URLs.
