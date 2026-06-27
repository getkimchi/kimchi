$ErrorActionPreference = "Stop"

$Repo = if ($env:KIMCHI_REPO_OVERRIDE) {
    $env:KIMCHI_REPO_OVERRIDE
} else {
    "getkimchi/kimchi"
}

$Version = if ($env:KIMCHI_VERSION) { $env:KIMCHI_VERSION } else { "latest" }

Write-Host "Installing Kimchi from $Repo ($Version)..."

switch ($env:PROCESSOR_ARCHITECTURE) {
    "AMD64" {
        $hasAVX2 = $false
        try {
            $hasAVX2 = [System.Runtime.Intrinsics.X86.Avx2]::IsSupported
        } catch {
            # System.Runtime.Intrinsics not available on PowerShell 5.1 (.NET Framework)
            # Falls back to x64_compat build to be safe
            $hasAVX2 = $false
        }
        if ($hasAVX2) {
            $Arch = "x64"
        } else {
            $Arch = "x64_compat"
        }
    }
    "ARM64" {
        Write-Error "Windows ARM64 is not currently supported."
        exit 1
    }
    default {
        Write-Error "Unsupported architecture: $env:PROCESSOR_ARCHITECTURE"
        exit 1
    }
}

if ($Version -eq "latest") {
    $ZipUrl = "https://github.com/$Repo/releases/latest/download/kimchi_windows_$Arch.zip"
}
else {
    $ZipUrl = "https://github.com/$Repo/releases/download/$Version/kimchi_windows_$Arch.zip"
}

try {
    $TempDir = Join-Path $env:TEMP ("kimchi-" + [guid]::NewGuid())
    $ZipPath = Join-Path $TempDir "kimchi.zip"

    New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

    Write-Host "Downloading Kimchi for windows/$Arch..."
    Invoke-WebRequest -Uri $ZipUrl -OutFile $ZipPath

    Write-Host "Extracting..."
    Expand-Archive -Path $ZipPath -DestinationPath $TempDir -Force

    $InstallDir = if ($env:KIMCHI_INSTALL_DIR) {
        $env:KIMCHI_INSTALL_DIR
    } else {
        Join-Path $env:LOCALAPPDATA "Kimchi"
    }

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

    Copy-Item "$TempDir\bin" -Destination $InstallDir -Recurse -Force
    Copy-Item "$TempDir\share" -Destination $InstallDir -Recurse -Force

    $BinDir = Join-Path $InstallDir "bin"

    if (!(Test-Path "$BinDir\kimchi.exe" -PathType Leaf)) {
        throw "kimchi.exe was not installed."
    }
}
finally {
    if (Test-Path $TempDir) {
        Remove-Item $TempDir -Recurse -Force
    }
}

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")

if ($UserPath -notlike "*$BinDir*") {
    [Environment]::SetEnvironmentVariable(
        "Path",
        "$UserPath;$BinDir",
        "User"
    )

    Write-Host ""
    Write-Host "Added $BinDir to your user PATH."
    Write-Host "Open a new PowerShell window to use kimchi."
}

Write-Host ""
Write-Host "Installed Kimchi to:"
Write-Host "$BinDir\kimchi.exe"

Write-Host ""
Write-Host "Next: run"
Write-Host "  kimchi setup"
Write-Host "or"
Write-Host "  kimchi"
