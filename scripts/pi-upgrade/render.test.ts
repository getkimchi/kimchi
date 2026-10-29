import { describe, expect, it } from "vitest"
import type { PatchResult } from "./dry-run.ts"
import type { InternalsResult } from "./internals.ts"
import { type ReportInput, renderReport } from "./render.ts"
import type { Analysis } from "./schemas.ts"
import type { SettleResult } from "./settle.ts"
import type { TestsResult } from "./tests.ts"

const settle: SettleResult = {
	baseline: "1.3.0",
	target: "1.4.0",
	chain: ["1.4.0"],
	behind: { versions: 1, days: 12, lines: 1, latest: "1.4.0" },
	forced: false,
}

const dryRun: PatchResult[] = [
	{
		patch: "@earendil-works__pi-tui@1.3.0.patch",
		pkg: "pi-tui",
		hunks: [
			{ file: "dist/a.js", hunk: 1, strict: "ok", fuzz: "ok" },
			{ file: "dist/b.js", hunk: 1, strict: "fail", fuzz: "ok" },
			{ file: "dist/c.js", hunk: 1, strict: "fail", fuzz: "fail" },
		],
		appliesStrict: false,
		appliesFuzz: false,
	},
]

const internals: InternalsResult = {
	methods: [
		{
			pkg: "pi-coding-agent",
			distFile: "dist/s.js",
			name: "_checkCompaction",
			hookedBy: "src/r.ts",
			status: "changed",
		},
		{ pkg: "pi-coding-agent", distFile: "dist/s.js", name: "_emit", hookedBy: "src/r.ts", status: "identical" },
	],
	overwrites: [{ pkg: "pi-ai", distFile: "dist/utils/oauth-page.js", by: "scripts/o.js", status: "identical" }],
}

const suite = (s: string, status: "pass" | "fail" | "not-run", failed: string[] = []) => ({
	suite: s as "unit",
	status,
	failed,
	exitCode: status === "fail" ? 1 : 0,
	log: "",
})

const tests: TestsResult = {
	install: { ok: true, log: "" },
	excludedPatches: ["@earendil-works__pi-tui@1.3.0.patch"],
	target: [],
	baseline: [],
	net: [
		suite("typecheck", "fail", ["src/a.ts(1,1): TS2554 x", "src/b.ts(2,2): TS2554 y"]),
		suite("unit", "fail", ["src/u.test.ts > known", "src/v.test.ts > mystery"]),
		suite("binary", "pass"),
		suite("smoke", "not-run"),
	],
	missingSymbols: ["@earendil-works/pi-coding-agent: setEmbeddedQuickJSWasmPath (src/entry.ts(115,11))"],
}

const analysis: Analysis = {
	verdict: {
		risk: "moderate",
		effort: "M",
		effortWhy: "one patch conflict and a signature change",
		apiBreakage: "1 removed export",
		topHazard: "setModel no longer persists",
	},
	breaking: [
		{ summary: "setModel() stopped persisting the default", evidence: "CHANGELOG.md [1.4.0]" },
		{ summary: "unsupported claim", evidence: "" },
	],
	keepDisabled: [{ summary: "native MCP", how: "seed -builtin:mcp", evidence: "CHANGELOG.md [1.4.0] Added" }],
	patchRework: [
		{ summary: "markdown.js drift", patch: "pi-tui", status: "rebase", evidence: "dist/components/markdown.js:40" },
	],
	freeWins: [],
	testTriage: [
		{ test: "src/u.test.ts > known", cause: "excluded-patch", note: "pi-tui patch excluded" },
		{ test: "src/v.test.ts > mystery", cause: "unexplained", note: "?" },
	],
	digests: [],
	newDigests: [],
}

const input: ReportInput = { settle, dryRun, internals, tests, analysis }

