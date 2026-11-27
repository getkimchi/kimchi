import { expect, it } from "vitest"
import { UPDATE_FERMENT_V2_TOOL_NAME } from "../../../src/extensions/ferment-v2/constants.js"
import { systemPromptOf, toolDescriptionOf } from "../tui/support/wire-requests.js"
import { PROMPT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"

const SCENARIOS = [
	{
		name: "only-mode",
		// Exercise the nested-tool catalog in only mode, where direct tools'
		// promptGuidelines become part of codemode's own description.
		settings: { codemode: { mode: "only" } },
		expectCodemode: true,
		checkPiLeak: true,
		expectFerment: true,
	},
	{
		name: "excluded",
		settings: { defaultTools: ["-codemode"] },
		expectCodemode: false,
		checkPiLeak: false,
		expectFerment: true,
	},
	{
		// Regression: codemode's default activation used to ride on the legacy
		// ferment's idle-profile snapshot (applied by its before_agent_start in
		// every non-worker session). With that extension disabled, no profile was
		// ever applied, so the tool and the Tool Selection rule conditioned on it
		// silently vanished. Legacy is off by default, so this scenario also turns
		// Ferment (V2) off to cover the state where no Ferment extension loads.
		name: "ferment-all-disabled",
		settings: { resources: { "extensions.ferment": false, "extensions.ferment-legacy": false } },
		expectCodemode: true,
		checkPiLeak: false,
		expectFerment: false,
	},
] as const

it.each(SCENARIOS)(
	"$name: codemode guidance in the ACP prompt (present=$expectCodemode)",
	async ({ name, settings, expectCodemode, checkPiLeak, expectFerment }) => {
		const fixture = await startAcpFixture({
			artifactName: `codemode-guidelines-${name}`,
			responses: [{ stream: ["Acknowledged."] }],
			settings,
			// The opt-in loads Ferment, so expectFerment proves the resource settings were read.
			clientMeta: { "kimchi.dev": { ferment: true } },
		})
		try {
			const session = await fixture.conn.request("session/new", { cwd: fixture.workDir, mcpServers: [] })
			const result = await fixture.conn.request("session/prompt", {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "Hello." }],
			})
			expect(result.stopReason).toBe("end_turn")
			const request = fixture.fake.requests.find((request) => request.url.includes("chat/completions"))
			expect(request).toBeDefined()
			if (!request) throw new Error("No model request recorded")
			// Proves the resource toggles really took effect. Without this, a
			// scenario whose settings are ignored would still pass. Ferment's tools
			// are listed directly or, in only mode, inside codemode's catalog.
			expect(JSON.stringify(request.body).includes(UPDATE_FERMENT_V2_TOOL_NAME)).toBe(expectFerment)
			const prompt = systemPromptOf(request)
			const codemodeDescription = toolDescriptionOf(request, "codemode")
			if (expectCodemode) {
				// Exactly once: pi's built-in codemode is replaced, not stacked.
				expect(codemodeDescription?.split("Use to filter large results before they reach you")).toHaveLength(2)
				expect(codemodeDescription).not.toContain("const hits")
				expect(codemodeDescription).toContain("Run JavaScript that calls other tools")
				if (checkPiLeak) {
					// Background bash does not expose Pi's session environment, so its
					// upstream PI_* guideline must not leak into the nested-tool catalog.
					expect(codemodeDescription).not.toContain("PI_*")
				}
			} else {
				expect(codemodeDescription).toBeUndefined()
			}
			expect(prompt.includes("Use `codemode` when intermediate output can be filtered before it reaches you")).toBe(
				expectCodemode,
			)
			// Pi's own per-tool guidelines are curated out of the prompt: they
			// duplicate kimchi's guidance or the tool descriptions, or contradict
			// the implementation (bash's PI_* env claim). True regardless of the
			// codemode toggle — the exclusion is by tool name, not availability.
			expect(prompt).not.toContain("Use read to examine files instead of cat or sed.")
			expect(prompt).not.toContain("Use codemode to batch independent tool calls (Promise.allSettled),")
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS + PROMPT_TIMEOUT_MS,
)
