// Package dist/bin and dist/share into the release artifact for a target OS/arch.
//
// Usage:
//   node scripts/package-release-asset.js --os linux --arch amd64
//   node scripts/package-release-asset.js --os windows --arch amd64

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

const args = parseArgs(process.argv.slice(2))
const os = requiredArg(args, "os")
const arch = requiredArg(args, "arch")
const distDir = resolve(args.dist ?? "dist")
const outDir = resolve(args.outDir ?? ".")

assertDirectory(resolve(distDir, "bin"))
assertDirectory(resolve(distDir, "share"))

const artifactName = `kimchi_${os}_${arch}.${os === "windows" ? "zip" : "tar.gz"}`
const artifactPath = resolve(outDir, artifactName)

if (os === "windows") {
	execFileSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			[
				"$ErrorActionPreference = 'Stop'",
				"$dist = [IO.Path]::GetFullPath($env:KIMCHI_PACKAGE_DIST)",
				"$out = [IO.Path]::GetFullPath($env:KIMCHI_PACKAGE_OUT)",
				"Compress-Archive -LiteralPath (Join-Path $dist 'bin'),(Join-Path $dist 'share') -DestinationPath $out -Force",
			].join("; "),
		],
		{
			stdio: "inherit",
			env: {
				...process.env,
				KIMCHI_PACKAGE_DIST: distDir,
				KIMCHI_PACKAGE_OUT: artifactPath,
			},
		},
	)
} else {
	execFileSync("tar", ["-czf", artifactPath, "-C", distDir, "bin", "share"], { stdio: "inherit" })
}

console.log(artifactName)

function parseArgs(argv) {
	const parsed = {}
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (!arg.startsWith("--")) {
			throw new Error(`Unexpected argument: ${arg}`)
		}
		const [key, inlineValue] = arg.slice(2).split("=", 2)
		if (!key) throw new Error(`Invalid argument: ${arg}`)
		const value = inlineValue ?? argv[++i]
		if (!value || value.startsWith("--")) {
			throw new Error(`Missing value for --${key}`)
		}
		parsed[key] = value
	}
	return parsed
}

function requiredArg(args, name) {
	const value = args[name]
	if (!value) {
		throw new Error(`Missing required --${name}`)
	}
	return value
}

function assertDirectory(path) {
	if (!existsSync(path)) {
		throw new Error(`Required package directory does not exist: ${path}`)
	}
}
