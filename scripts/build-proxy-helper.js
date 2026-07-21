// Build the Go proxy-helper for the host platform or an explicit target.
//
// Usage:
//   node scripts/build-proxy-helper.js
//   node scripts/build-proxy-helper.js --target windows-x64
//   node scripts/build-proxy-helper.js --target bun-windows-x64

import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { arch, platform } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const helperDir = join(projectRoot, "tools", "proxy-helper")
const helperBinDir = join(helperDir, "bin")

const TARGETS = {
	"darwin-arm64": { goos: "darwin", goarch: "arm64", helperName: "proxy-helper" },
	"darwin-x64": { goos: "darwin", goarch: "amd64", helperName: "proxy-helper" },
	"linux-arm64": { goos: "linux", goarch: "arm64", helperName: "proxy-helper" },
	"linux-x64": { goos: "linux", goarch: "amd64", helperName: "proxy-helper" },
	"windows-x64": { goos: "windows", goarch: "amd64", helperName: "proxy-helper.exe" },
	"win-x64": { goos: "windows", goarch: "amd64", helperName: "proxy-helper.exe" },
	"bun-darwin-arm64": { goos: "darwin", goarch: "arm64", helperName: "proxy-helper" },
	"bun-darwin-x64": { goos: "darwin", goarch: "amd64", helperName: "proxy-helper" },
	"bun-linux-arm64": { goos: "linux", goarch: "arm64", helperName: "proxy-helper" },
	"bun-linux-x64": { goos: "linux", goarch: "amd64", helperName: "proxy-helper" },
	"bun-windows-x64": { goos: "windows", goarch: "amd64", helperName: "proxy-helper.exe" },
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
	throw new Error(`Unsupported proxy-helper host platform: ${os}/${cpu}`)
}

const targetKey = targetArg ?? hostTargetKey()
const target = TARGETS[targetKey]
if (!target) {
	throw new Error(`Unsupported proxy-helper target: ${targetKey}`)
}

mkdirSync(helperBinDir, { recursive: true })
const outPath = join(helperBinDir, target.helperName)

console.log(`Building proxy-helper for ${target.goos}/${target.goarch} -> ${outPath}`)
execFileSync("go", ["build", "-ldflags=-s -w", "-o", outPath, "."], {
	cwd: helperDir,
	stdio: "inherit",
	env: {
		...process.env,
		CGO_ENABLED: process.env.CGO_ENABLED ?? "0",
		GOOS: target.goos,
		GOARCH: target.goarch,
	},
})
