import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type RunConfig, readJson } from "./config.ts"
import type { PatchResult } from "./dry-run.ts"
import type { InternalsResult } from "./internals.ts"
import type { AnalysisFile, Finding } from "./schemas.ts"
import type { SettleResult } from "./settle.ts"
import { GITHUB_TEXT_LIMIT } from "./state.ts"
import type { SuiteResult, TestsResult } from "./tests.ts"

export interface ReportInput {
	settle: SettleResult
	dryRun: PatchResult[] | null
	internals: InternalsResult | null
	tests: TestsResult | null
	analysis: AnalysisFile | null
}

const SUITE_LABEL: Record<string, string> = { tui: "TUI", acp: "ACP", mcp: "MCP" }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

function suiteSummary(r: SuiteResult): string {
	const label = SUITE_LABEL[r.suite] ?? r.suite
	if (r.status === "not-run") return `${label} —`
	if (r.status === "pass") return `${label} ok`
	if (r.suite === "typecheck") return `${label} ${plural(r.failed.length, "error")}`
	if (r.suite === "binary") return `${label} failed`
	return `${label} ${r.failed.length} failing`
}

function patchLine(dryRun: PatchResult[], tests: TestsResult | null): string {
	const hunks = dryRun.flatMap((p) => p.hunks)
	const clean = hunks.filter((h) => h.strict === "ok").length
	const rebase = hunks.filter((h) => h.strict === "fail" && h.fuzz === "ok").length
	const conflict = hunks.filter((h) => h.fuzz === "fail").length
	const excluded = tests?.excludedPatches.length
		? ` · excluded from test install: ${tests.excludedPatches.join(", ")}`
		: ""
	return `**Patches:** ${clean}/${hunks.length} hunks clean · ${rebase} need rebase · ${plural(conflict, "conflict")}${excluded}`
}

const withEvidence = <T extends { evidence: string }>(items: T[]) => items.filter((i) => i.evidence.trim() !== "")

function section(title: string, items: string[]): string {
	return `### ${title}\n\n${items.length > 0 ? items.join("\n") : "_none_"}`
}

function details(summary: string, body: string): string {
	return `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`
}

const findingLine = (f: Finding) => `- ${f.summary} — ${f.evidence}`

