// ACP integration: an agent file with unparseable frontmatter must not break
// session creation. The session opens, the client is told which file was
// skipped through `_kimchi.dev/pi_notify`, and a prompt turn still completes.

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt, waitFor } from "./support/scenarios.js"

describe("ACP integration — unparseable agent files", () => {
	let fixture: AcpFixture | undefined

	afterEach(async () => {
		await fixture?.stop()
	})

	it("opens the session, names the skipped agent file, and completes a turn", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-agent-invalid-frontmatter",
			responses: [{ stream: ["Still working."] }],
			pretrustWorkDir: true,
		})

		const agentsDir = join(fixture.workDir, ".kimchi", "agents")
		mkdirSync(agentsDir, { recursive: true })
		// Unquoted prose with ": " inside is not strict YAML, but loads.
		writeFileSync(
			join(agentsDir, "import-tidier.md"),
			"---\ndescription: Tidies imports. <example>Context: a file was edited.</example>\n---\n\nYou tidy imports.\n",
		)
		// An unclosed list cannot be repaired: skipped with a warning.
		writeFileSync(join(agentsDir, "broken-agent.md"), "---\ndescription: broken\ntools: [read, bash\n---\n\nPrompt.\n")

		const sessionId = await newSession(fixture, fixture.workDir)

		const client = fixture.client
		const warnings = await waitFor(
			() =>
				client.extNotifications
					.filter((n) => n.method === "_kimchi.dev/pi_notify")
					.map((n) => JSON.stringify(n.params))
					.filter((params) => params.includes("invalid frontmatter")),
			(found) => found.length > 0,
		)
		expect(warnings).toHaveLength(1)
		expect(warnings[0]).toContain("broken-agent.md")
		expect(warnings[0]).not.toContain("import-tidier.md")
		expect(warnings[0]).toContain('"notifyType":"warning"')

		const result = await prompt(fixture, sessionId, "Say hello")
		expect(result.stopReason).toBe("end_turn")
	})
})
