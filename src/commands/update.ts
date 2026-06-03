import { DefaultPackageManager, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent"
import { isHomebrewInstall } from "../update/paths.js"
import { applyUpdate, checkForUpdate } from "../update/workflow.js"
import { getVersion } from "../utils.js"

interface UpdateFlags {
	force: boolean
	dryRun: boolean
	canary: boolean
	target: "all" | "self" | "packages"
	packageSource?: string
}

function parseFlags(args: string[]): UpdateFlags | string {
	const flags = { force: false, dryRun: false, canary: false }
	let self = false
	let extensions = false
	let positional: string | undefined
	let packageSource: string | undefined

	for (let index = 0; index < args.length; index++) {
		const a = args[index]
		if (a === "--force" || a === "-f") flags.force = true
		else if (a === "--dry-run") flags.dryRun = true
		else if (a === "--canary") flags.canary = true
		else if (a === "--self") self = true
		else if (a === "--extensions") extensions = true
		else if (a === "--extension") {
			const value = args[index + 1]
			if (!value || value.startsWith("-")) return "missing value for --extension"
			if (packageSource) return "--extension can only be provided once"
			packageSource = value
			index++
		} else if (a === "--help" || a === "-h") {
			return [
				"Usage: kimchi update [source|self|pi] [--self] [--extensions] [--extension <source>] [--canary] [--force] [--dry-run]",
				"",
				"  source        Update one installed Pi package, e.g. context-mode or npm:context-mode",
				"  self, pi      Update Kimchi itself only",
				"  --self        Update Kimchi itself only",
				"  --extensions  Update installed Pi packages only",
				"  --extension   Update one installed Pi package by source or display name",
				"  --canary      Install the latest canary build from master",
				"  --force, -f   Skip the confirmation prompt",
				"  --dry-run     Check Kimchi self-updates without installing",
			].join("\n")
		} else if (a.startsWith("-")) return `unknown flag: ${a}`
		else if (!positional) positional = a
		else return `unexpected argument: ${a}`
	}

	if (packageSource && positional) return "--extension cannot be combined with a positional source"
	if (packageSource && (self || extensions)) return "--extension cannot be combined with --self or --extensions"
	const positionalIsSelf = positional === "self" || positional === "pi"
	if (positionalIsSelf) self = true
	else if (positional) {
		if (self || extensions) return "positional update targets cannot be combined with --self or --extensions"
		packageSource = positional
	}

	const packageTarget = Boolean(packageSource || extensions)
	if ((flags.canary || flags.dryRun) && packageTarget) {
		return "--canary and --dry-run can only be used when updating Kimchi itself"
	}

	const target: UpdateFlags["target"] =
		flags.canary || flags.dryRun || (self && !extensions) ? "self" : packageTarget && !self ? "packages" : "all"
	return { ...flags, target, packageSource }
}

/**
 * `kimchi update` — explicit self-update entry point. Always skips the
 * cached state so users get fresh results when they ask.
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

	if (flags.target === "packages" || flags.target === "all") {
		const packageUpdateCode = await updatePackages(flags.packageSource)
		if (packageUpdateCode !== 0) return packageUpdateCode
		if (flags.target === "packages") return 0
	}

	return updateSelf(flags)
}

async function updatePackages(source: string | undefined): Promise<number> {
	const agentDir = getAgentDir()
	const settingsManager = SettingsManager.create(process.cwd(), agentDir)
	const packageManager = new DefaultPackageManager({ cwd: process.cwd(), agentDir, settingsManager })
	const packages = packageManager.listConfiguredPackages()
	if (packages.length === 0) {
		console.log("kimchi packages: none installed")
		return 0
	}

	const updateSource = source ? resolvePackageSource(source, packages) : undefined
	if (source && !updateSource) {
		console.error(`kimchi update: no matching package found for ${source}`)
		return 1
	}

	packageManager.setProgressCallback((event) => {
		if (event.type === "start" && event.message) console.log(event.message)
	})
	try {
		await packageManager.update(updateSource)
	} catch (err) {
		console.error(`kimchi update: package update failed — ${(err as Error).message}`)
		return 1
	}
	console.log(updateSource ? `Updated ${updateSource}` : "Updated packages")
	return 0
}

function resolvePackageSource(
	input: string,
	packages: Array<{ source: string; scope: "user" | "project"; filtered: boolean; installedPath?: string }>,
): string | undefined {
	return packages.find((pkg) => packageSourceAliases(pkg.source).has(input))?.source
}

function packageSourceAliases(source: string): Set<string> {
	const aliases = new Set([source])
	if (!source.startsWith("npm:")) return aliases

	const spec = source.slice("npm:".length)
	aliases.add(spec)
	const slash = spec.indexOf("/")
	const versionAt = spec.startsWith("@") ? spec.indexOf("@", Math.max(slash, 0) + 1) : spec.indexOf("@")
	if (versionAt > 0) aliases.add(spec.slice(0, versionAt))
	return aliases
}

async function updateSelf(flags: Pick<UpdateFlags, "canary" | "dryRun" | "force">): Promise<number> {
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
			console.log("  curl -fsSL https://github.com/getkimchi/kimchi/releases/latest/download/install.sh | bash")
			console.log("")
			console.log("Then re-run: kimchi update --canary")
			return 0
		}
		console.log("kimchi is managed by Homebrew. Use Homebrew to update:")
		console.log("")
		console.log("  brew upgrade kimchi")
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
		console.error(`kimchi update: update failed — ${(err as Error).message}`)
		console.error("")
		console.error(
			"Please copy the error message above and create a bug report at https://github.com/getkimchi/kimchi/issues",
		)
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
