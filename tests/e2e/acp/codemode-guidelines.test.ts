import { expect, it } from "vitest"
import { systemPromptOf } from "../tui/support/wire-requests.js"
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
			expect(prompt.includes("Use codemode to batch independent tool calls (Promise.allSettled)")).toBe(enabled)
			expect(prompt.includes("Prefer `codemode` for a predictable multi-step workflow")).toBe(enabled)
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS + PROMPT_TIMEOUT_MS,
)
