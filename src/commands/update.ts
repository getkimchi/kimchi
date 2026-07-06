import {
	DefaultPackageManager,
	SettingsManager,
	getAgentDir,
	parseArgs as parsePiArgs,
} from "@earendil-works/pi-coding-agent"
import { isHomebrewInstall } from "../update/paths.js"
import { applyUpdate, checkForUpdate } from "../update/workflow.js"
import { getVersion } from "../utils.js"

interface UpdateFlags {
	force: boolean
	dryRun: boolean
	canary: boolean
	version?: string
	target: "all" | "self" | "packages"
	packageSource?: string
}

const UPDATE_USAGE = [
	"Usage: kimchi update [source|self|pi|version] [--self] [--extensions] [--extension <source>] [--canary] [--force] [--dry-run]",
	"",
	"  source        Update one installed Pi package, e.g. context-mode or npm:context-mode",
	"  version       Install a specific Kimchi release, e.g. v1.2.3 or v1.2.3-rc.1 (downgrades allowed)",
	"  self, pi      Update Kimchi itself only",
	"  --self        Update Kimchi itself only",
	"  --extensions  Update installed Pi packages only",
	"  --extension   Update one installed Pi package by source or display name",
	"  --canary      Install the latest canary build from master",
	"  --force, -f   Skip the confirmation prompt",
	"  --dry-run     Check Kimchi self-updates without installing",
].join("\n")

const UPDATE_FLAGS = new Set([
	"--help",
	"-h",
	"--force",
	"-f",
	"--dry-run",
	"--canary",
	"--self",
	"--extensions",
	"--extension",
])

const UPDATE_BOOLEAN_FLAGS = ["force", "dry-run", "canary", "self", "extensions"] as const

/** Positionals that look like a release version, e.g. "v1.2.3", "1.2.3", "v1.2.3-rc.1". */
const VERSION_POSITIONAL_RE = /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

function parseFlags(args: string[]): UpdateFlags | string {
	// Versions are positional (`kimchi update v1.2.3`); catch the flag
	// spelling people will guess first and point them at the right form.
	if (args.some((arg) => arg === "--version" || arg.startsWith("--version="))) {
		return "unknown flag: --version (pass the version directly: kimchi update v1.2.3)"
	}

	const unsupported = findUnsupportedUpdateFlag(args)
	if (unsupported) return `unknown flag: ${unsupported}`

	const parsed = parsePiArgs(args.map((arg) => (arg === "-f" ? "--force" : arg)))
	if (parsed.help) return UPDATE_USAGE

	const diagnostic = parsed.diagnostics.find((entry) => entry.type === "error")
	if (diagnostic) return diagnostic.message

	const messages = [...parsed.messages]
	const flags = { force: false, dryRun: false, canary: false }
	let self = false
	let extensions = false

	for (const flag of UPDATE_BOOLEAN_FLAGS) {
		const enabled = readUpdateBooleanFlag(parsed.unknownFlags, flag, messages, args)
		if (typeof enabled === "string") return enabled
		if (!enabled) continue
		if (flag === "force") flags.force = true
		else if (flag === "dry-run") flags.dryRun = true
		else if (flag === "canary") flags.canary = true
		else if (flag === "self") self = true
		else if (flag === "extensions") extensions = true
	}

	const extensionValues = [...(parsed.extensions ?? [])]
	const extensionEqualsValue = parsed.unknownFlags.get("extension")
	if (typeof extensionEqualsValue === "string") extensionValues.push(extensionEqualsValue)
	else if (extensionEqualsValue === true) return "missing value for --extension"
	if (extensionValues.length > 1) return "--extension can only be provided once"
	let packageSource = extensionValues[0]
	if (packageSource?.startsWith("-")) return "missing value for --extension"

	if (messages.length > 1) return `unexpected argument: ${messages[1]}`
	let positional: string | undefined = messages[0]
	let version: string | undefined

	if (packageSource && positional) return "--extension cannot be combined with a positional source"
	if (packageSource && (self || extensions)) return "--extension cannot be combined with --self or --extensions"
	const positionalIsSelf = positional === "self" || positional === "pi"

	// A version-like positional (`kimchi update v1.2.3`) targets Kimchi
	// itself; anything else stays a package source, so package names keep
	// working unchanged.
	if (positional && !positionalIsSelf && VERSION_POSITIONAL_RE.test(positional)) {
		version = normalizeVersionTag(positional)
		positional = undefined
	}

	if (positionalIsSelf) self = true
	else if (positional) {
		if (self || extensions) return "positional update targets cannot be combined with --self or --extensions"
		packageSource = positional
	}

	const packageTarget = Boolean(packageSource || extensions)
	if (version && packageTarget) return "a version can only be used when updating Kimchi itself"
	if ((flags.canary || flags.dryRun) && packageTarget) {
		return "--canary and --dry-run can only be used when updating Kimchi itself"
	}
	if (version && flags.canary) return "a version cannot be combined with --canary"

	const target: UpdateFlags["target"] =
		flags.canary || flags.dryRun || version || (self && !extensions)
			? "self"
			: packageTarget && !self
				? "packages"
				: "all"
	return { ...flags, target, packageSource, version }
}

