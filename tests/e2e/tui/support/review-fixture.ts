import { execFileSync } from "node:child_process"
import { mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { FakeResponseScript } from "./tui/support/fake-openai-server.js"

export const REVIEW_VALUE_FILE = "value.ts"

export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
		stdio: ["ignore", "pipe", "pipe"],
	}).trim()
}

export function seedReviewRepository(workDir: string): { baseSha: string; headSha: string; root: string } {
	git(workDir, "init", "--initial-branch=main")
	git(workDir, "config", "user.name", "Review E2E")
	git(workDir, "config", "user.email", "review@example.invalid")
	writeFileSync(join(workDir, REVIEW_VALUE_FILE), "export const value = 1\n")
	git(workDir, "add", REVIEW_VALUE_FILE)
	git(workDir, "commit", "-m", "base")
	writeFileSync(join(workDir, REVIEW_VALUE_FILE), "export const value = 1\nexport const changed = true\n")
	git(workDir, "add", REVIEW_VALUE_FILE)
	git(workDir, "commit", "-m", "head")
	const baseSha = git(workDir, "rev-parse", "HEAD^")
	const headSha = git(workDir, "rev-parse", "HEAD")
	return { baseSha, headSha, root: realpathSync(workDir) }
}

export function writeReviewManifest(options: {
	contextDir: string
	outputDir: string
	baseSha: string
	headSha: string
	checkoutPath: string
	deadline?: string
}): string {
	mkdirSync(options.contextDir, { recursive: true })
	writeFileSync(
		join(options.contextDir, "commentable-lines.json"),
		JSON.stringify({
			schema_version: "commentable-lines/v1",
			merge_base_sha: options.baseSha,
			commit_sha: options.headSha,
			files: { [REVIEW_VALUE_FILE]: { ranges: [{ start_line: 1, end_line: 20 }] } },
		}),
	)
	const path = join(options.contextDir, "manifest.json")
	writeFileSync(
		path,
		JSON.stringify(
			{
				schema_version: "review-manifest/v1",
				base_sha: options.baseSha,
				head_sha: options.headSha,
				checkout_path: options.checkoutPath,
				context_dir: options.contextDir,
				output_dir: options.outputDir,
				deadline: options.deadline ?? new Date(Date.now() + 10 * 60_000).toISOString(),
			},
			null,
			2,
		),
	)
	return path
}

function requestText(request: { body: unknown }): string {
	return JSON.stringify(request.body)
}

function lensResponse(lens: string, partial: boolean): FakeResponseScript[] {
	const matchesLens = (request: { body: unknown }) => requestText(request).includes(`REVIEW_LENS ${lens}`)
	const usage = { prompt_tokens: 11, completion_tokens: 5 }
	if (partial) return [{ match: matchesLens, stream: [`${lens} has no submission.`], usage }]
	return [
		{
			match: (request) => matchesLens(request) && !requestText(request).includes('"role":"tool"'),
			toolCalls: [
				{
					id: `call_${lens}_summary`,
					function: {
						name: "submit_summary",
						arguments: JSON.stringify({ body: `${lens} completed with no findings.`, environment_gaps: [] }),
					},
				},
			],
			usage,
		},
		{ match: matchesLens, stream: [`${lens} completed.`], usage },
	]
}

export function reviewResponseScripts(options: { partial?: boolean; finding?: boolean } = {}): FakeResponseScript[] {
	const scripts = options.finding ? [] : lensResponse("spec", options.partial === true)
	if (options.finding) {
		const usage = { prompt_tokens: 13, completion_tokens: 7 }
		scripts.push(
			{
				match: (request) =>
					requestText(request).includes("REVIEW_LENS spec") && !requestText(request).includes('"role":"tool"'),
				toolCalls: [
					{
						id: "call_spec_finding",
						function: {
							name: "submit_finding",
							arguments: JSON.stringify({
								path: REVIEW_VALUE_FILE,
								line: 2,
								severity: "warning",
								type: "bug",
								description: "The new export changes behavior without a guard; revision head inspection confirmed it.",
								suggestion: "Guard the changed behavior and add a focused regression test.",
							}),
						},
					},
				],
				usage,
			},
			{
				match: (request) =>
					requestText(request).includes("REVIEW_LENS spec") && requestText(request).includes('"role":"tool"'),
				toolCalls: [
					{
						id: "call_spec_summary_after_finding",
						function: {
							name: "submit_summary",
							arguments: JSON.stringify({ body: "One candidate found.", environment_gaps: [] }),
						},
					},
				],
				usage,
			},
			{ match: (request) => requestText(request).includes("REVIEW_LENS spec"), stream: ["Spec submitted."], usage },
		)
	}
	scripts.push({
		match: (request) => requestText(request).includes("semantic review reconciler"),
		stream: [JSON.stringify(reconciliation(options.finding === true))],
		usage: { prompt_tokens: 17, completion_tokens: 3 },
	})
	return scripts
}

