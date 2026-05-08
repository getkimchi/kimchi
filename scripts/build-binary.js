// Build the CLI into a standalone Bun binary under dist/.
// Steps: clean → typecheck → compile → fix macOS codesign → copy binary resources.
//
// Usage:
//   node scripts/build-binary.js                            # native build for current platform
//   node scripts/build-binary.js --target darwin-x64        # cross-compile for macOS Intel
//   node scripts/build-binary.js --target darwin-arm64      # cross-compile for macOS Apple Silicon
//   node scripts/build-binary.js --target linux-arm64       # cross-compile for Linux ARM64
//   node scripts/build-binary.js --target linux-x64         # cross-compile for Linux x86-64

import { execSync } from "node:child_process"
import { platform } from "node:os"

const TARGET_MAP = {
	"darwin-arm64": "bun-darwin-arm64",
	"darwin-x64": "bun-darwin-x64",
	"linux-arm64": "bun-linux-arm64",
	"linux-x64": "bun-linux-x64",
}

const targetArg =
	process.argv.find((a) => a.startsWith("--target="))?.split("=")[1] ??
	(process.argv.includes("--target") ? process.argv[process.argv.indexOf("--target") + 1] : undefined)

const crossTarget = targetArg ? (TARGET_MAP[targetArg] ?? targetArg) : undefined

function run(label, cmd) {
	console.log(`\n→ ${label}`)
	try {
		execSync(cmd, { stdio: "inherit" })
	} catch (error) {
		throw new Error(`Build step "${label}" failed: ${cmd}`, { cause: error })
	}
}

run("clean", "pnpm run clean")
run("typecheck", "pnpm run typecheck")

// Externalize packages that cannot be bundled into a Bun compiled binary (native addons, browser automation harnesses).
// If a new dependency causes a build failure, check whether it also needs --external here.
const targetFlag = crossTarget ? ` --target=${crossTarget}` : ""
run(
	"compile",
	`bun build src/entry.ts --compile${targetFlag} --outfile dist/bin/kimchi --external chromium-bidi --external electron`,
)

// Bun --compile produces binaries with an invalid code signature on macOS.
// The kernel kills badly-signed arm64 binaries immediately (SIGKILL, exit 137).
// Strip the corrupt signature and re-sign ad-hoc. See: https://github.com/oven-sh/bun/issues/7208
const isDarwinTarget = crossTarget ? crossTarget.includes("darwin") : platform() === "darwin"
if (isDarwinTarget && platform() === "darwin") {
	run("codesign (strip)", "codesign --remove-signature dist/bin/kimchi")
	run("codesign (ad-hoc)", "codesign -s - dist/bin/kimchi")
}

run("copy resources", "node scripts/copy-resources.js")
