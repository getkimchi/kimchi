import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { namesWithNativeGrant } from "./native-migration-notices.js"

describe("namesWithNativeGrant", () => {
	it("matches servers by mcp__<name>| key prefix, across dash/underscore spellings", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "native-grants-"))
		writeFileSync(
			join(agentDir, "mcp-auth.json"),
			JSON.stringify({
				"mcp__krep_dev|https://mcp.krep-dev.castai.co/mcp": { serverUrl: "https://mcp.krep-dev.castai.co/mcp" },
				"mcp__posthog|https://mcp.posthog.com/mcp": { serverUrl: "https://mcp.posthog.com/mcp" },
				"https://legacy.example.com/mcp": { serverUrl: "https://legacy.example.com/mcp" },
			}),
		)
		expect(namesWithNativeGrant(agentDir, ["krep-dev", "posthog", "atlassian"])).toEqual(
			new Set(["krep-dev", "posthog"]),
		)
	})

	it("returns an empty set when the store is missing, unreadable, or not an object", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "native-grants-empty-"))
		expect(namesWithNativeGrant(agentDir, ["srv"])).toEqual(new Set())
		writeFileSync(join(agentDir, "mcp-auth.json"), "not json")
		expect(namesWithNativeGrant(agentDir, ["srv"])).toEqual(new Set())
		writeFileSync(join(agentDir, "mcp-auth.json"), "[]")
		expect(namesWithNativeGrant(agentDir, ["srv"])).toEqual(new Set())
	})
})