/** Markdown report shared by the job summary and the issue body. */
export function renderReport(input: ReportInput, opts: { limit?: number; summaryUrl?: string } = {}): string {
	const { settle, dryRun, internals, tests, analysis } = input
	const a = analysis && !("unavailable" in analysis) ? analysis : null
	const head: string[] = [`## Pi upgrade: ${settle.baseline} → ${settle.target ?? "(none)"}`, ""]

	head.push("| Risk | Effort | API breakage | Top hazard |", "| --- | --- | --- | --- |")
	head.push(
		a
			? `| ${a.verdict.risk} | **${a.verdict.effort}** — ${a.verdict.effortWhy} | ${a.verdict.apiBreakage} | ${a.verdict.topHazard} |`
			: "| analysis unavailable | — | — | — |",
	)
	head.push("")
	if (analysis && "unavailable" in analysis) head.push(`_AI analysis unavailable: ${analysis.reason}_`, "")

	const b = settle.behind
	head.push(
		`**Behind:** ${plural(b.versions, "version")} · ${plural(b.days, "day")} · ${plural(b.lines, "minor line")} (latest ${b.latest})`,
	)
	if (dryRun) head.push("", patchLine(dryRun, tests))
	if (tests) {
		head.push(
			"",
			tests.install.ok
				? `**Tests (new vs master):** ${tests.net.map(suiteSummary).join(" · ")}`
				: `**Tests:** install failed — ${tests.installError ?? "see install log"}`,
		)
	}

	const sections = [
		section("Breaking changes", withEvidence(a?.breaking ?? []).map(findingLine)),
		section(
			"Keep disabled for now",
			withEvidence(a?.keepDisabled ?? []).map((k) => `- ${k.summary} — **off-switch:** ${k.how} — ${k.evidence}`),
		),
		section(
			"Patch rework",
			withEvidence(a?.patchRework ?? []).map((p) => `- \`${p.patch}\` (${p.status}) ${p.summary} — ${p.evidence}`),
		),
		section("Free wins", withEvidence(a?.freeWins ?? []).map(findingLine)),
	]

	const blocks: string[] = []
	if (dryRun) {
		const rows = dryRun.flatMap((p) =>
			p.hunks
				.filter((h) => h.strict !== "ok")
				.map(
					(h) =>
						`| ${p.pkg} | ${h.file}#${h.hunk} | ${h.fuzz === "ok" ? "rebase (drift)" : h.missingFile ? "file gone" : "conflict"} |`,
				),
		)
		blocks.push(
			details(
				`Patch dry-run (${rows.length} hunks need work)`,
				rows.length > 0
					? ["| Package | Hunk | Result |", "| --- | --- | --- |", ...rows].join("\n")
					: "All hunks apply cleanly.",
			),
		)
	}
	if (internals) {
		const changed = [...internals.methods, ...internals.overwrites].filter((m) => m.status !== "identical")
		const rows = [
			...internals.methods.map((m) => `| \`${m.name}\` | ${m.status} | ${m.hookedBy} |`),
			...internals.overwrites.map((o) => `| \`${o.distFile}\` (overwritten) | ${o.status} | ${o.by} |`),
		]
		blocks.push(
			details(
				`Runtime hooks & overwrites (${changed.length} changed)`,
				["| Upstream member | Baseline → target | Used by |", "| --- | --- | --- |", ...rows].join("\n"),
			),
		)
	}
	if (tests && tests.missingSymbols.length > 0) {
		blocks.push(
			details(`Missing symbols (${tests.missingSymbols.length})`, tests.missingSymbols.map((s) => `- ${s}`).join("\n")),
		)
	}
	if (tests) {
		const triage = new Map((a?.testTriage ?? []).map((t) => [t.test, t]))
		const failing = tests.net.flatMap((r) => r.failed.map((id) => ({ id, suite: r.suite, t: triage.get(id) })))
		const rank = (cause?: string) => (cause === "unexplained" || !cause ? 0 : 1)
		failing.sort((x, y) => rank(x.t?.cause) - rank(y.t?.cause))
		if (failing.length > 0) {
			blocks.push(
				details(
					`Failing tests (${failing.length}, unexplained first)`,
					failing
						.map(({ id, suite, t }) => `- [${suite}] \`${id}\` — ${t ? `${t.cause}: ${t.note}` : "not triaged"}`)
						.join("\n"),
				),
			)
		}
	}
	if (a && a.digests.length > 0) {
		blocks.push(
			details(
				"Per-release digests",
				a.digests
					.map((d) =>
						[
							`**${d.from} → ${d.to}**`,
							...withEvidence([...d.breaking, ...d.behaviorChanges, ...d.builtins, ...d.features]).map(findingLine),
						].join("\n"),
					)
					.join("\n\n"),
			),
		)
	}

	const limit = opts.limit ?? GITHUB_TEXT_LIMIT
	const assemble = (kept: string[], trimmed: boolean) =>
		[
			...head,
			"",
			...sections.flatMap((s) => [s, ""]),
			...kept.flatMap((d) => [d, ""]),
			trimmed
				? `_Some details were trimmed to fit GitHub's limit. Full report: ${opts.summaryUrl ?? "see the job summary"}_`
				: "",
		]
			.join("\n")
			.trimEnd()
	let kept = blocks
	let report = assemble(kept, false)
	while (report.length > limit && kept.length > 0) {
		kept = kept.slice(0, -1)
		report = assemble(kept, true)
	}
	if (report.length > limit) {
		// Even the sections are too long (a verbose analysis): cut hard, keep the pointer to the full copy.
		const tail = `\n\n…\n\n_Some details were trimmed to fit GitHub's limit. Full report: ${opts.summaryUrl ?? "see the job summary"}_`
		report = report.slice(0, limit - tail.length) + tail
	}
	return report
}

function readIf<T>(cfg: RunConfig, name: string): T | null {
	return existsSync(join(cfg.outDir, `${name}.json`)) ? readJson<T>(cfg, name) : null
}

export function reportSummaryUrl(): string | undefined {
	const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env
	return GITHUB_RUN_ID ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : undefined
}

/** The job summary accepts ~1 MiB; the untrimmed report goes there. */
const SUMMARY_LIMIT = 1_000_000

export async function runRender(cfg: RunConfig): Promise<{ path: string; length: number }> {
	const input: ReportInput = {
		settle: readJson<SettleResult>(cfg, "settle"),
		dryRun: readIf<PatchResult[]>(cfg, "dry-run"),
		internals: readIf<InternalsResult>(cfg, "internals"),
		tests: readIf<TestsResult>(cfg, "tests"),
		analysis: readIf<AnalysisFile>(cfg, "analysis"),
	}
	const report = renderReport(input, { summaryUrl: reportSummaryUrl() })
	writeFileSync(join(cfg.outDir, "report-full.md"), `${renderReport(input, { limit: SUMMARY_LIMIT })}\n`)
	const path = join(cfg.outDir, "report.md")
	writeFileSync(path, `${report}\n`)
	return { path, length: report.length }
}
