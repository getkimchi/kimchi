import { execSync } from "node:child_process"
import { arch, platform } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { cleanGuiDist } from "./clean-gui-dist.js"

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

const TARGETS = {
	"darwin-arm64": {
		builder: "--mac dmg",
	},
	"darwin-x64": {
		builder: "--mac dmg",
	},
	"linux-arm64": {
		builder: "--linux AppImage",
	},
	"linux-x64": {
		builder: "--linux AppImage",
	},
	"windows-x64": {
		builder: "--win portable",
	},
	"win-x64": {
		builder: "--win portable",
	},
}

const targetArg =
	process.argv.find((a) => a.startsWith("--target="))?.split("=")[1] ??
	(process.argv.includes("--target") ? process.argv[process.argv.indexOf("--target") + 1] : undefined)

function hostTargetKey() {
	const os = platform()
	const cpu = arch()

	if (os === "darwin" && cpu === "arm64") {
		return "darwin-arm64"
	}

	if (os === "darwin" && cpu === "x64") {
		return "darwin-x64"
	}

	if (os === "linux" && cpu === "arm64") {
		return "linux-arm64"
	}

	if (os === "linux" && cpu === "x64") {
		return "linux-x64"
	}

	if (os === "win32" && cpu === "x64") {
		return "windows-x64"
	}

	throw new Error(`Unsupported build host platform: ${os}/${cpu}`)
}

const targetKey = targetArg ?? hostTargetKey()

const target = TARGETS[targetKey]

if (!target) {
	throw new Error(`Unsupported build target: ${targetKey}`)
}

function run(label, cmd) {
	console.log(`\n→ ${label}`)
	try {
		execSync(cmd, {
			cwd: projectRoot,
			stdio: "inherit",
		})
	} catch (error) {
		throw new Error(`Build step "${label}" failed: ${cmd}`, {
			cause: error,
		})
	}
}

run("Build Kimchi CLI", "bun run build:binary")
run("Build Electron GUI", "bun run gui:build")
run("Package Electron GUI", `bunx electron-builder ${target.builder}`)

cleanGuiDist()

console.log("\n✅ GUI build completed.")
