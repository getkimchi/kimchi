import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const requireFromTuiTest = createRequire(import.meta.resolve("@microsoft/tui-test"))

it("discovers TUI test files through the glob version used by tui-test", async () => {
	const { glob } = requireFromTuiTest("glob")
	const files: string[] = await glob("tests/e2e/tui/*.test.ts", { cwd: projectRoot })
	expect(files).toContain("tests/e2e/tui/basic-session-lifecycle.test.ts")
})
