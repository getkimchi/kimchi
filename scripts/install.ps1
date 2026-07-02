#!/usr/bin/env pwsh
#
# Install the native Windows Kimchi CLI from the latest GitHub release.
#
# Usage:
#   irm https://github.com/getkimchi/kimchi/releases/latest/download/install.ps1 | iex
#
# Optional env:
#   KIMCHI_INSTALL_DIR     Override install root. Defaults to
#                          $env:LOCALAPPDATA\Kimchi.
#   KIMCHI_VERSION         Pin a specific version tag (e.g. v0.2.0). Defaults
#                          to "latest".
#   KIMCHI_REPO_OVERRIDE   Override release repo. Defaults to getkimchi/kimchi.
#   KIMCHI_ARCHIVE_PATH    Use a local kimchi_windows_amd64.zip archive
#                          instead of downloading. Intended for CI/dev.
#   KIMCHI_SKIP_PATH_UPDATE  Set to 1 to skip user PATH updates.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Get-EnvOrDefault {
  param([string]$Name, [string]$Default)

  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $Default
  }
  return $value
}

function Test-Windows {
  if ($env:OS -eq "Windows_NT") {
    return $true
  }

  try {
    return [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
      [System.Runtime.InteropServices.OSPlatform]::Windows
    )
  } catch {
    return $false
  }
}

function Get-WindowsArch {
  $arch = $env:PROCESSOR_ARCHITECTURE
  if ([string]::IsNullOrWhiteSpace($arch)) {
    try {
      $arch = [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
    } catch {
      $arch = ""
    }
  }

  switch -Regex ($arch) {
    "^(AMD64|X64|x86_64)$" { return "amd64" }
    default {
      throw "Unsupported Windows architecture: $arch. Kimchi currently publishes Windows amd64 release artifacts only."
    }
  }
}

function Get-DefaultInstallRoot {
  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    return (Join-Path $env:LOCALAPPDATA "Kimchi")
  }
  return (Join-Path $HOME "AppData\Local\Kimchi")
}

function Invoke-DownloadFile {
  param([string]$Url, [string]$OutFile)

  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch {
  }

  $params = @{
    Uri = $Url
    OutFile = $OutFile
  }
  if ($PSVersionTable.PSVersion.Major -lt 6) {
    $params.UseBasicParsing = $true
  }
  Invoke-WebRequest @params
}

function Expand-KimchiArchive {
  param([string]$ArchivePath, [string]$Destination)

  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  try {
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $Destination -Force
  } catch {
    throw "Failed to extract $ArchivePath with Expand-Archive: $($_.Exception.Message)"
  }
}

function Assert-LastExitCode {
  param([string]$Label)

  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE."
  }
}

