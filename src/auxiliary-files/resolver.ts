import { existsSync } from "node:fs"
import { join } from "node:path"
import { validateAuxiliaryFiles } from "./validator.js"

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
