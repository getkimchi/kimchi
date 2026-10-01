// Bundle a pinned native macOS notifier. Version 3 handles clicks after the CLI exits.
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export async function copyMacNotifier(projectRoot, shareDir) {
	const version = "3.1.0"
	const sha256 = "e969d4ae20287da1ba55495ae31dcedd8e9069deb8ce4eed24f6561a5fc3e4d5"
	const cache = join(projectRoot, "node_modules/.cache/kimchi")
	const archive = join(cache, `terminal-notifier-${version}.zip`)
	mkdirSync(cache, { recursive: true })
	const bytes = existsSync(archive)
		? readFileSync(archive)
		: Buffer.from(
				await (
					await fetch(
						`https://github.com/julienXX/terminal-notifier/releases/download/${version}/terminal-notifier-${version}.zip`,
						{ signal: AbortSignal.timeout(30_000) },
					)
				).arrayBuffer(),
			)
	if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
		throw new Error("terminal-notifier download failed SHA-256 verification")
	}
	writeFileSync(archive, bytes)
	const staging = mkdtempSync(join(tmpdir(), "kimchi-notifier-"))
	try {
		execFileSync("ditto", ["-x", "-k", archive, staging])
		const app = join(shareDir, "bin/kimchi-notifier.app")
		rmSync(app, { recursive: true, force: true })
		cpSync(join(staging, "terminal-notifier.app"), app, { recursive: true })
		cpSync(
			join(projectRoot, "resources/notifications/LICENSE.terminal-notifier"),
			join(app, "Contents/Resources/LICENSE"),
		)
		const plist = join(app, "Contents/Info.plist")
		for (const [key, value] of [
			["CFBundleIdentifier", "dev.kimchi.notifications"],
			["CFBundleName", "Kimchi"],
			["CFBundleDisplayName", "Kimchi"],
		]) {
			execFileSync("plutil", ["-replace", key, "-string", value, plist])
		}
		// The upstream localization overrides CFBundleName; keep our display name.
		writeFileSync(join(app, "Contents/Resources/en.lproj/InfoPlist.strings"), 'CFBundleName = "Kimchi";\n')
		// Apple's Terminal icon is excluded from the upstream MIT license.
		rmSync(join(app, "Contents/Resources/Terminal.icns"))
		execFileSync("plutil", ["-remove", "CFBundleIconFile", plist])
		const identity = process.env.CSC_NAME?.trim()
		execFileSync("codesign", [
			"--force",
			"--sign",
			identity || "-",
			...(identity ? ["--options", "runtime", "--timestamp"] : []),
			app,
		])
		execFileSync("codesign", ["--verify", "--strict", app])
	} finally {
		rmSync(staging, { recursive: true, force: true })
	}
}
