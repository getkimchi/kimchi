// Build the CLI into a standalone Bun binary under dist/.
// Steps: clean → typecheck → compile → fix macOS codesign → copy binary resources.
//
// Usage:
//   node scripts/build-binary.js                        # build for the host platform
//   node scripts/build-binary.js --target linux-arm64   # cross-compile for Linux ARM64 (Apple Silicon Docker)
//   node scripts/build-binary.js --target linux-x64     # cross-compile for Linux x86-64
//   node scripts/build-binary.js --target windows-x64   # build for Windows x86-64 baseline

import { execSync } from "node:child_process"
import { rmSync } from "node:fs"
import { arch, platform } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

const TARGETS = {
	"darwin-arm64": { bun: "bun-darwin-arm64", os: "darwin", binaryName: "kimchi" },
	"darwin-x64": { bun: "bun-darwin-x64", os: "darwin", binaryName: "kimchi" },
	"linux-arm64": { bun: "bun-linux-arm64", os: "linux", binaryName: "kimchi" },
	"linux-x64": { bun: "bun-linux-x64", os: "linux", binaryName: "kimchi" },
	"windows-x64": { bun: "bun-windows-x64-baseline", os: "win32", binaryName: "kimchi.exe" },
	"windows-x64-baseline": { bun: "bun-windows-x64-baseline", os: "win32", binaryName: "kimchi.exe" },
	"win-x64": { bun: "bun-windows-x64-baseline", os: "win32", binaryName: "kimchi.exe" },
	"bun-darwin-arm64": { bun: "bun-darwin-arm64", os: "darwin", binaryName: "kimchi" },
	"bun-darwin-x64": { bun: "bun-darwin-x64", os: "darwin", binaryName: "kimchi" },
	"bun-linux-arm64": { bun: "bun-linux-arm64", os: "linux", binaryName: "kimchi" },
	"bun-linux-x64": { bun: "bun-linux-x64", os: "linux", binaryName: "kimchi" },
	"bun-windows-x64": { bun: "bun-windows-x64", os: "win32", binaryName: "kimchi.exe" },
	"bun-windows-x64-baseline": { bun: "bun-windows-x64-baseline", os: "win32", binaryName: "kimchi.exe" },
}

const targetArg =
	process.argv.find((a) => a.startsWith("--target="))?.split("=")[1] ??
	(process.argv.includes("--target") ? process.argv[process.argv.indexOf("--target") + 1] : undefined)

function hostTargetKey() {
	const os = platform()
	const cpu = arch()
	if (os === "darwin" && cpu === "arm64") return "darwin-arm64"
	if (os === "darwin" && cpu === "x64") return "darwin-x64"
	if (os === "linux" && cpu === "arm64") return "linux-arm64"
	if (os === "linux" && cpu === "x64") return "linux-x64"
	if (os === "win32" && cpu === "x64") return "windows-x64"
	throw new Error(`Unsupported build host platform: ${os}/${cpu}`)
}

const targetKey = targetArg ?? hostTargetKey()
const target = TARGETS[targetKey]
if (!target) {
	throw new Error(`Unsupported build target: ${targetKey}`)
}

const crossTarget = targetArg ? target.bun : undefined
const isCrossCompile = !!crossTarget
process.env.KIMCHI_BUILD_TARGET_OS = target.os

function run(label, cmd) {
	console.log(`\n→ ${label}`)
	try {
		execSync(cmd, { stdio: "inherit" })
	} catch (error) {
		throw new Error(`Build step "${label}" failed: ${cmd}`, { cause: error })
	}
}

function cleanDist() {
	console.log("\n→ clean")
	rmSync(join(projectRoot, "dist"), { recursive: true, force: true })
}

const isCI = !!process.env.CI

// In CI the binary will be build in its own step.
if (!isCI) {
	const helperTargetFlag = targetArg ? ` --target ${targetKey}` : ""
	run("build proxy-helper", `node scripts/build-proxy-helper.js${helperTargetFlag}`)
}

cleanDist()
run("typecheck", "pnpm run typecheck")

// Externalize packages that cannot be bundled into a Bun compiled binary (native addons, browser automation harnesses).
// If a new dependency causes a build failure, check whether it also needs --external here.
const targetFlag = crossTarget ? ` --target=${crossTarget}` : ""
const externals = ["chromium-bidi", "electron"]
if (isCrossCompile && target.os === "win32" && platform() !== "win32") {
	// Linux/macOS installs do not include Windows-only optional native packages.
	// Release builds run on windows-latest and bundle this dependency; cross-builds
	// are for terminal/proxy smoke testing and gracefully lose clipboard images.
	externals.push(
		"@mariozechner/clipboard-win32-x64-msvc",
		"@mariozechner/clipboard-win32-x64-msvc/clipboard.win32-x64-msvc.node",
	)
}
const externalFlags = externals.map((name) => `--external ${name}`).join(" ")

// Trust the OS certificate store in addition to Bun's bundled roots so users behind
// TLS-intercepting corporate proxies (Netskope, Zscaler, etc.) can reach the API without
// extra env vars. Bun ignores the system store by default; --use-system-ca is additive.
run(
	"compile",
	`bun build src/entry.ts --compile${targetFlag} --compile-exec-argv="--use-system-ca" --outfile dist/bin/${target.binaryName} ${externalFlags}`.trim(),
)

// Bun --compile produces binaries with an invalid code signature on macOS.
// The kernel kills badly-signed arm64 binaries immediately (SIGKILL, exit 137).
// Strip the corrupt signature and re-sign ad-hoc. See: https://github.com/oven-sh/bun/issues/7208
if (!isCrossCompile && platform() === "darwin") {
	run("codesign (strip)", `codesign --remove-signature dist/bin/${target.binaryName}`)
	run("codesign (ad-hoc)", `codesign -s - dist/bin/${target.binaryName}`)
}

run("copy resources", "node scripts/copy-resources.js")
