import { expect, it } from "vitest"
import { systemPromptOf, toolDescriptionOf } from "../tui/support/wire-requests.js"
import { PROMPT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"

it.each([true, false])(
	"includes codemode guidance in the ACP prompt only when enabled (enabled=%s)",
	async (enabled) => {
		const fixture = await startAcpFixture({
			artifactName: `codemode-guidelines-${enabled}`,
			responses: [{ stream: ["Acknowledged."] }],
			settings: enabled ? {} : { defaultTools: ["-codemode"] },
		})
		try {
			const session = await fixture.conn.newSession({ cwd: fixture.workDir, mcpServers: [] })
			const result = await fixture.conn.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "Hello." }],
			})
			expect(result.stopReason).toBe("end_turn")
			const request = fixture.fake.requests.find((request) => request.url.includes("chat/completions"))
			expect(request).toBeDefined()
			if (!request) throw new Error("No model request recorded")
			const prompt = systemPromptOf(request)
			const codemodeDescription = toolDescriptionOf(request, "codemode")
			if (enabled) {
				// Exactly once: pi's built-in codemode is replaced, not stacked.
				expect(codemodeDescription?.split("Use to filter large output before it reaches the model")).toHaveLength(2)
				expect(codemodeDescription).not.toContain("const hits")
				expect(codemodeDescription).toContain("Run JavaScript that calls other tools")
			} else {
				expect(codemodeDescription).toBeUndefined()
			}
			expect(prompt.includes("Use `codemode` when intermediate output can be filtered before it reaches you")).toBe(
				enabled,
			)
			// Pi's own per-tool guidelines are curated out of the prompt: they
			// duplicate kimchi's guidance or the tool descriptions, or contradict
			// the implementation (bash's PI_* env claim). True regardless of the
			// codemode toggle — the exclusion is by authorship, not availability.
			expect(prompt).not.toContain("Use read to examine files instead of cat or sed.")
			expect(prompt).not.toContain("Use codemode to batch independent tool calls (Promise.allSettled),")
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS + PROMPT_TIMEOUT_MS,
)