function Get-NormalizedPathForCompare {
  param([string]$Path)

  try {
    $expanded = [Environment]::ExpandEnvironmentVariables($Path)
    return ([IO.Path]::GetFullPath($expanded).TrimEnd([char[]]@("\", "/"))).ToUpperInvariant()
  } catch {
    return $Path.TrimEnd([char[]]@("\", "/")).ToUpperInvariant()
  }
}

function Test-PathListContains {
  param([string]$PathList, [string]$Directory)

  if ([string]::IsNullOrWhiteSpace($PathList)) {
    return $false
  }

  $target = Get-NormalizedPathForCompare $Directory
  foreach ($entry in ($PathList -split ";")) {
    if ([string]::IsNullOrWhiteSpace($entry)) {
      continue
    }
    if ((Get-NormalizedPathForCompare $entry) -eq $target) {
      return $true
    }
  }
  return $false
}

function Add-UserPath {
  param([string]$Directory)

  $processPath = [Environment]::GetEnvironmentVariable("Path", "Process")
  if (-not (Test-PathListContains $processPath $Directory)) {
    $env:Path = "$Directory;$env:Path"
  }

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (Test-PathListContains $userPath $Directory) {
    return $false
  }

  if ([string]::IsNullOrWhiteSpace($userPath)) {
    [Environment]::SetEnvironmentVariable("Path", $Directory, "User")
  } else {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$Directory", "User")
  }
  return $true
}

function Install-Kimchi {
  if (-not (Test-Windows)) {
    throw "This installer is for native Windows. On macOS/Linux, use: curl -fsSL https://github.com/getkimchi/kimchi/releases/latest/download/install.sh | bash"
  }

  $repo = Get-EnvOrDefault "KIMCHI_REPO_OVERRIDE" "getkimchi/kimchi"
  $version = Get-EnvOrDefault "KIMCHI_VERSION" "latest"
  $installRoot = Get-EnvOrDefault "KIMCHI_INSTALL_DIR" (Get-DefaultInstallRoot)
  $arch = Get-WindowsArch
  $assetName = "kimchi_windows_${arch}.zip"
  $tmpDir = Join-Path ([IO.Path]::GetTempPath()) "kimchi-installer-$PID"
  $extractDir = Join-Path $tmpDir "extract"

  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tmpDir
  New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

  try {
    $localArchive = [Environment]::GetEnvironmentVariable("KIMCHI_ARCHIVE_PATH")
    if ([string]::IsNullOrWhiteSpace($localArchive)) {
      $archivePath = Join-Path $tmpDir $assetName
      if ($version -eq "latest") {
        $binaryUrl = "https://github.com/$repo/releases/latest/download/$assetName"
      } else {
        $binaryUrl = "https://github.com/$repo/releases/download/$version/$assetName"
      }

      Write-Host "Downloading Kimchi for windows/$arch from $repo ($version)..."
      Invoke-DownloadFile $binaryUrl $archivePath
    } else {
      $archivePath = [IO.Path]::GetFullPath($localArchive)
      if (-not (Test-Path $archivePath -PathType Leaf)) {
        throw "KIMCHI_ARCHIVE_PATH does not exist: $archivePath"
      }
      Write-Host "Installing Kimchi from local archive $archivePath..."
    }

    Expand-KimchiArchive $archivePath $extractDir

    $archiveBin = Join-Path (Join-Path $extractDir "bin") "kimchi.exe"
    $archiveShare = Join-Path (Join-Path $extractDir "share") "kimchi"
    $archiveHelper = Join-Path (Join-Path $archiveShare "bin") "proxy-helper.exe"
    if (-not (Test-Path $archiveBin -PathType Leaf)) {
      throw "Archive did not contain bin\kimchi.exe."
    }
    if (-not (Test-Path $archiveShare -PathType Container)) {
      throw "Archive did not contain share\kimchi."
    }
    if (-not (Test-Path $archiveHelper -PathType Leaf)) {
      throw "Archive did not contain share\kimchi\bin\proxy-helper.exe."
    }

    $binDir = Join-Path $installRoot "bin"
    $shareParent = Join-Path $installRoot "share"
    $shareDir = Join-Path $shareParent "kimchi"
    $kimchiPath = Join-Path $binDir "kimchi.exe"
    $helperPath = Join-Path (Join-Path $shareDir "bin") "proxy-helper.exe"

    New-Item -ItemType Directory -Force -Path $binDir, $shareParent | Out-Null
    Remove-Item -Force -ErrorAction SilentlyContinue $kimchiPath
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $shareDir
    Copy-Item -Force $archiveBin $kimchiPath
    Copy-Item -Recurse -Force $archiveShare $shareDir

    $versionOutput = & $kimchiPath --version
    Assert-LastExitCode "kimchi.exe --version"
    & $helperPath ssh-proxy --help *> $null
    Assert-LastExitCode "proxy-helper.exe ssh-proxy --help"

    $pathSkipped = [Environment]::GetEnvironmentVariable("KIMCHI_SKIP_PATH_UPDATE") -eq "1"
    $pathAdded = $false
    if (-not $pathSkipped) {
      try {
        $pathAdded = Add-UserPath $binDir
      } catch {
        Write-Warning "Kimchi was installed, but the user PATH update failed: $($_.Exception.Message)"
      }
    }

    Write-Host ""
    Write-Host "Kimchi was installed successfully."
    Write-Host "Binary: $kimchiPath"
    if ($versionOutput) {
      $versionOutput | ForEach-Object { Write-Host "Version: $_" }
    }

    if ($pathSkipped) {
      Write-Host "PATH update skipped because KIMCHI_SKIP_PATH_UPDATE=1."
    } elseif ($pathAdded) {
      Write-Host "Added $binDir to your user PATH."
      Write-Host "Restart already-open terminals if the kimchi command is not found."
    } else {
      Write-Host "$binDir is already on PATH."
    }

    Write-Host ""
    Write-Host "Next: run kimchi setup, then kimchi."
  } finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tmpDir
  }
}

Install-Kimchi
