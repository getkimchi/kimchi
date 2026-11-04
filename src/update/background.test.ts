// Tests for the background update tick — one run of the periodic check
// (docs/auto-update.md). The seam is runUpdateTick with injected collaborators;
// outcomes are observable in the returned TickResult and the injected store.

import { describe, expect, it, vi } from "vitest"
import type { TickStore } from "./background.js"
import type { CheckResult } from "./workflow.js"

const { runUpdateTick } = await import("./background.js")

function noUpdate(): CheckResult {
	return {
		currentVersion: "1.0.0",
		latestVersion: "1.0.0",
		tag: "v1.0.0",
		releaseUrl: "",
		hasUpdate: false,
		cached: false,
	}
}

function hasUpdate(tag = "v2.0.0"): CheckResult {
	return { ...noUpdate(), latestVersion: tag, tag, hasUpdate: true }
}

function makeLock() {
	return { release: vi.fn() }
}

function makeStore(lastInstalledTag: string | null = null, installedVersion: string | null = null) {
	const calls: string[] = []
	const store: TickStore = {
		saveUpdateResult: vi.fn(() => {
			calls.push("saveUpdateResult")
		}),
		saveLastInstalled: vi.fn(() => {
			calls.push("saveLastInstalled")
		}),
		loadLastInstalled: () => (lastInstalledTag === null ? null : { tag: lastInstalledTag }),
		loadInstalledVersion: () => installedVersion,
	}
	return { store, calls }
}

