import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { validateAuxiliaryFiles } from "./validator.js"

function readPackageVersion(dir: string): string | undefined {
	try {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as { version?: unknown }
		return typeof pkg.version === "string" && pkg.version !== "" ? pkg.version : undefined
	} catch {
		return undefined
	}
}

/**
 * Version guard for the inherited-PI_PACKAGE_DIR escape hatch. A layout-valid
 * but stale inherited package dir (e.g. a 0.85-era user install exported into
 * the environment by a parent pi/kimchi process) would otherwise shadow the
 * binary-adjacent share dir and keep copying outdated assets — themes with
 * oscFg/oscBg in `colors`, which pi 1.3's strict theme validator then rejects
 * with "Failed to load theme → Fell back to the system theme". When the two
 * package versions differ, the share dir sibling to the running binary wins,
 * because it always matches the binary's own resource version. Falls back to
 * `primary` whenever the comparison can't be made.
 */
export function pickPackageDirForBinary(primary: string, siblingShare: string): string {
	if (primary === siblingShare) return primary
	const primaryVersion = readPackageVersion(primary)
	const siblingVersion = readPackageVersion(siblingShare)
	if (primaryVersion === undefined || siblingVersion === undefined) return primary
	return primaryVersion === siblingVersion ? primary : siblingShare
}

export function resolveAuxiliaryFilesDir(
	env: Record<string, string | undefined>,
	homeDir: string,
	execPath?: string,
): string {
	if (env.PI_PACKAGE_DIR) {
		return env.PI_PACKAGE_DIR
	}

	// When running as a compiled binary (dist/bin/kimchi), share files
	// live at ../share/kimchi relative to the binary.
	if (execPath) {
		const siblingShare = join(execPath, "..", "..", "share", "kimchi")
		if (existsSync(join(siblingShare, "package.json"))) {
			return siblingShare
		}
	}

	if (env.XDG_DATA_HOME) {
		return join(env.XDG_DATA_HOME, "kimchi")
	}

	return join(homeDir, ".local", "share", "kimchi")
}

/**
 * Like resolveAuxiliaryFilesDir, but validates the result and recovers from an
 * inherited PI_PACKAGE_DIR that lacks the aux layout — e.g. launching kimchi
 * from inside another pi/kimchi session, which exports its own package dir
 * pointing at a source checkout ("themes/" vs "theme/"). When the inherited
 * dir is invalid but the binary-adjacent share dir is valid, returns the
 * latter. An explicit-but-invalid setting with no valid sibling is returned as-is
 * so its own failure surfaces downstream, matching the pre-recovery behavior.
 */
export function resolveValidatedAuxiliaryFilesDir(
	env: Record<string, string | undefined>,
	homeDir: string,
	execPath?: string,
): string {
	const primary = resolveAuxiliaryFilesDir(env, homeDir, execPath)
	try {
		validateAuxiliaryFiles(primary)
		return primary
	} catch (err) {
		if (!env.PI_PACKAGE_DIR) throw err
	}
	const { PI_PACKAGE_DIR: _ignored, ...envWithoutPackageDir } = env
	// Try the normal candidates in order — a stale sibling share dir must not
	// shadow a valid installed data dir (e.g. a 0.85.1-era install).
	for (const candidate of [
		resolveAuxiliaryFilesDir(envWithoutPackageDir, homeDir, execPath),
		join(homeDir, ".local", "share", "kimchi"),
	]) {
		if (candidate === primary) continue
		try {
			validateAuxiliaryFiles(candidate)
			return candidate
		} catch {
			// invalid too — try the next one
		}
	}
	return primary
}
