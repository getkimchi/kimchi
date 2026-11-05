/**
 * Contract test pinning the `## Tool Guidelines` content inherited from the
 * pinned pi. Kimchi renders pi's per-tool `promptGuidelines` verbatim (see
 * formatToolGuidelinesSection in system-prompt.ts), so a pi upgrade can
 * silently rewrite kimchi's system prompt with no kimchi-side diff to review.
 * This snapshot fails in the pi-upgrade PR instead, forcing a conscious
 * accept-or-adjust decision — the same drift-gate pattern as the codemode
 * worker entrypoint contract in src/extensions/codemode/worker-entrypoint.test.ts.
 *
 * When this fails after a pi bump: review the new guideline text (run with -u
 * to regenerate), decide whether it conflicts with kimchi's own guidance, and
 * commit the snapshot update as part of the upgrade PR so reviewers see the
 * prompt change. New pi builtins that register guidelines need their factory
 * added below (powershell is Windows-only; tool_search registers none today).
 */
import {
	createBashToolDefinition,
	createCodemodeExtension,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { buildSystemPrompt, type EnvironmentInfo } from "./system-prompt.js"

const testEnv: EnvironmentInfo = {
	os: "Linux",
	rawPlatform: "linux",
	cpuArchitecture: "x64",
	shell: "/bin/bash",
	osVersion: "#1 SMP PREEMPT_DYNAMIC Test",
	username: "testuser",
	homeDir: "/home/testuser",
	cwd: "/home/testuser/projects/myapp",
	documentsDir: "/home/testuser/projects/myapp/.kimchi/docs",
	localDate: "2026-01-01",
	isGitRepo: false,
}

/** The `## Tool Guidelines` section of a built prompt, or "" when absent. */
function toolGuidelinesSection(prompt: string): string {
	const start = prompt.indexOf("## Tool Guidelines")
	if (start === -1) return ""
	const end = prompt.indexOf("\n## ", start + 1)
	return prompt.slice(start, end === -1 ? undefined : end).trimEnd()
}

describe("tool guidelines contract (pi-upgrade drift gate)", () => {
	it("renders exactly the guidelines the pinned pi registers for the default tool set", () => {
		// Real pi definitions, not mocks: the snapshot must move when pi moves.
		const mock = createExtensionApi()
		createCodemodeExtension()(mock.api)
		const codemode = mock.getRegisteredTools().find((tool) => tool.name === "codemode")
		if (!codemode) throw new Error("createCodemodeExtension did not register the codemode tool")

		const prompt = buildSystemPrompt({
			tools: [
				createReadToolDefinition(testEnv.cwd),
				createBashToolDefinition(testEnv.cwd),
				createEditToolDefinition(testEnv.cwd),
				createWriteToolDefinition(testEnv.cwd),
				createGrepToolDefinition(testEnv.cwd),
				createFindToolDefinition(testEnv.cwd),
				createLsToolDefinition(testEnv.cwd),
				codemode,
			],
			env: testEnv,
			mode: "single",
		})

		// The section must exist: an absent section means the flow from pi's
		// ToolInfo.promptGuidelines through formatToolGuidelinesSection broke
		// (e.g. pi renamed the property), not just wording drift.
		expect(prompt).toContain("## Tool Guidelines")
		expect(toolGuidelinesSection(prompt)).toMatchInlineSnapshot(`
			"## Tool Guidelines

			- Use read to examine files instead of cat or sed.
			- You can inspect PI_* environment variables for current model and session details.
			- Use edit for precise changes (edits[].oldText must match exactly)
			- When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls
			- Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.
			- Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.
			- Use write only for new files or complete rewrites.
			- Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of many separate calls."
		`)
	})
})
