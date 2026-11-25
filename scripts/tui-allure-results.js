import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** Write one native Allure result for a test-file-level TUI execution. */
export function writeTuiAllureResult({ resultsDir, stem, exitCode, start, stop }) {
	const fullName = `tests/e2e/tui/${stem}.test.ts`
	const identity = createHash("sha256").update(fullName).digest("hex")
	const uuid = randomUUID()
	const result = {
		uuid,
		historyId: identity,
		testCaseId: identity,
		fullName,
		name: stem,
		status: exitCode === 0 ? "passed" : "failed",
		...(exitCode === 0 ? {} : { statusDetails: { message: `tui-test exited with code ${exitCode}` } }),
		stage: "finished",
		start,
		stop,
	}
	mkdirSync(resultsDir, { recursive: true })
	writeFileSync(join(resultsDir, `${uuid}-result.json`), `${JSON.stringify(result, null, 2)}\n`)
}
