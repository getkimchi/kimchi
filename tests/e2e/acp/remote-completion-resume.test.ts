import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it, vi } from "vitest"
import { startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt, waitFor } from "./support/scenarios.js"

const extensionPath = fileURLToPath(new URL("../fixtures/remote-completion-extension.js", import.meta.url))

it("restores a finished remote result only when its original ACP session is reopened", async () => {
	vi.stubEnv("KIMCHI_REMOTE_ENDPOINT", "http://127.0.0.1:1")
	const fixture = await startAcpFixture({
		artifactName: "remote-completion-resume",
		extensionPath,
		clientCapabilities: { elicitation: { form: {} } },
		responses: [{ stream: ["Session A ready."] }, { stream: ["Recovered the remote result in session A."] }],
	})
	try {
		const a = await newSession(fixture, fixture.workDir)
		expect((await prompt(fixture, a, "hello")).stopReason).toBe("end_turn")
		await prompt(fixture, a, "/seed-remote-completion")
		await fixture.conn.closeSession({ sessionId: a })
		const b = await newSession(fixture, fixture.workDir)
		expect(fixture.client.elicitationRequests).toHaveLength(0)

		fixture.client.answerNextElicitationWith({
			action: "accept",
			content: { value: "Review the remote agent's results in the local session" },
		})
		await fixture.conn.loadSession({ sessionId: a, cwd: fixture.workDir, mcpServers: [] })
		await waitFor(
			() => fixture.client.elicitationRequests.length,
			(count) => count === 1,
		)
		expect(fixture.client.elicitationRequests[0]?.params).toMatchObject({
			sessionId: a,
			message: "Remote agent run finished. What would you like to do next?",
		})
		const sessionRoot = join(fixture.homeDir, ".config", "kimchi", "harness", "sessions")
		const sessionLog = () => {
			for (const project of readdirSync(sessionRoot)) {
				for (const file of readdirSync(join(sessionRoot, project))) {
					if (file.endsWith(`_${a}.jsonl`)) return readFileSync(join(sessionRoot, project, file), "utf8")
				}
			}
			return ""
		}
		await waitFor(sessionLog, (text) => text.includes('"customType":"remote_plan_result"'))
		expect(sessionLog()).toContain("original-session-only")
		expect(fixture.client.agentTextBySession().get(b) ?? "").not.toContain("original-session-only")
	} finally {
		await fixture.stop()
		vi.unstubAllEnvs()
	}
})
