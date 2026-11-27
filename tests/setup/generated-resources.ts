import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import type { TestProject } from "vitest/node"

const script = fileURLToPath(new URL("../../scripts/copy-resources.js", import.meta.url))

function generate(): void {
	// Bun's bundle summaries go to stdout; errors stay visible on stderr.
	execFileSync(process.execPath, [script, "--dev"], { stdio: ["ignore", "ignore", "inherit"] })
}

/**
 * Regenerate what postinstall generates (`scripts/copy-resources.js --dev`)
 * before the run and before each watch-mode rerun. Tests read some of it, such
 * as pdfium.wasm and the bundled validate-skill.mjs. A checkout that shares
 * another checkout's node_modules (a git worktree, Ferment V2's baseline
 * worktree) never ran postinstall, and after a source edit the bundle still
 * holds the code of the last install, so the tests would fail or check stale code.
 */
export default function setup(project: TestProject): void {
	generate()
	project.onTestsRerun(() => {
		// A source saved mid-edit can fail to bundle: report it and keep watching (the error ended the session).
		try {
			generate()
		} catch (error) {
			console.error(`${(error as Error).message}\nThis rerun uses the resources of the last successful generation.`)
		}
	})
}
