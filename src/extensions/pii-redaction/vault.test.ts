import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import {
	createTokenVault,
	deepStrings,
	installVaultLifecycle,
	resetTokenVaults,
	seedTokenCountersFromTexts,
	substituteTokens,
	tokenFor,
	vaultForPaint,
	vaultForSession,
} from "./vault.js"

// Counters are process-global (see vault.ts header): every test resets
// the allocator plus the lifecycle map so token numbers are deterministic.
beforeEach(() => {
	resetTokenVaults()
})

describe("tokenFor", () => {
	it("is value-stable: same value gets the same token", () => {
		const vault = createTokenVault()
		const first = tokenFor(vault, "EMAIL_ADDRESS", "jane.doe@acme.com")
		expect(first).toBe("[EMAIL_ADDRESS_1]")
		expect(tokenFor(vault, "EMAIL_ADDRESS", "jane.doe@acme.com")).toBe(first)
	})

	it("allocates sequentially per entity type", () => {
		const vault = createTokenVault()
		expect(tokenFor(vault, "EMAIL_ADDRESS", "a@acme.com")).toBe("[EMAIL_ADDRESS_1]")
		expect(tokenFor(vault, "EMAIL_ADDRESS", "b@acme.com")).toBe("[EMAIL_ADDRESS_2]")
		expect(tokenFor(vault, "IP_ADDRESS", "84.17.46.1")).toBe("[IP_ADDRESS_1]")
	})

	it("keeps counters independent across entity types", () => {
		const vault = createTokenVault()
		tokenFor(vault, "EMAIL_ADDRESS", "a@acme.com")
		tokenFor(vault, "EMAIL_ADDRESS", "b@acme.com")
		expect(tokenFor(vault, "IP_ADDRESS", "84.17.46.1")).toBe("[IP_ADDRESS_1]")
		expect(tokenFor(vault, "EMAIL_ADDRESS", "c@acme.com")).toBe("[EMAIL_ADDRESS_3]")
	})

	it("cannot collide entity/value concatenations (U+0001 separator)", () => {
		const vault = createTokenVault()
		const left = tokenFor(vault, "A", "BC")
		const right = tokenFor(vault, "AB", "C")
		expect(left).not.toBe(right)
		expect(substituteTokens(vault, `${left} ${right}`)).toBe("BC C")
	})
})

describe("substituteTokens", () => {
	it("replaces every vault-known token with its original", () => {
		const vault = createTokenVault()
		const email = tokenFor(vault, "EMAIL_ADDRESS", "jane.doe@acme.com")
		const ip = tokenFor(vault, "IP_ADDRESS", "84.17.46.1")
		expect(substituteTokens(vault, `mail ${email}; host ${ip}. done`)).toBe(
			"mail jane.doe@acme.com; host 84.17.46.1. done",
		)
	})

	it("replaces a token at text boundaries and adjacent to punctuation", () => {
		const vault = createTokenVault()
		const t = tokenFor(vault, "EMAIL_ADDRESS", "jane.doe@acme.com")
		expect(substituteTokens(vault, `${t}(${t}),`)).toBe("jane.doe@acme.com(jane.doe@acme.com),")
	})

	it("passes unknown tokens through verbatim — restart degradation is display-only", () => {
		const vault = createTokenVault()
		tokenFor(vault, "EMAIL_ADDRESS", "jane.doe@acme.com")
		// [EMAIL_ADDRESS_99] was never allocated: a confabulated or vaulted-out
		// token must render as-is, never crash, never invent a value.
		expect(substituteTokens(vault, "contact [EMAIL_ADDRESS_99]")).toBe("contact [EMAIL_ADDRESS_99]")
	})

	it("never touches [REDACTED-…] markers", () => {
		const vault = createTokenVault()
		tokenFor(vault, "EMAIL_ADDRESS", "jane.doe@acme.com")
		expect(substituteTokens(vault, "marker [REDACTED-EMAIL_ADDRESS] stays")).toBe(
			"marker [REDACTED-EMAIL_ADDRESS] stays",
		)
	})

	it("leaves a token split at the text tail intact (next paint completes it)", () => {
		const vault = createTokenVault()
		tokenFor(vault, "EMAIL_ADDRESS", "jane.doe@acme.com")
		expect(substituteTokens(vault, "see [EMAIL_ADDRESS_1")).toBe("see [EMAIL_ADDRESS_1")
	})

	it("fast-paths text without brackets", () => {
		const vault = createTokenVault()
		expect(substituteTokens(vault, "no tokens here")).toBe("no tokens here")
	})

	it("does not substitute across vaults (per-session isolation)", () => {
		const a = createTokenVault()
		const b = createTokenVault()
		const token = tokenFor(a, "EMAIL_ADDRESS", "jane.doe@acme.com")
		expect(substituteTokens(b, `x ${token}`)).toBe(`x ${token}`)
	})
})

