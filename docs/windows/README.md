# Windows Builds

This document explains how Kimchi's Windows binary is built, what the release
pipeline verifies, and how to reproduce the setup locally when fixing Windows
bugs.

## Native Install

Install the latest native Windows release from PowerShell:

```powershell
irm https://github.com/getkimchi/kimchi/releases/latest/download/install.ps1 | iex
```

The installer downloads `kimchi_windows_amd64.zip`, installs
`kimchi.exe` under `%LOCALAPPDATA%\Kimchi\bin`, stages shared runtime files
under `%LOCALAPPDATA%\Kimchi\share\kimchi`, and adds the `bin` directory to
the user `PATH`.

Set `KIMCHI_INSTALL_DIR` to override the install root:

```powershell
$env:KIMCHI_INSTALL_DIR = "C:\Tools\Kimchi"
irm https://github.com/getkimchi/kimchi/releases/latest/download/install.ps1 | iex
```

## Release Pipeline

Windows release artifacts should be built on a real GitHub-hosted Windows
runner, not cross-compiled from Linux. The Windows runner installs Windows
optional native packages, uses Windows process/path semantics, and gives us a
runtime smoke test for the final `kimchi.exe`.

The release matrix in `.github/workflows/release.yml` includes:

- `bun-windows-x64`
- `windows`
- `amd64`
- `windows-latest`

The Windows build job does the same packaging work as Linux/macOS:

1. Check out the repo with submodules.
2. Install Bun/pnpm dependencies through `.github/actions/setup`.
3. Set the package version from the release tag.
4. Install Go.
5. Build the Go proxy helper:

   ```bash
   node scripts/build-proxy-helper.js --target bun-windows-x64
   ```

6. Build the Bun standalone executable:

   ```bash
   node scripts/build-binary.js --target bun-windows-x64
   ```

7. Verify the Windows runtime surface:

   ```powershell
   .\dist\bin\kimchi.exe --version
   .\dist\bin\kimchi.exe --help
   .\dist\share\kimchi\bin\proxy-helper.exe ssh-proxy --help
   ```

8. Verify that `kimchi.exe --ssh-proxy` can locate and launch the bundled
   helper. The dummy endpoint is expected to fail at connection time; it must
   not fail with `proxy-helper binary not found`.

9. Package `kimchi_windows_amd64.zip` and verify `scripts/install.ps1`
   against that local archive.

10. Upload:

   ```text
   kimchi_windows_amd64.zip
   ```

The artifact layout is:

```text
bin/
  kimchi.exe
share/kimchi/
  package.json
  theme/
  export-html/
  oauth/
  vendor/
  bin/
    proxy-helper.exe
```

## Why `proxy-helper.exe` Matters

Teleport SSH uses an SSH `ProxyCommand`. In binary releases, the proxy command
enters `kimchi.exe --ssh-proxy <target>`, and Kimchi then spawns the bundled Go
helper from `share/kimchi/bin/proxy-helper.exe`.

Basic commands such as `--help`, `--version`, and non-SSH prompts do not prove
that Teleport works. Always include a dummy `--ssh-proxy` check when validating
Windows packaging.

Expected dummy failure:

```text
connectex: No connection could be made because the target machine actively refused it.
```

Bad packaging failure:

```text
proxy-helper binary not found
```

## Local Windows VM

Use this when debugging Windows-specific bugs from a Linux workstation. A GUI is
not required after installation; Windows Server Core with OpenSSH is enough.

Install local VM tooling on Ubuntu:

```bash
sudo apt update
sudo apt install -y \
  qemu-system-x86 \
  qemu-utils \
  virtinst \
  libvirt-daemon-system \
  libvirt-clients \
  ovmf \
  genisoimage
```

Create local storage directories:

```bash
mkdir -p ~/iso ~/vms
```

Download the Windows Server evaluation ISO from Microsoft and save it as:

```text
~/iso/windows-server.iso
```

Install Windows Server Core and enable OpenSSH inside the VM:

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service sshd -StartupType Automatic
New-NetFirewallRule -Name sshd -DisplayName "OpenSSH Server" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
```

For local-only QEMU user networking, forward host port `2222` to guest port
`22`, then connect from Linux:

```bash
ssh -p 2222 Administrator@127.0.0.1
```

## Manual Smoke Test In The VM

Copy a packaged artifact into Windows and extract it:

```bash
scp -P 2222 kimchi_windows_amd64.zip Administrator@127.0.0.1:
ssh -p 2222 Administrator@127.0.0.1
```

Inside Windows:

```powershell
Remove-Item -Recurse -Force C:\kimchi-test -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force C:\kimchi-test | Out-Null
Expand-Archive -LiteralPath $env:USERPROFILE\kimchi_windows_amd64.zip -DestinationPath C:\kimchi-test -Force

cd C:\kimchi-test
.\bin\kimchi.exe --version
.\bin\kimchi.exe --help
.\share\kimchi\bin\proxy-helper.exe ssh-proxy --help
```

Check the bundled helper path:

```powershell
$env:KIMCHI_API_KEY = "dummy"
$env:KIMCHI_REMOTE_ENDPOINT = "http://127.0.0.1:9"
.\bin\kimchi.exe --ssh-proxy dummy-session
```

The command should fail at the dummy API endpoint. It should not fail because
`proxy-helper.exe` cannot be found.

## Local Build Notes

On a Windows machine or Windows GitHub runner:

```powershell
corepack enable
pnpm install
pnpm run build:binary
```

From a Linux workstation, prefer the Windows VM for execution and the
`windows-latest` GitHub runner for release confidence. Linux cross-compilation is
useful for quick terminal/proxy smoke checks:

```bash
pnpm install
pnpm run build:binary-windows-x64
(cd dist && zip -r ../kimchi_windows_amd64.zip bin share)
```

Linux cross-builds externalize the Windows clipboard native addon because that
optional package is not installed on non-Windows hosts. Do not treat a Linux
cross-build as the final release signal.

## References

- Bun standalone executable targets: https://bun.com/docs/bundler/executables
- GitHub-hosted runners: https://docs.github.com/actions/using-github-hosted-runners/about-github-hosted-runners
- Windows Server evaluation downloads: https://www.microsoft.com/en-us/evalcenter/evaluate-windows-server-2025
- OpenSSH on Windows Server: https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse
