/**
 * Vitest global setup — point HOME/USERPROFILE and the XDG homes at a
 * per-file temp dir so no unit test can touch the developer's real home.
 * USERPROFILE is what os.homedir() reads on Windows (HOME is ignored there),
 * so per-test stubs that only set HOME are silent no-ops and test runs used
 * to write config/state into the real profile. The fake home is deleted when
 * the file's suite finishes.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"

const testHome = mkdtempSync(join(tmpdir(), "kimchi-test-home-"))

process.env.HOME = testHome
process.env.USERPROFILE = testHome
// Spec-default XDG locations so hardcoded ~/.config, ~/.local/share and
// ~/.cache fallbacks land in the same isolated places.
process.env.XDG_CONFIG_HOME = join(testHome, ".config")
process.env.XDG_DATA_HOME = join(testHome, ".local", "share")
process.env.XDG_CACHE_HOME = join(testHome, ".cache")

afterAll(() => {
	// Retry through transient Windows EBUSY; a leftover only costs temp space,
	// so warn instead of failing the suite.
	try {
		rmSync(testHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
	} catch (error) {
		console.warn(`[isolated-home] could not remove ${testHome}: ${error instanceof Error ? error.message : error}`)
	}
})
