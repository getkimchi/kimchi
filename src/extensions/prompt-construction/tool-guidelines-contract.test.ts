/**
 * Contract test keeping pi's per-tool guidelines OUT of kimchi's system
 * prompt. Kimchi curates the `## Tool Guidelines` section to kimchi-authored
 * guidance (see PI_GUIDELINE_TOOL_NAMES in system-prompt.ts): every
 * pi-authored bullet was reviewed and rejected — duplicated by kimchi's own
 * prompt or the tool descriptions, or contradicting the implementation
 * (bash's PI_* env claim: kimchi's background bash never injects them). The
 * codemode steering lives in the Tool Selection line, which folds in pi's
 * Promise.allSettled idiom.
 *
 * This builds the prompt from pi's REAL tool definitions (read/bash/edit/
 * write/grep/find/ls + the codemode extension registration), so it fails if:
 *   - the exclusion set stops filtering and a pi bullet leaks into the prompt,
 *   - pi renames the property so the flow this test exercises changes shape,
 *   - a new pi factory needs adding here (review its guidelines then).
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

/** Every guideline pi registers for the default tool set, verbatim. */
const PI_GUIDELINE_BULLETS = [
	"Use read to examine files instead of cat or sed.",
	"You can inspect PI_* environment variables for current model and session details.",
	"Use edit for precise changes (edits[].oldText must match exactly)",
	"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
	"Use write only for new files or complete rewrites.",
	"Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of many separate calls.",
]

describe("tool guidelines contract (pi guidelines stay curated out)", () => {
	it("renders no pi-authored guideline; codemode steering comes from Tool Selection", () => {
		// Real pi definitions, not mocks: the assertions must hold against
		// whatever the pinned pi actually registers today.
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

		for (const bullet of PI_GUIDELINE_BULLETS) {
			expect(prompt).not.toContain(bullet)
		}
		// The default pi tool set carries no kimchi-authored guidelines, so the
		// section must be absent entirely.
		expect(prompt).not.toContain("## Tool Guidelines")
		// The steering lives here, with pi's idiom folded in:
		expect(prompt).toContain("Prefer `codemode` when later tool arguments can be computed from an earlier result")
		expect(prompt).toContain("when independent calls need their full results; issue those calls together")
	})
})