describe("renderReport", () => {
	it("leads with the verdict, how far behind, patches and test results", () => {
		const report = renderReport(input)
		const lines = report.split("\n")
		expect(lines[0]).toBe("## Pi upgrade: 1.3.0 → 1.4.0")
		expect(report).toContain(
			"| moderate | **M** — one patch conflict and a signature change | 1 removed export | setModel no longer persists |",
		)
		expect(report).toContain("**Behind:** 1 version · 12 days · 1 minor line (latest 1.4.0)")
		expect(report).toContain(
			"**Patches:** 1/3 hunks clean · 1 need rebase · 1 conflict · excluded from test install: @earendil-works__pi-tui@1.3.0.patch",
		)
		expect(report).toContain("**Tests (new vs master):** typecheck 2 errors · unit 2 failing · binary ok · smoke —")
	})

	it("renders sections in order and drops findings without evidence", () => {
		const report = renderReport(input)
		const order = ["### Breaking changes", "### Keep disabled for now", "### Patch rework", "### Free wins"].map((h) =>
			report.indexOf(h),
		)
		expect(order.every((i, n) => i > 0 && (n === 0 || i > (order[n - 1] ?? 0)))).toBe(true)
		expect(report).toContain("- setModel() stopped persisting the default — CHANGELOG.md [1.4.0]")
		expect(report).not.toContain("unsupported claim")
		expect(report).toContain("- native MCP — **off-switch:** seed -builtin:mcp — CHANGELOG.md [1.4.0] Added")
		expect(report).toContain("- `pi-tui` (rebase) markdown.js drift — dist/components/markdown.js:40")
		expect(report).toMatch(/### Free wins\n\n_none_/)
	})

	it("lists unexplained test failures first in the triage details", () => {
		const report = renderReport(input)
		expect(report.indexOf("src/v.test.ts > mystery")).toBeLessThan(report.indexOf("src/u.test.ts > known"))
		expect(report).toContain("<summary>Runtime hooks & overwrites (1 changed)</summary>")
		expect(report).toContain("<summary>Missing symbols (1)</summary>")
	})
})

describe("renderReport degraded inputs", () => {
	it("still renders the deterministic results when the analysis is unavailable", () => {
		const report = renderReport({ ...input, analysis: { unavailable: true, reason: "exit 1" } })
		expect(report).toContain("| analysis unavailable | — | — | — |")
		expect(report).toContain("_AI analysis unavailable: exit 1_")
		expect(report).toContain("**Patches:**")
	})

	it("replaces the test line with the install failure", () => {
		const report = renderReport({
			...input,
			tests: { ...tests, install: { ok: false, log: "" }, net: [], installError: "ERR_PNPM_PEER_DEP pi-ai@^1" },
		})
		expect(report).toContain("**Tests:** install failed — ERR_PNPM_PEER_DEP pi-ai@^1")
	})

	it("hard-truncates when the sections alone exceed the limit", () => {
		const verbose: ReportInput = {
			...input,
			analysis: {
				...analysis,
				breaking: Array.from({ length: 200 }, (_, i) => ({ summary: `change ${i} ${"x".repeat(40)}`, evidence: "e" })),
			},
		}
		const report = renderReport(verbose, { limit: 3_000, summaryUrl: "https://example.test/run/1" })
		expect(report.length).toBeLessThanOrEqual(3_000)
		expect(report).toContain("| moderate |")
		expect(report).toContain("Full report: https://example.test/run/1")
	})

	it("trims collapsed details first when the report exceeds the limit", () => {
		const big: ReportInput = {
			...input,
			tests: {
				...tests,
				net: [
					suite(
						"unit",
						"fail",
						Array.from({ length: 400 }, (_, i) => `src/t${i}.test.ts > case`),
					),
				],
			},
		}
		const report = renderReport(big, { limit: 3_000, summaryUrl: "https://example.test/run/1" })
		expect(report.length).toBeLessThanOrEqual(3_000)
		expect(report).toContain("### Breaking changes")
		expect(report).not.toContain("src/t399.test.ts")
		expect(report).toContain(
			"_Some details were trimmed to fit GitHub's limit. Full report: https://example.test/run/1_",
		)
	})
})
