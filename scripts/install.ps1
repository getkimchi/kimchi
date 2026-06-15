# install.ps1

$ErrorActionPreference = "Stop"

$Repo = if ($env:KIMCHI_REPO_OVERRIDE) { $env:KIMCHI_REPO_OVERRIDE } else { "castai/kimchi" }
$Version = if ($env:KIMCHI_VERSION) { $env:KIMCHI_VERSION } else { "latest" }

Write-Host "Installing Kimchi from $Repo ($Version)..."

# Detect architecture
switch ($env:PROCESSOR_ARCHITECTURE) {
    "AMD64" { $Arch = "amd64" }
    "ARM64" { $Arch = "arm64" }
    default {
        Write-Error "Unsupported architecture: $env:PROCESSOR_ARCHITECTURE"
        exit 1
    }
}

# Resolve download URL
if ($Version -eq "latest") {
    $ZipUrl = "https://github.com/$Repo/releases/latest/download/kimchi_windows_$Arch.zip"
}
else {
    $ZipUrl = "https://github.com/$Repo/releases/download/$Version/kimchi_windows_$Arch.zip"
}

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

# Release zip contains bin/ and share/
Copy-Item "$TempDir\bin" -Destination $InstallDir -Recurse -Force
Copy-Item "$TempDir\share" -Destination $InstallDir -Recurse -Force

$BinDir = Join-Path $InstallDir "bin"

# Add to user PATH
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
