# Build the TradeMind Android app (Play Store AAB + sideload APK)
#
# This wraps the live PWA (https://trademind-7xcs.onrender.com/app/) as a
# Trusted Web Activity. No Android Studio needed. Everything lives outside the
# repo so no keys or binaries are ever committed except the published APK.
#
# Prerequisites (one-time, all already done on the build machine):
#   - JDK 17              (C:\Program Files\Java\jdk-17)
#   - Android SDK         (D:\android\sdk) with platforms;android-34 + build-tools;34.0.0
#                         (install with: sdkmanager "platforms;android-34" "build-tools;34.0.0")
#   - Release keystore    (D:\android\trademind.keystore, alias "trademind")
#   - TWA project         (D:\android\build\twa-app)
#   - Gradle 8.7          (auto-downloaded to D:\android\gradle-x on first run)
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\build-apk.ps1
#
# After it finishes:
#   APK -> public\download\TradeMind-v1.0.0.apk   (served at /app.apk)
#   AAB -> public\download\TradeMind-v1.0.0.aab   (upload to Play Console)
#
# IMPORTANT: the keystore fingerprint must stay in sync with
# public/.well-known/assetlinks.json or the installed app shows a URL bar.

$ErrorActionPreference = 'Stop'

$jdk        = 'C:\Program Files\Java\jdk-17'
$sdk        = 'D:\android\sdk'
$gradleHome = 'D:\android\.gradle'
$gradleBin  = 'D:\android\gradle-x\gradle-8.7\bin\gradle.bat'
$project    = 'D:\android\build\twa-app'
$repo       = Split-Path -Parent $PSScriptRoot
$outDir     = Join-Path $repo 'public\download'
$version    = '1.0.0'

foreach ($p in @($jdk, $sdk, $project)) {
  if (-not (Test-Path $p)) { throw "Missing prerequisite: $p" }
}

# Gradle 8.7 is downloaded on demand (it is not kept in the repo).
if (-not (Test-Path $gradleBin)) {
  Write-Host "Gradle 8.7 not found - downloading..."
  $zip = 'D:\android\gradle-8.7-bin.zip'
  Invoke-WebRequest -Uri 'https://services.gradle.org/distributions/gradle-8.7-bin.zip' -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath 'D:\android\gradle-dl' -Force
  New-Item -ItemType Directory -Force -Path 'D:\android\gradle-x' | Out-Null
  Move-Item 'D:\android\gradle-dl\gradle-8.7' 'D:\android\gradle-x\gradle-8.7' -Force
  Remove-Item $zip, 'D:\android\gradle-dl' -Recurse -Force -ErrorAction SilentlyContinue
}

$env:JAVA_HOME        = $jdk
$env:ANDROID_HOME     = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:GRADLE_USER_HOME = $gradleHome

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Push-Location $project
try {
  & $gradleBin assembleRelease
  if ($LASTEXITCODE -ne 0) { throw "assembleRelease failed" }
  & $gradleBin bundleRelease
  if ($LASTEXITCODE -ne 0) { throw "bundleRelease failed" }
} finally {
  Pop-Location
}

Copy-Item "$project\app\build\outputs\apk\release\app-release.apk" `
          (Join-Path $outDir "TradeMind-v$version.apk") -Force
Copy-Item "$project\app\build\outputs\bundle\release\app-release.aab" `
          (Join-Path $outDir "TradeMind-v$version.aab") -Force

Write-Host ""
Write-Host "APK -> $outDir\TradeMind-v$version.apk"
Write-Host "AAB -> $outDir\TradeMind-v$version.aab"
Write-Host ""
Write-Host "Verify signing fingerprint matches public\.well-known\assetlinks.json:"
& "$sdk\build-tools\34.0.0\apksigner.bat" verify --print-certs `
  "$outDir\TradeMind-v$version.apk" | Select-String 'SHA-256 digest'