describe("session lifecycle", () => {
	const ctxFor = (sessionId: string) => createContext({ sessionManager: { getSessionId: () => sessionId } })

	const startShutdownPair = (enabled: () => boolean) => {
		const { api, getHandler } = createExtensionApi()
		installVaultLifecycle(api, enabled)
		return { start: getHandler("session_start"), shutdown: getHandler("session_shutdown") }
	}

	it("creates a vault on session_start when enabled", async () => {
		const { start } = startShutdownPair(() => true)
		await start({}, ctxFor("s1"))
		expect(vaultForSession("s1")).toBeDefined()
		expect(vaultForPaint()).toBe(vaultForSession("s1"))
	})

	it("creates nothing when disabled", async () => {
		const { start } = startShutdownPair(() => false)
		await start({}, ctxFor("s1"))
		expect(vaultForSession("s1")).toBeUndefined()
	})

	it("keeps the same vault on a repeated session_start (tokens must keep resolving)", async () => {
		const { start } = startShutdownPair(() => true)
		await start({}, ctxFor("s1"))
		const first = vaultForSession("s1")
		await start({}, ctxFor("s1"))
		expect(vaultForSession("s1")).toBe(first)
	})

	it("shutdown removes only that session's vault (concurrent sessions)", async () => {
		const { start, shutdown } = startShutdownPair(() => true)
		await start({}, ctxFor("s1"))
		// Interleave at the await point: session 2 starts while session 1 lives.
		await start({}, ctxFor("s2"))
		const vault1 = vaultForSession("s1")
		const vault2 = vaultForSession("s2")
		expect(vault1).toBeDefined()
		expect(vault2).toBeDefined()

		await shutdown({}, ctxFor("s1"))
		expect(vaultForSession("s1")).toBeUndefined()
		// s2's vault survives s1's teardown — no cross-session clearing.
		expect(vaultForSession("s2")).toBe(vault2)
		// The paint pointer was s2's; s1's shutdown must not clear it.
		expect(vaultForPaint()).toBe(vault2)
	})

	it("shutdown clears the paint pointer only when it owns it", async () => {
		const { start, shutdown } = startShutdownPair(() => true)
		await start({}, ctxFor("s1"))
		await start({}, ctxFor("s2")) // paint pointer follows the latest start
		await shutdown({}, ctxFor("s2"))
		expect(vaultForPaint()).toBeUndefined()
		expect(vaultForSession("s1")).toBeDefined()
	})

	it("respawn starts counting fresh (old tokens degrade to verbatim)", async () => {
		const { start, shutdown } = startShutdownPair(() => true)
		await start({}, ctxFor("s1"))
		const oldVault = vaultForSession("s1")
		if (!oldVault) throw new Error("vault missing after start")
		tokenFor(oldVault, "EMAIL_ADDRESS", "jane.doe@acme.com")
		await shutdown({}, ctxFor("s1"))
		await start({}, ctxFor("s1"))
		const newVault = vaultForSession("s1")
		expect(newVault).toBeDefined()
		expect(newVault).not.toBe(oldVault)
		// The old token is unknown to the new vault —verbatim, not wrong data.
		if (!newVault) throw new Error("vault missing after respawn")
		expect(substituteTokens(newVault, "[EMAIL_ADDRESS_1]")).toBe("[EMAIL_ADDRESS_1]")
	})

	it("process-restart with a stored transcript never re-issues a stored token for a different value", async () => {
		// Process 1: vault dies with the process; the session file kept
		// [EMAIL_ADDRESS_2] = jane. Process 2: counters restart at 1, the
		// session restarts over the persisted transcript — the seed scan must
		// push the allocator past 2 before ANY allocation, so the first email
		// in the new run (bob) lands on a fresh token rather than colliding
		// with jane's stored one.
		seedTokenCountersFromTexts([
			"reaching out to [EMAIL_ADDRESS_2] about [IP_ADDRESS_1]",
			"subject: ping [EMAIL_ADDRESS_1]",
		])
		const vault = createTokenVault()
		expect(tokenFor(vault, "EMAIL_ADDRESS", "bob.smith@acme.com")).toBe("[EMAIL_ADDRESS_3]")
		// Old occurrences stay verbatim for the fresh vault (it holds no
		// originals), and nothing allocates over them.
		expect(substituteTokens(vault, "old: [EMAIL_ADDRESS_2]; new: [EMAIL_ADDRESS_3]")).toBe(
			"old: [EMAIL_ADDRESS_2]; new: bob.smith@acme.com",
		)
	})

	it("start seeds counters from persisted session entries (deep text walk)", async () => {
		const { start } = startShutdownPair(() => true)
		const entries = [
			{ message: { role: "assistant", content: [{ type: "text", text: "old reply for [EMAIL_ADDRESS_4]" }] } },
			{ message: { role: "toolResult", content: [{ type: "text", text: "[URL_2]" }] } },
		]
		await start(
			{},
			createContext({
				sessionManager: { getSessionId: () => "s1", getEntries: () => entries as SessionEntry[] },
			}),
		)
		const vault = vaultForSession("s1")
		if (!vault) throw new Error("vault missing after start")
		expect(tokenFor(vault, "EMAIL_ADDRESS", "bob.smith@acme.com")).toBe("[EMAIL_ADDRESS_5]")
		expect(tokenFor(vault, "URL", "https://acme.com")).toBe("[URL_3]")
	})

	it("deepStrings walks objects, arrays and primitives with a depth cap", () => {
		const texts = [...deepStrings({ a: ["x", { b: "y" }, 3, null] })]
		expect(texts).toEqual(["x", "y"])
	})

	it("returns undefined vault for unknown or empty session ids", async () => {
		const { start } = startShutdownPair(() => true)
		await start({}, createContext({ sessionManager: { getSessionId: () => "" } }))
		expect(vaultForSession("")).toBeUndefined()
		expect(vaultForSession(undefined)).toBeUndefined()
	})
})
