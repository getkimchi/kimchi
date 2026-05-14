import { isHomebrewInstall } from "../update/paths.js"
import { applyUpdate, checkForUpdate } from "../update/workflow.js"
import { getVersion } from "../utils.js"

interface UpdateFlags {
	force: boolean
	dryRun: boolean
	canary: boolean
}

function parseFlags(args: string[]): UpdateFlags | string {
	const flags: UpdateFlags = { force: false, dryRun: false, canary: false }
	for (const a of args) {
		if (a === "--force" || a === "-f") flags.force = true
		else if (a === "--dry-run") flags.dryRun = true
		else if (a === "--canary") flags.canary = true
		else if (a === "--help" || a === "-h") {
			return [
				"Usage: kimchi update [--canary] [--force] [--dry-run]",
				"",
				"  --canary      Install the latest canary build from master",
				"  --force, -f   Skip the confirmation prompt",
				"  --dry-run     Check for updates without installing",
			].join("\n")
		} else return `unknown flag: ${a}`
	}
	return flags
}

/**
 * `kimchi update` — explicit self-update entry point. Always skips the
 * 24h cache so users get fresh results when they ask.
 *
 * On Linux/macOS the swap is atomic via POSIX rename(2); on Windows we
 * rotate kimchi.exe → kimchi.exe.old and the user is told to restart
 * their terminal.
 */
export async function runUpdate(args: string[]): Promise<number> {
	const parsed = parseFlags(args)
	if (typeof parsed === "string") {
		if (parsed.startsWith("Usage:")) {
			console.log(parsed)
			return 0
		}
		console.error(`kimchi update: ${parsed}`)
		return 2
	}
	const flags = parsed

	// Homebrew manages its own package lifecycle. Self-patching a Homebrew
	// binary would bypass its shim layer, break the Cellar layout, and risk
	// losing the installation on the next `brew cleanup`. Direct the user to
	// the correct upgrade path instead.
	if (isHomebrewInstall()) {
		if (flags.canary) {
			console.log("kimchi is managed by Homebrew. Canary builds are not published to Homebrew.")
			console.log("")
			console.log("To use canary, uninstall the Homebrew package and reinstall directly:")
			console.log("")
			console.log("  brew uninstall kimchi")
			console.log("  curl -fsSL https://github.com/castai/kimchi-dev/releases/latest/download/install.sh | bash")
			console.log("")
			console.log("Then re-run: kimchi update --canary")
			return 0
		}
		console.log("kimchi is managed by Homebrew. Use Homebrew to update:")
		console.log("")
		console.log("  brew upgrade kimchi-dev")
		console.log("")
		console.log("If you want the self-update behaviour, install kimchi outside of Homebrew.")
		return 0
	}

	const current = getVersion()
	let check: Awaited<ReturnType<typeof checkForUpdate>>
	try {
		check = await checkForUpdate({ currentVersion: current, skipCache: true, canary: flags.canary })
	} catch (err) {
		console.error(`kimchi update: failed to check for updates: ${(err as Error).message}`)
		return 1
	}

	if (!check.hasUpdate) {
		console.log(`kimchi: already up to date (${current})`)
		return 0
	}
	if (flags.dryRun) {
		console.log(`kimchi update available: ${current} → ${check.latestVersion}`)
		if (check.releaseUrl) console.log(`  ${check.releaseUrl}`)
		return 0
	}

	if (!flags.force) {
		// Bare confirmation — read a single line from stdin. Default is "yes"
		// on bare Enter. We deliberately don't pull in @clack/prompts here
		// because the harness's normal flow may be non-interactive (CI
		// pipelines run `kimchi update --force`).
		const ok = await confirm(`Kimchi update available: ${current} → ${check.latestVersion}\nUpdate? [Y/n]: `)
		if (!ok) {
			console.log("Update skipped.")
			return 0
		}
	}

	console.log(`Updating to ${check.latestVersion}…`)
	try {
		await applyUpdate({ tag: check.tag })
	} catch (err) {
		console.error(`kimchi update: ${(err as Error).message}`)
		return 1
	}

	if (process.platform === "win32") {
		console.log(`✓ kimchi installed: ${check.latestVersion}`)
		console.log("Restart your terminal to use the new version.")
	} else {
		console.log(`✓ kimchi updated to ${check.latestVersion}`)
	}
	return 0
}

async function confirm(prompt: string): Promise<boolean> {
	process.stdout.write(prompt)
	return new Promise((resolve) => {
		const onData = (chunk: Buffer) => {
			process.stdin.off("data", onData)
			process.stdin.pause()
			const answer = chunk.toString("utf-8").trim().toLowerCase()
			resolve(answer === "" || answer === "y" || answer === "yes")
		}
		process.stdin.resume()
		process.stdin.on("data", onData)
	})
}