describe("runUpdateTick", () => {
	it("skips without checking — and without persisting — when the updater lock is unavailable", async () => {
		const check = vi.fn()
		const apply = vi.fn()
		const { store } = makeStore()
		const result = await runUpdateTick({
			currentVersion: "1.0.0",
			acquireLock: () => null,
			checkForUpdate: check,
			applyUpdate: apply,
			store,
		})
		expect(result.outcome).toBe("skipped-lock")
		expect(check).not.toHaveBeenCalled()
		expect(apply).not.toHaveBeenCalled()
		// Not persisted: a skipped-lock write without the lock could clobber
		// the winner's concurrently-recorded outcome, and the winner persists
		// the meaningful record anyway.
		expect(store.saveUpdateResult).not.toHaveBeenCalled()
	})

	it("reports no-update when the remote is not newer", async () => {
		const lock = makeLock()
		const apply = vi.fn()
		const { store } = makeStore()
		const result = await runUpdateTick({
			currentVersion: "1.0.0",
			acquireLock: () => lock,
			checkForUpdate: async () => noUpdate(),
			applyUpdate: apply,
			store,
		})
		expect(result).toEqual({ outcome: "no-update" })
		expect(apply).not.toHaveBeenCalled()
		expect(lock.release).toHaveBeenCalledOnce()
	})

	it("does not reinstall a release already installed by another session", async () => {
		const lock = makeLock()
		const apply = vi.fn()
		const { store } = makeStore("v2.0.0")
		const result = await runUpdateTick({
			currentVersion: "1.0.0",
			acquireLock: () => lock,
			checkForUpdate: async () => hasUpdate("v2.0.0"),
			applyUpdate: apply,
			store,
		})
		expect(result).toEqual({ outcome: "no-update" })
		expect(apply).not.toHaveBeenCalled()
	})

	it("does not reinstall when the record and the installed files agree", async () => {
		const apply = vi.fn()
		const { store } = makeStore("v2.0.0", "2.0.0")
		const result = await runUpdateTick({
			currentVersion: "1.0.0",
			acquireLock: () => makeLock(),
			checkForUpdate: async () => hasUpdate("v2.0.0"),
			applyUpdate: apply,
			store,
		})
		expect(result).toEqual({ outcome: "no-update" })
		expect(apply).not.toHaveBeenCalled()
	})

	it("installs when the record is stale because the files on disk are an older version", async () => {
		// v2.0.0 was recorded, then install.sh put 1.5.0 back. The record alone
		// would block v2.0.0 until a newer release shipped.
		const apply = vi.fn().mockResolvedValue(undefined)
		const { store } = makeStore("v2.0.0", "1.5.0")
		const result = await runUpdateTick({
			currentVersion: "1.5.0",
			acquireLock: () => makeLock(),
			checkForUpdate: async () => hasUpdate("v2.0.0"),
			applyUpdate: apply,
			store,
		})
		expect(result).toEqual({ outcome: "installed", version: "v2.0.0" })
		expect(apply).toHaveBeenCalledOnce()
	})

	it("never overwrites a canary the user installed while this stable session stayed open", async () => {
		const apply = vi.fn()
		const { store } = makeStore("canary", "0.0.0-canary.20260601.def5678")
		const result = await runUpdateTick({
			currentVersion: "1.0.0",
			acquireLock: () => makeLock(),
			checkForUpdate: async () => hasUpdate("v2.0.0"),
			applyUpdate: apply,
			store,
		})
		expect(result).toEqual({ outcome: "no-update" })
		expect(apply).not.toHaveBeenCalled()
	})

	it("dedups and records by release tag, not the display version", async () => {
		// latestVersion is display text (e.g. a canary title); tag is what
		// applyUpdate downloads and what the manual paths record. Mixing the
		// two would break the dedup on channels where they differ.
		const lock = makeLock()
		const apply = vi.fn()
		const { store } = makeStore("canary")
		const check = { ...noUpdate(), hasUpdate: true, latestVersion: "0.0.0-canary.20260601.def5678", tag: "canary" }
		const result = await runUpdateTick({
			currentVersion: "1.0.0",
			acquireLock: () => lock,
			checkForUpdate: async () => check,
			applyUpdate: apply,
			store,
		})
		expect(result).toEqual({ outcome: "no-update" })
		expect(apply).not.toHaveBeenCalled()

		const { store: store2 } = makeStore()
		const applied = await runUpdateTick({
			currentVersion: "1.0.0",
			acquireLock: () => makeLock(),
			checkForUpdate: async () => check,
			applyUpdate: async () => undefined,
			store: store2,
		})
		expect(applied.outcome).toBe("installed")
		expect(store2.saveLastInstalled).toHaveBeenCalledWith("canary")
	})

	it("installs and records the applied version when the tag is new", async () => {
		const lock = makeLock()
		const apply = vi.fn().mockResolvedValue(undefined)
		const { store, calls } = makeStore()
		const result = await runUpdateTick({
			currentVersion: "1.0.0",
			acquireLock: () => lock,
			checkForUpdate: async () => hasUpdate("v2.0.0"),
			applyUpdate: apply,
			store,
		})
		expect(result).toEqual({ outcome: "installed", version: "v2.0.0" })
		expect(apply).toHaveBeenCalledOnce()
		expect(store.saveLastInstalled).toHaveBeenCalledWith("v2.0.0")
		// both persistence writes land while the lock is still held
		expect(calls).toEqual(["saveUpdateResult", "saveLastInstalled"])
		expect(lock.release).toHaveBeenCalledOnce()
	})

	it("reports check-failed and releases the lock when the check throws", async () => {
		const lock = makeLock()
		const apply = vi.fn()
		const { store } = makeStore()
		const result = await runUpdateTick({
			currentVersion: "1.0.0",
			acquireLock: () => lock,
			checkForUpdate: async () => {
				throw new Error("network down")
			},
			applyUpdate: apply,
			store,
		})
		expect(result.outcome).toBe("check-failed")
		expect(result.error).toBe("network down")
		expect(apply).not.toHaveBeenCalled()
		expect(lock.release).toHaveBeenCalledOnce()
	})

	it("reports install-failed and releases the lock when the install throws", async () => {
		const lock = makeLock()
		const { store } = makeStore()
		const result = await runUpdateTick({
			currentVersion: "1.0.0",
			acquireLock: () => lock,
			checkForUpdate: async () => hasUpdate(),
			applyUpdate: async () => {
				throw new Error("checksum mismatch")
			},
			store,
		})
		expect(result).toEqual({ outcome: "install-failed", version: "v2.0.0", error: "checksum mismatch" })
		expect(lock.release).toHaveBeenCalledOnce()
	})

	it("normalizes non-Error throws to a message", async () => {
		const { store } = makeStore()
		const result = await runUpdateTick({
			currentVersion: "1.0.0",
			acquireLock: () => makeLock(),
			// A rejected non-Error exercises the normalization path without a
			// `throw` statement (biome useThrowOnlyError stays happy).
			checkForUpdate: () => Promise.reject<CheckResult>("string failure"),
			applyUpdate: async () => undefined,
			store,
		})
		expect(result).toEqual({ outcome: "check-failed", error: "string failure" })
	})

	it("truncates long error messages (telemetry/result-file privacy convention)", async () => {
		const { store } = makeStore()
		const result = await runUpdateTick({
			currentVersion: "1.0.0",
			acquireLock: () => makeLock(),
			checkForUpdate: async () => {
				throw new Error("x".repeat(500))
			},
			applyUpdate: async () => undefined,
			store,
		})
		expect(result.error?.length).toBe(300)
	})
})
