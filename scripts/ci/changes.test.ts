import { describe, expect, it } from "vitest"
import { suitesToRun } from "./changes.js"

describe("suitesToRun", () => {
	it("skips every suite when nothing changed", () => {
		expect(suitesToRun([])).toEqual({ tui: false, acp: false, mcp: false })
	})

	it("skips every suite for a docs-only change", () => {
		expect(suitesToRun(["docs/ferment.md", "README.md", ".github/pull_request_template.md", "LICENSE"])).toEqual({
			tui: false,
			acp: false,
			mcp: false,
		})
	})

	it("runs TUI for markdown under src, because it ships in the binary", () => {
		expect(suitesToRun(["src/extensions/agents/README.md"]).tui).toBe(true)
	})

	it("runs TUI for a source change", () => {
		expect(suitesToRun(["src/cli.ts"]).tui).toBe(true)
	})

	it("runs TUI for a workflow change", () => {
		expect(suitesToRun([".github/workflows/ci.yml"]).tui).toBe(true)
	})

	it("skips TUI when only other suites' tests changed", () => {
		expect(
			suitesToRun(["src/cli.test.ts", "tests/smoke/binary.test.ts", "tests/e2e/acp/run-boundary.test.ts"]).tui,
		).toBe(false)
	})

	it("runs TUI for its own tests and support files", () => {
		expect(suitesToRun(["tests/e2e/tui/side-chat.test.ts"]).tui).toBe(true)
		expect(suitesToRun(["tests/e2e/tui/support/fixture.ts"]).tui).toBe(true)
	})

	it("runs ACP but not TUI for an ACP test change", () => {
		expect(suitesToRun(["tests/e2e/acp/run-boundary.test.ts"])).toEqual({ tui: false, acp: true, mcp: false })
	})

	it("runs TUI but not ACP for a TUI test change", () => {
		expect(suitesToRun(["tests/e2e/tui/side-chat.test.ts"])).toEqual({ tui: true, acp: false, mcp: false })
	})

	it("runs ACP for TUI support files, which ACP fixtures import", () => {
		expect(suitesToRun(["tests/e2e/tui/support/fixture.ts"]).acp).toBe(true)
	})

	it("runs only MCP conformance for a conformance client change", () => {
		expect(suitesToRun(["tests/e2e/mcp/conformance-client.ts"])).toEqual({ tui: false, acp: false, mcp: true })
	})

	it("runs MCP conformance for ACP support files, which the client imports", () => {
		expect(suitesToRun(["tests/e2e/acp/support/acp-fixture.ts"]).mcp).toBe(true)
	})

	it("runs TUI when one file of a mixed change matters", () => {
		expect(suitesToRun(["docs/ferment.md", "src/cli.ts"]).tui).toBe(true)
	})
})
