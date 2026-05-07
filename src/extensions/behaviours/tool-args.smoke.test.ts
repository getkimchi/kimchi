/**
 * Smoke test asserting that `BUILTIN_TOOL_NAMES` matches the names produced
 * by pi-coding-agent's per-tool factories. If upstream renames a built-in
 * tool (e.g. `"bash"` → `"shell"`), this test fails so the local `ToolArgs`
 * map can be updated before behaviour matchers silently break.
 */

import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@mariozechner/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { BUILTIN_TOOL_NAMES } from "./tool-args.js"

describe("BUILTIN_TOOL_NAMES", () => {
	it("matches pi-coding-agent's built-in tool names exactly", () => {
		const cwd = "/tmp"
		const upstream = new Set([
			createBashToolDefinition(cwd).name,
			createReadToolDefinition(cwd).name,
			createEditToolDefinition(cwd).name,
			createWriteToolDefinition(cwd).name,
			createGrepToolDefinition(cwd).name,
			createFindToolDefinition(cwd).name,
			createLsToolDefinition(cwd).name,
		])
		expect(new Set(BUILTIN_TOOL_NAMES)).toEqual(upstream)
	})
})
