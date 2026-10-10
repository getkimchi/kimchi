// macOS notifications need an app bundle so the OS can relaunch it for clicks.
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { arch } from "node:os"
import { join } from "node:path"

export function buildMacNotifier(projectRoot, shareDir) {
	const app = join(shareDir, "bin/kimchi-notifier.app")
	rmSync(app, { recursive: true, force: true })
	mkdirSync(join(app, "Contents/MacOS"), { recursive: true })
	const targetArch = (process.env.KIMCHI_BUILD_TARGET_ARCH || arch()) === "x64" ? "x86_64" : "arm64"
	execFileSync(
		"xcrun",
		[
			"swiftc",
			"-O",
			"-target",
			`${targetArch}-apple-macos11.0`,
			join(projectRoot, "tools/notification-helper/main.swift"),
			"-o",
			join(app, "Contents/MacOS/kimchi-notifier"),
		],
		{ stdio: "inherit" },
	)
	const plist = join(app, "Contents/Info.plist")
	writeFileSync(
		plist,
		JSON.stringify({
			CFBundleIdentifier: "dev.kimchi.notifications",
			CFBundleName: "Kimchi",
			CFBundleDisplayName: "Kimchi",
			CFBundleExecutable: "kimchi-notifier",
			CFBundlePackageType: "APPL",
			CFBundleVersion: "1",
			LSMinimumSystemVersion: "11.0",
			LSUIElement: true,
		}),
	)
	execFileSync("plutil", ["-convert", "xml1", plist])
	const identity = process.env.CSC_NAME?.trim()
	execFileSync("codesign", [
		"--force",
		"--sign",
		identity || "-",
		...(identity ? ["--options", "runtime", "--timestamp"] : []),
		app,
	])
	execFileSync("codesign", ["--verify", "--strict", app])
}
