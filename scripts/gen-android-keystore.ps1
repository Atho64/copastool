<#
.SYNOPSIS
  Membuat keystore rilis Android CopasTool + file kredensial lokal.

.DESCRIPTION
  - Membuat key RSA 2048, validitas 10000 hari, alias default `copastool`.
  - Password dibuat acak (28 karakter alfanumerik, aman untuk cmd/bash/CI).
  - Menulis `release.jks` dan `release-keystore-credentials.txt` ke root repo
    (keduanya sudah masuk .gitignore, jangan pernah di-commit).
  - Setelah jalan, set 4 GitHub Actions secrets - lihat README -> "Android Release Signing".

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\gen-android-keystore.ps1
#>
[CmdletBinding()]
param(
    [string] $KeytoolPath,
    [string] $Alias = 'copastool',
    [string] $StorePath,
    [string] $CredentialsPath,
    [int]    $ValidityDays = 10000,
    [switch] $Force
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $StorePath) { $StorePath = Join-Path $repoRoot 'release.jks' }
if (-not $CredentialsPath) { $CredentialsPath = Join-Path $repoRoot 'release-keystore-credentials.txt' }

if (-not $KeytoolPath) {
    $candidates = @()
    $candidates += (Get-ChildItem "$env:USERPROFILE\.jdks" -Directory -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName 'bin\keytool.exe' })
    $candidates += (Get-ChildItem 'C:\Program Files\Java', 'C:\Program Files\Eclipse Adoptium', 'C:\Program Files\Zulu' -Recurse -Depth 3 -Filter 'keytool.exe' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
    $candidates += (Get-Command keytool -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
    $KeytoolPath = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (-not $KeytoolPath) {
    throw 'keytool.exe tidak ditemukan. Install JDK 17 (mis. winget install Microsoft.OpenJDK.17) atau isi -KeytoolPath.'
}

if ((Test-Path $StorePath) -and -not $Force) {
    throw "$StorePath sudah ada. Rename/hapus dulu, atau pakai -Force kalau memang mau membuat kunci baru (APK yang sudah terpasang tidak akan bisa di-update lagi)."
}

# Password acak dari CSPRNG. Hanya alfanumerik supaya aman di cmd/bash dan tidak
# butuh escaping di GitHub Actions.
$chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
$bytes = New-Object byte[] 28
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$password = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })

$env:KS_PASS = $password
$outFile = Join-Path $env:TEMP 'copastool-keytool-out.txt'
$errFile = Join-Path $env:TEMP 'copastool-keytool-err.txt'

# Argumen dibangun sebagai satu string supaya nilai yang mengandung spasi
# (path repo ini memuat spasi) tetap diterima keytool sebagai satu argumen.
$keytoolArgs = "-genkeypair -v -keystore `"$StorePath`" -storetype PKCS12 -keyalg RSA -keysize 2048 -validity $ValidityDays -alias $Alias -storepass:env KS_PASS -keypass:env KS_PASS -dname `"CN=CopasTool, OU=Mobile, O=CopasTool, L=Jakarta, S=Indonesia, C=ID`""

$proc = Start-Process -FilePath $KeytoolPath -ArgumentList $keytoolArgs -NoNewWindow -Wait -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
if ($proc.ExitCode -ne 0) {
    Get-Content $outFile, $errFile -ErrorAction SilentlyContinue | Write-Host
    throw "keytool gagal (exit code $($proc.ExitCode))."
}

$listArgs = "-list -v -keystore `"$StorePath`" -storepass:env KS_PASS"
$proc2 = Start-Process -FilePath $KeytoolPath -ArgumentList $listArgs -NoNewWindow -Wait -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
$info = Get-Content $outFile -Raw -ErrorAction SilentlyContinue
Remove-Item $outFile, $errFile -Force -ErrorAction SilentlyContinue

$fingerprint = [regex]::Match($info, 'SHA256: ([0-9A-F:]+)').Groups[1].Value
$validFrom = [regex]::Match($info, 'Valid from: ([^\r\n]+)').Groups[1].Value.Trim()

$lines = @(
    'CopasTool - Android release signing credentials'
    '================================================'
    "Dibuat: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
    ''
    'SIMPAN FILE INI + release.jks DI TEMPAT AMAN (password manager / cloud pribadi).'
    'Kalau hilang, APK baru tidak bisa lagi meng-update instalasi CopasTool yang sudah ada.'
    'Jangan pernah di-commit - file ini sudah masuk .gitignore.'
    ''
    "storeFile = $StorePath"
    'storeType = PKCS12'
    "storePassword = $password"
    "keyAlias = $Alias"
    "keyPassword = $password"
    "validityDays = $ValidityDays"
    "validFrom = $validFrom"
    "sha256Fingerprint = $fingerprint"
    ''
    'GitHub Actions secrets (repo Atho64/copastool):'
    '  ANDROID_KEYSTORE_BASE64   = base64 dari release.jks'
    '  ANDROID_KEYSTORE_PASSWORD = storePassword di atas'
    "  ANDROID_KEY_ALIAS         = $Alias"
    '  ANDROID_KEY_PASSWORD      = keyPassword di atas'
)
[System.IO.File]::WriteAllText($CredentialsPath, (($lines -join "`r`n") + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))

Write-Host "Keystore    : $StorePath ($((Get-Item $StorePath).Length) bytes)"
Write-Host "Credentials : $CredentialsPath"
Write-Host "Alias       : $Alias"
Write-Host "Fingerprint : $fingerprint"
Write-Host ''
Write-Host 'Langkah berikutnya (set 4 secrets):'
Write-Host "  `$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes('$StorePath'))"
Write-Host '  $b64 | gh secret set ANDROID_KEYSTORE_BASE64 --repo Atho64/copastool'
Write-Host '  lihat README -> Android Release Signing untuk detailnya.'
