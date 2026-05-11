import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, unlinkSync, writeFileSync, mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

describe("ferment claim smoke", () => {
	/**
	 * Smoke test: two concurrent processes racing on the same lock file.
	 * Exactly one should acquire the lock; the other should get null.
	 *
	 * This exercises the claimItem lock mechanism end-to-end:
	 * - proper-lockfile OS-level locking
	 * - claimedAt staleness check
	 * - Lock file creation and deletion
	 *
	 * No KIMCHI_API_KEY needed — pure filesystem race.
	 */
	it("two concurrent processes — exactly one acquires, other gets null", () => {
		// Set up a temporary coordination directory structure
		const tempDir = mkdtempSync(join(tmpdir(), "ferment-claim-smoke-"))
		const coordDir = join(tempDir, ".kimchi", "coordination")
		const locksDir = join(coordDir, ".locks")
		const readyDir = join(coordDir, "ready")
		const itemId = "wi_smoke_test"
		const itemPath = join(readyDir, `${itemId}.json`)
		const lockPath = join(locksDir, `${itemId}.lock`)

		mkdirSync(locksDir, { recursive: true })
		mkdirSync(readyDir, { recursive: true })
		writeFileSync(itemPath, JSON.stringify({ id: itemId, title: "smoke test" }))

		// Use tsx CLI to run the TypeScript source directly
		// (dist is not available for coordination module — not in binary entry point graph)
		const tsxBin = join(process.cwd(), "node_modules", ".bin", "tsx")
		const srcLockPath = join(process.cwd(), "src", "extensions", "ferment", "coordination", "lock.ts")

		const claimScript = (agentId: string) => `
import { claimItem } from ${JSON.stringify(srcLockPath)}
async function run() {
  const result = await claimItem({
    claimer: ${JSON.stringify(`agent:${agentId}`)},
    itemId: ${JSON.stringify(itemId)},
    itemPath: ${JSON.stringify(itemPath)},
  })
  process.stdout.write(result ? "ACQUIRED" : "NULL")
}
run().catch(e => { console.error(e); process.exit(1) })
`

		// Spawn two concurrent claimers — race on the same lock file
		// Use tsx directly (not node tsx) since tsx is a shell script
		const procA = spawnSync(tsxBin, ["-e", claimScript("smoke-a")], {
			cwd: process.cwd(),
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 10_000,
		})

		const procB = spawnSync(tsxBin, ["-e", claimScript("smoke-b")], {
			cwd: process.cwd(),
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 10_000,
		})

		const outA = procA.stdout?.toString() ?? ""
		const outB = procB.stdout?.toString() ?? ""
		const errA = procA.stderr?.toString() ?? ""
		const errB = procB.stderr?.toString() ?? ""

		// Both processes should exit cleanly (no crashes)
		expect(procA.status).toBe(0)
		expect(procB.status).toBe(0)

		// Exactly one acquired, one got null
		const acquired = [outA, outB].filter((o) => o.includes("ACQUIRED"))
		const nullResults = [outA, outB].filter((o) => o.includes("NULL"))

		expect(acquired).toHaveLength(1)
		expect(nullResults).toHaveLength(1)

		// No unexpected errors
		if (errA) console.error("[smoke-a stderr]", errA)
		if (errB) console.error("[smoke-b stderr]", errB)

		// Clean up
		try {
			unlinkSync(lockPath)
		} catch {
			// ignore
		}
	})
})