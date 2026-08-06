import { mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const SNAPSHOT_START = "<!-- kimchi:environment-snapshot:start -->"
const SNAPSHOT_END = "<!-- kimchi:environment-snapshot:end -->"

function agentCall() {
	return {
		id: "call_environment_subagent",
		function: {
			name: "Agent",
			arguments: JSON.stringify({
				prompt: "Confirm the workspace contains fresh-after-start.ts.",
				description: "inspect fresh workspace",
				subagent_type: "General-Purpose",
			}),
		},
	}
}

function systemPrompt(request: { body?: unknown }): string | undefined {
	const body = request.body as { messages?: Array<{ role: string; content: string }> }
	return body.messages?.find((message) => message.role === "system")?.content
}

function requestContainsText(request: { body?: unknown }, text: string): boolean {
	const body = request.body as { messages?: unknown }
	return JSON.stringify(body.messages).includes(text)
}

function expectOneFinalSnapshot(prompt: string): void {
	expect((prompt.match(/kimchi:environment-snapshot:start/g) ?? []).length).toBe(1)
	expect((prompt.match(/kimchi:environment-snapshot:end/g) ?? []).length).toBe(1)
	expect(prompt.trimEnd().endsWith(SNAPSHOT_END)).toBe(true)
}

function findSessionHeaders(dir: string): Array<{ parentSession?: string }> {
	const headers: Array<{ parentSession?: string }> = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) {
			headers.push(...findSessionHeaders(path))
		} else if (entry.name.endsWith(".jsonl")) {
			const firstLine = readFileSync(path, "utf8").split("\n", 1)[0]
			if (firstLine) headers.push(JSON.parse(firstLine) as { parentSession?: string })
		}
	}
	return headers
}

test("a new subagent gets a fresh bounded snapshot while its parent keeps startup bytes", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "environment-snapshot",
			seedHome: (homeDir, workDir) => {
				writeFileSync(join(workDir, "known-at-start.ts"), "export {}\n")
				writeFileSync(join(workDir, ".env"), "SECRET_VALUE=must-not-leak\n")
				mkdirSync(join(workDir, "node_modules"))
				writeFileSync(join(workDir, "node_modules", "excluded.js"), "excluded\n")
				const target = join(homeDir, "snapshot-symlink-target")
				mkdirSync(target)
				writeFileSync(join(target, "target-secret.txt"), "do not inspect\n")
				symlinkSync(target, join(workDir, "shared-link"))
			},
			responses: [
				{
					toolCalls: [
						{
							id: "call_create_fresh_file",
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "touch fresh-after-start.ts" }),
							},
						},
					],
				},
				{ toolCalls: [agentCall()] },
				{ stream: ["fresh file confirmed"] },
				{ stream: ["workflow complete"] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("create a file, then ask a subagent to inspect it")
			await waitForText(terminal, "workflow complete")
			trace.step("main mutation and subagent inspection completed")

			const requests = fixture.fake.requests.filter((request) => request.url.includes("/chat/completions"))
			const prompts = requests
				.map(systemPrompt)
				.filter((prompt): prompt is string => prompt?.includes(SNAPSHOT_START) === true)
			expect(prompts.length).toBeGreaterThanOrEqual(3)

			const parentRequestText = "create a file, then ask a subagent to inspect it"
			const subagentHeader = "You are a kimchi coding agent sub-agent."
			const mainPrompts = requests
				.filter((request) => requestContainsText(request, parentRequestText))
				.map(systemPrompt)
				.filter((prompt): prompt is string => prompt?.includes(SNAPSHOT_START) === true)
			const mainAtStart = mainPrompts[0]
			const mainAfterMutation = mainPrompts[1]
			const subagent = prompts.find((prompt) => prompt.startsWith(subagentHeader))
			expect(mainAtStart).toBeDefined()
			expect(mainAfterMutation).toBeDefined()
			expect(subagent).toBeDefined()
			if (!mainAtStart || !mainAfterMutation || !subagent) return

			for (const prompt of [mainAtStart, mainAfterMutation, subagent]) expectOneFinalSnapshot(prompt)
			expect(mainAtStart).toContain(`Working directory: ${JSON.stringify(realpathSync(fixture.workDir))}`)
			expect(mainAtStart).toContain("known-at-start.ts")
			expect(mainAtStart).toContain('".env" [may contain sensitive data')
			expect(mainAtStart).toContain('"shared-link" [symlink; target not inspected]')
			expect(mainAtStart).not.toContain("must-not-leak")
			expect(mainAtStart).not.toContain("node_modules")
			expect(mainAtStart).not.toContain("target-secret.txt")
			expect(mainAtStart).not.toContain("snapshot-symlink-target")
			expect(mainAtStart).not.toContain("fresh-after-start.ts")
			expect(mainAfterMutation).toBe(mainAtStart)
			expect(subagent).toContain("fresh-after-start.ts")
			expect(findSessionHeaders(fixture.homeDir).some((header) => header.parentSession !== undefined)).toBe(true)
			trace.step("snapshot freshness and safety invariants verified")
		},
	)
})