function reconciliation(withFinding: boolean): Record<string, unknown> {
	if (!withFinding) return { schema_version: "review-reconciliation/v1", findings: [], decisions: [], threads: [] }
	return {
		schema_version: "review-reconciliation/v1",
		findings: [
			{
				id: "changed-export",
				path: REVIEW_VALUE_FILE,
				line: 2,
				severity: "warning",
				type: "bug",
				description: "The new export changes behavior without a guard; revision head inspection confirmed it.",
				suggestion: "Guard the changed behavior and add a focused regression test.",
				candidate_ids: ["spec-1"],
			},
		],
		decisions: [
			{
				candidate_id: "spec-1",
				disposition: "retained",
				finding: "changed-export",
				reason: "Independent candidate in the deterministic fixture.",
			},
		],
		threads: [],
	}
}

export interface ReviewInterruptionFixture {
	started: string
	survived: string
	pidFile: string
	grandchildPidFile: string
	toolArguments: string
}

export function createReviewInterruptionFixture(homeDir: string): ReviewInterruptionFixture {
	const suffix = Date.now()
	const names = {
		started: `review-command-started-${suffix}`,
		survived: `review-command-survived-${suffix}`,
		pidFile: `review-command-${suffix}.pid`,
		grandchildPidFile: `review-command-grandchild-${suffix}.pid`,
	}
	const worktreeRoot = join(tmpdir(), "kimchi-review-worktrees")
	const markerPath = (name: keyof typeof names) => {
		let located: string | undefined
		return () => {
			if (!located) {
				try {
					for (const entry of readdirSync(worktreeRoot, { recursive: true, withFileTypes: true })) {
						if (entry.isFile() && entry.name === names[name]) {
							located = join(entry.parentPath, entry.name)
							break
						}
					}
				} catch {
					// The run directory may not exist yet or may be removed during cleanup.
				}
			}
			if (!located && name !== "started") {
				const start = markerPath("started")()
				if (start !== join(homeDir, names.started)) located = join(dirname(start), names[name])
			}
			return located ?? join(homeDir, names[name])
		}
	}
	const started = markerPath("started")
	const survived = markerPath("survived")
	const pidFile = markerPath("pidFile")
	const grandchildPidFile = markerPath("grandchildPidFile")
	const script = join(homeDir, "review-command.mjs")
	writeFileSync(
		script,
		`import { spawn } from "node:child_process"\nimport { writeFileSync } from "node:fs"\nconst grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })\ngrandchild.unref()\nwriteFileSync(process.argv[3], String(process.pid))\nwriteFileSync(process.argv[5], String(grandchild.pid))\nwriteFileSync(process.argv[2], "started")\nsetTimeout(() => writeFileSync(process.argv[4], "survived"), 2000)\nsetInterval(() => {}, 1000)\n`,
	)
	return {
		get started() {
			return started()
		},
		get survived() {
			return survived()
		},
		get pidFile() {
			return pidFile()
		},
		get grandchildPidFile() {
			return grandchildPidFile()
		},
		toolArguments: JSON.stringify({
			command: [
				process.execPath,
				script,
				...[names.started, names.pidFile, names.survived, names.grandchildPidFile].map(
					(name) => `"$KIMCHI_REVIEW_SCRATCH_DIR/${name}"`,
				),
			].join(" "),
			cwd: ".",
			intended_check: "long-running reviewer command for cancellation cleanup",
		}),
	}
}

export function reviewInterruptionResponseScript(getArguments: () => string): FakeResponseScript {
	return {
		match: (request) =>
			JSON.stringify(request.body).includes("REVIEW_LENS spec") &&
			!JSON.stringify(request.body).includes('"role":"tool"'),
		toolCalls: [
			{
				id: "call_review_interrupt_command",
				function: {
					name: "run_review_command",
					get arguments() {
						return getArguments()
					},
				},
			},
		],
		usage: { prompt_tokens: 19, completion_tokens: 3 },
	}
}
