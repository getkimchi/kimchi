// Build the CLI into a standalone Bun binary under dist/.
// Steps: clean → typecheck → compile → fix macOS codesign → copy binary resources.
//
// Usage:
//   node scripts/build-binary.js                        # build for the host platform
//   node scripts/build-binary.js --target linux-arm64   # cross-compile for Linux ARM64 (Apple Silicon Docker)
//   node scripts/build-binary.js --target linux-x64     # cross-compile for Linux x86-64

import { execSync } from "node:child_process"
import { platform } from "node:os"

const TARGET_MAP = {
	"darwin-x64": "bun-darwin-x64",
	"darwin-arm64": "bun-darwin-arm64",
	"linux-arm64": "bun-linux-arm64",
	"linux-x64": "bun-linux-x64",
	"windows-x64": "bun-windows-x64",
}

const targetArg =
	process.argv.find((a) => a.startsWith("--target="))?.split("=")[1] ??
	(process.argv.includes("--target") ? process.argv[process.argv.indexOf("--target") + 1] : undefined)

const crossTarget = targetArg ? (TARGET_MAP[targetArg] ?? targetArg) : undefined
const isCrossCompile = !!crossTarget

const exeName = platform() === "win32" || crossTarget?.includes("windows") ? "kimchi.exe" : "kimchi"

function run(label, cmd) {
	console.log(`\n→ ${label}`)
	try {
		execSync(cmd, { stdio: "inherit" })
	} catch (error) {
		throw new Error(`Build step "${label}" failed: ${cmd}`, { cause: error })
	}
}

const isCI = !!process.env.CI

// In CI the binary will be build in its own step.
if (!isCI) {
	run("build proxy-helper", "make -C tools/proxy-helper build")
}

run("clean", "pnpm run clean")
run("typecheck", "pnpm run typecheck")

// Externalize packages that cannot be bundled into a Bun compiled binary (native addons, browser automation harnesses).
// If a new dependency causes a build failure, check whether it also needs --external here.
const targetFlag = crossTarget ? ` --target=${crossTarget}` : ""

// Trust the OS certificate store in addition to Bun's bundled roots so users behind
// TLS-intercepting corporate proxies (Netskope, Zscaler, etc.) can reach the API without
// extra env vars. Bun ignores the system store by default; --use-system-ca is additive.
const isWindowsTarget = crossTarget?.includes("windows") || (!crossTarget && platform() === "win32")
const execArgv = isWindowsTarget
	? `--use-system-ca --jsc-useJITCage=false`
	: `--use-system-ca`

run(
	"compile",
	`bun build src/entry.ts --compile${targetFlag} --compile-exec-argv="${execArgv}" --outfile dist/bin/${exeName} --external chromium-bidi --external electron`.trim(),
)

// Bun --compile produces binaries with an invalid code signature on macOS.
// The kernel kills badly-signed arm64 binaries immediately (SIGKILL, exit 137).
// Strip the corrupt signature and re-sign ad-hoc. See: https://github.com/oven-sh/bun/issues/7208
const isDarwinTarget = !crossTarget || crossTarget.includes("darwin")

if (platform() === "darwin" && isDarwinTarget) {
	run("codesign (strip)", `codesign --remove-signature dist/bin/${exeName}`)
	run("codesign (ad-hoc)", `codesign -s - dist/bin/${exeName}`)
}

run("copy resources", `node scripts/copy-resources.js ${targetArg ?? ""}`)
