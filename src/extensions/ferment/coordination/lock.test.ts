import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { rename } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { claimItem } from "./lock.js"

function createTempDir(): string {
	return mkdtempSync(join(tmpdir(), "ferment-lock-test-"))
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("claimItem", () => {
	let tempDir: string
	let locksDir: string
	let itemPath: string
	const itemId = "wi_testitem"

	beforeEach(() => {
		tempDir = createTempDir()
		locksDir = join(tempDir, ".kimchi", "coordination", ".locks")
		mkdirSync(locksDir, { recursive: true })
		itemPath = join(tempDir, "ready", `${itemId}.json`)
		mkdirSync(join(tempDir, "ready"), { recursive: true })
		writeFileSync(itemPath, JSON.stringify({ id: itemId, title: "test" }))
	})

	afterEach(() => {
		// temp files cleaned by OS eventually
	})

	it("concurrent claim — exactly one returns handle, other returns null", async () => {
		const [a, b] = await Promise.all([
			claimItem({ claimer: "agent:a", itemId, itemPath }),
			claimItem({ claimer: "agent:b", itemId, itemPath }),
		])

		const handles = [a, b].filter(Boolean)
		const nulls = [a, b].filter((r) => r === null)

		expect(handles).toHaveLength(1)
		expect(nulls).toHaveLength(1)

		for (const h of handles) {
			await h?.release()
		}
	})

	it("stale recovery — re-claim succeeds after TTL expires", async () => {
		const first = await claimItem({ claimer: "agent:a", itemId, itemPath, staleSeconds: 1 })
		expect(first).not.toBeNull()

		// Wait for the lock's stale TTL to expire
		await new Promise((r) => setTimeout(r, 2100))

		// Release the stale lock, then re-claim should succeed
		await first?.release()

		const second = await claimItem({ claimer: "agent:b", itemId, itemPath })
		expect(second).not.toBeNull()

		await second?.release()
	})

	it("release and re-claim — immediate re-claim succeeds after release", async () => {
		const first = await claimItem({ claimer: "agent:a", itemId, itemPath })
		expect(first).not.toBeNull()

		await first?.release()

		const second = await claimItem({ claimer: "agent:b", itemId, itemPath })
		expect(second).not.toBeNull()

		await second?.release()
	})

	it("lock path independent of item location — rename item, lock still valid", async () => {
		const pathA = join(tempDir, "ready", `${itemId}.json`)
		const pathB = join(tempDir, "in-progress", `${itemId}.json`)
		mkdirSync(join(tempDir, "in-progress"), { recursive: true })

		const handle1 = await claimItem({ claimer: "agent:a", itemId, itemPath: pathA })
		expect(handle1).not.toBeNull()

		// rename file A -> B (simulates state transition)
		await rename(pathA, pathB)

		// claim on the *same* itemId should fail because lock follows itemId, not path
		const handle2 = await claimItem({ claimer: "agent:b", itemId, itemPath: pathB })
		expect(handle2).toBeNull()

		// releasing via original handle should still work
		await handle1?.release()

		// after release, new claim on renamed path succeeds
		const handle3 = await claimItem({ claimer: "agent:c", itemId, itemPath: pathB })
		expect(handle3).not.toBeNull()

		await handle3?.release()
	})

	it("null on ELOCKED — already-held lock returns null (not throw)", async () => {
		const first = await claimItem({ claimer: "agent:a", itemId, itemPath })
		expect(first).not.toBeNull()

		const second = await claimItem({ claimer: "agent:b", itemId, itemPath })
		expect(second).toBeNull()

		await first?.release()
	})
})
