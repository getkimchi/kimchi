// ACP integration: raw --additional-skill-paths in the agent's argv.
// The flag is Kimchi-local, so the ACP prompt-option parse strips it before
// pi sees it; ACP discovery receives roots via RunAcpOptions. This test pins the
// user-visible symptom end-to-end: a kimchi process launched with a raw
// `--additional-skill-paths <dir>` token starts up normally over ACP and the
// private root's skill appears as a skill:<name> command in the session's
// available_commands_update — the palette a real IDE client renders.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { commandNames, newSession, waitFor } from "./support/scenarios.js"

const WAIT_MS = 20_000
const PRIVATE_SKILL = "e2e-private-skill"

describe("ACP integration — raw --additional-skill-paths argv", () => {
	let fixture: AcpFixture

	afterEach(async () => {
		await fixture.stop()
	})

	it(
		"starts up and exposes the private skill command passed via raw argv",
		async () => {
			// Private root OUTSIDE the session workDir and homeDir: only the
			// raw CLI flag can carry it into the agent process.
			const privateSkills = mkdtempSync(join(tmpdir(), "kimchi-acp-private-skills-"))
			const skillDir = join(privateSkills, PRIVATE_SKILL)
			mkdirSync(skillDir, { recursive: true })
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---\nname: ${PRIVATE_SKILL}\ndescription: E2E private additional-path skill\n---\nBody.\n`,
				"utf-8",
			)

			try {
				// Startup itself is the first assertion: if the raw Kimchi-local
				// token reached a strict upstream parser, initialize() would fail.
				fixture = await startAcpFixture({
					artifactName: "additional-skills-paths",
					responses: [],
					extraArgs: ["--additional-skill-paths", privateSkills],
				})

				const sessionId = await newSession(fixture, fixture.workDir)
				const names = await waitFor(
					() => commandNames(fixture, sessionId),
					(cmds) => cmds.includes(`skill:${PRIVATE_SKILL}`),
				)
				expect(names, `private skill missing; palette: ${names.join(",")}`).toContain(`skill:${PRIVATE_SKILL}`)
			} finally {
				rmSync(privateSkills, { recursive: true, force: true })
			}
		},
		STARTUP_TIMEOUT_MS + WAIT_MS,
	)
})