/** Release tags always carry a leading "v"; accept "1.2.3" as shorthand for "v1.2.3". */
function normalizeVersionTag(version: string | undefined): string | undefined {
	if (!version) return version
	return /^\d/.test(version) ? `v${version}` : version
}

function findUnsupportedUpdateFlag(args: string[]): string | undefined {
	for (const arg of args) {
		if (!arg.startsWith("-")) continue
		const flag = arg.startsWith("--") ? arg.slice(0, arg.indexOf("=") === -1 ? undefined : arg.indexOf("=")) : arg
		if (!UPDATE_FLAGS.has(flag)) return flag
	}
}

function readUpdateBooleanFlag(
	unknownFlags: Map<string, boolean | string>,
	name: (typeof UPDATE_BOOLEAN_FLAGS)[number],
	messages: string[],
	args: string[],
): boolean | string {
	const value = unknownFlags.get(name)
	if (value === undefined) return false
	const flag = `--${name}`
	if (typeof value !== "string") return true
	if (args.some((arg) => arg.startsWith(`${flag}=`))) return `${flag} does not take a value`
	messages.push(value)
	return true
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

async function updateSelf(flags: Pick<UpdateFlags, "canary" | "dryRun" | "force" | "version">): Promise<number> {
	// Homebrew manages its own package lifecycle. Self-patching a Homebrew
	// binary would bypass its shim layer, break the Cellar layout, and risk
	// losing the installation on the next `brew cleanup`. Direct the user to
	// the correct upgrade path instead.
	if (isHomebrewInstall()) {
		if (flags.canary || flags.version) {
			const what = flags.version
				? "Specific release versions cannot be installed through Homebrew."
				: "Canary builds are not published to Homebrew."
			const rerun = flags.version ? `kimchi update ${flags.version}` : "kimchi update --canary"
			console.log(`kimchi is managed by Homebrew. ${what}`)
			console.log("")
			console.log("Uninstall the Homebrew package and reinstall directly:")
			console.log("")
			console.log("  brew uninstall kimchi")
			console.log("  curl -fsSL https://github.com/getkimchi/kimchi/releases/latest/download/install.sh | bash")
			console.log("")
			console.log(`Then re-run: ${rerun}`)
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
		check = await checkForUpdate({ currentVersion: current, skipCache: true, canary: flags.canary, tag: flags.version })
	} catch (err) {
		console.error(`kimchi update: failed to check for updates: ${(err as Error).message}`)
		return 1
	}

	// An explicitly requested version may be a downgrade or a reinstall, so
	// "update available" phrasing would be misleading — say what will happen.
	if (!check.hasUpdate) {
		if (flags.version) console.log(`kimchi: already on ${check.latestVersion}`)
		else console.log(`kimchi: already up to date (${current})`)
		return 0
	}
	if (flags.dryRun) {
		if (flags.version) console.log(`kimchi: would install ${check.latestVersion} (currently ${current})`)
		else console.log(`kimchi update available: ${current} → ${check.latestVersion}`)
		if (check.releaseUrl) console.log(`  ${check.releaseUrl}`)
		return 0
	}

	if (!flags.force) {
		// Bare confirmation — read a single line from stdin. Default is "yes"
		// on bare Enter. We deliberately don't pull in @clack/prompts here
		// because the harness's normal flow may be non-interactive (CI
		// pipelines run `kimchi update --force`).
		const prompt = flags.version
			? `Install ${check.latestVersion} (currently ${current})? [Y/n]: `
			: `Kimchi update available: ${current} → ${check.latestVersion}\nUpdate? [Y/n]: `
		const ok = await confirm(prompt)
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
