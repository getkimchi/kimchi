// Unit tests for the `_kimchi.dev/set_onboarding_flag` ACP extension method
// handler (kimchi-studio ADR-0043). All writes go through a temp config path so the real
// shared config is never touched.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RequestError } from "@agentclientprotocol/sdk"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { readStudioOnboardingSeenAt } from "../../../config.js"
import { handleSetOnboardingFlag } from "./set-onboarding-flag.js"

/** Runs fn, returns the thrown RequestError, or fails the test if nothing threw. */
function thrownRequestError(fn: () => void): RequestError {
	try {
		fn()
	} catch (error) {
		return error as RequestError
	}
	throw new Error("expected the call to throw a RequestError")
}

describe("handleSetOnboardingFlag", () => {
	let tempDir: string
	let configPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-set-onboarding-flag-test-"))
		configPath = join(tempDir, "config.json")
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("writes onboarding.studioOnboardingSeenAt and returns an empty result", () => {
		expect(handleSetOnboardingFlag({ configPath }, { seenAt: "2026-09-11T10:00:00.000Z" })).toEqual({})
		expect(readStudioOnboardingSeenAt(configPath)).toBe("2026-09-11T10:00:00.000Z")
	})

	it("stamps the current time when seenAt is omitted", () => {
		const before = Date.now() - 1000
		handleSetOnboardingFlag({ configPath })
		const after = Date.now() + 1000

		const seenAt = readStudioOnboardingSeenAt(configPath)
		expect(seenAt).toBeDefined()
		const parsed = Date.parse(seenAt as string)
		expect(parsed).toBeGreaterThanOrEqual(before)
		expect(parsed).toBeLessThanOrEqual(after)
	})

	// The flag must survive a harness restart and be readable by any surface
	// sharing the config — i.e. it is really on disk, not in memory.
	it("persists the value to the config file for later readers", () => {
		handleSetOnboardingFlag({ configPath }, { seenAt: "2026-09-11T10:00:00.000Z" })
		const raw = JSON.parse(readFileSync(configPath, "utf-8")) as { onboarding?: Record<string, unknown> }
		expect(raw.onboarding?.studioOnboardingSeenAt).toBe("2026-09-11T10:00:00.000Z")
	})

	it("preserves sibling onboarding keys and other config fields", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				apiKey: "castai_v1_key",
				onboarding: { sessionModeWizardSeenAt: "2026-05-19T09:30:00.000Z" },
			}),
		)

		handleSetOnboardingFlag({ configPath }, { seenAt: "2026-09-11T10:00:00.000Z" })
		const raw = JSON.parse(readFileSync(configPath, "utf-8"))

		expect(raw).toEqual({
			apiKey: "castai_v1_key",
			onboarding: {
				sessionModeWizardSeenAt: "2026-05-19T09:30:00.000Z",
				studioOnboardingSeenAt: "2026-09-11T10:00:00.000Z",
			},
		})
	})

	it("creates the config file when it does not exist", () => {
		handleSetOnboardingFlag({ configPath }, { seenAt: "2026-09-11T10:00:00.000Z" })
		expect(readStudioOnboardingSeenAt(configPath)).toBe("2026-09-11T10:00:00.000Z")
	})

	it.each([42, null, "", "not-a-date", "September 11, 2026"])("rejects invalid seenAt (%s)", (seenAt) => {
		// Assert the JSON-RPC error code (-32602) explicitly: resolveSeenAt sits
		// outside the write try/catch precisely so invalid params are never
		// re-wrapped as internalError (-32603).
		expect(thrownRequestError(() => handleSetOnboardingFlag({ configPath }, { seenAt })).code).toBe(-32602)
		// A rejected write must not leave a flag behind.
		expect(readStudioOnboardingSeenAt(configPath)).toBeUndefined()
	})

	it("accepts an ISO-8601 timestamp with a numeric offset", () => {
		handleSetOnboardingFlag({ configPath }, { seenAt: "2026-09-11T12:00:00+02:00" })
		expect(readStudioOnboardingSeenAt(configPath)).toBe("2026-09-11T12:00:00+02:00")
	})

	// Filesystem failures must reach Studio as an actionable internal error,
	// not an opaque raw Error (review comment on PR #1182). Deterministic
	// trigger: a file where the config directory should be, so mkdir fails.
	it("wraps filesystem write failures in RequestError.internalError", () => {
		const blockedPath = join(tempDir, "blocker", "config.json")
		writeFileSync(join(tempDir, "blocker"), "not a directory")

		expect(() => handleSetOnboardingFlag({ configPath: blockedPath }, { seenAt: "2026-09-11T10:00:00.000Z" })).toThrow(
			/Failed to persist onboarding flag/,
		)
		// Write failures are internal errors (-32603), distinct from the
		// invalidParams (-32602) rejection for bad seenAt.
		expect(
			thrownRequestError(() =>
				handleSetOnboardingFlag({ configPath: blockedPath }, { seenAt: "2026-09-11T10:00:00.000Z" }),
			).code,
		).toBe(-32603)
	})
})
