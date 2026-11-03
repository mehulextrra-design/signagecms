@echo off
set JAVA_HOME=C:\Users\admin\Downloads\jdk-25_windows-x64_bin\jdk-25.0.1
set PATH=%JAVA_HOME%\bin;%PATH%
cd /d H:\Signagecms\player-android
call gradlew.bat assembleRelease
if %ERRORLEVEL% == 0 (
    echo.
    echo BUILD SUCCESS
    echo APK: app\build\outputs\apk\release\app-release.apk
) else (
    echo.
    echo BUILD FAILED - check errors above
)
pause
