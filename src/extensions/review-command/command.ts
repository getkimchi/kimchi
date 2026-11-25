import { join } from "node:path"
import type { ExtensionAPI, ExtensionCommandContext, SessionManager } from "@earendil-works/pi-coding-agent"
import { parse as parseShell } from "shell-quote"
import { getParsedCliArgs } from "../../cli-args.js"
import { isPrintModeEnabled } from "../print-mode.js"
import {
	type ResolvedReviewPanel,
	type ReviewPanelProgress,
	type ReviewPanelResult,
	resolveReviewPanel,
	runReviewPanel,
	wrapUpReviewPanel,
} from "../review-panel/index.js"
import { recoverReviewWorktrees } from "../review-runner/index.js"
import { resolveReviewDirectories } from "../review-submit/paths.js"
import {
	type BareReviewRequest,
	cleanupStaleReviewSnapshots,
	type ExplicitReviewRequest,
	getReviewTargetChoices,
	parseReviewTargetArgs,
	type ResolvedReviewTarget,
	resolveReviewTarget,
} from "../review-targets/index.js"
import { ReviewTargetError } from "../review-targets/types.js"
import { acquireReviewOperation, type ReviewOperation } from "./active-runs.js"
import { headlessEnvironmentGaps } from "./environment-gaps.js"
import {
	loadPreparedReviewManifest,
	type PreparedReviewManifest,
	prepareReviewManifestTarget,
	REVIEW_MANIFEST_FILENAME,
	readReviewManifest,
} from "./manifest.js"
import { createLocalReviewRunDirectory, reviewOwnedDirectories } from "./run-directory.js"
import { readTrustedReviewSettings } from "./settings.js"
import {
	configureReviewPrintStream,
	emitReviewAgentSettled,
	emitReviewChildUsage,
	emitReviewSystemMessage,
	flushReviewPrintEvents,
	startReviewPrintTermination,
} from "./stream.js"

const STALE_REVIEW_AGE_MS = 24 * 60 * 60 * 1000

export interface ReviewCommandDependencies {
	parseTarget: typeof parseReviewTargetArgs
	resolveTarget: typeof resolveReviewTarget
	choices: typeof getReviewTargetChoices
	resolvePanel: typeof resolveReviewPanel
	runPanel: typeof runReviewPanel
	wrapUp: typeof wrapUpReviewPanel
	readSettings: typeof readTrustedReviewSettings
	cleanSnapshots: typeof cleanupStaleReviewSnapshots
	recoverWorktrees: typeof recoverReviewWorktrees
	readManifest: typeof readReviewManifest
	prepareManifest: typeof prepareReviewManifestTarget
}

const dependencies: ReviewCommandDependencies = {
	parseTarget: parseReviewTargetArgs,
	resolveTarget: resolveReviewTarget,
	choices: getReviewTargetChoices,
	resolvePanel: resolveReviewPanel,
	runPanel: runReviewPanel,
	wrapUp: wrapUpReviewPanel,
	readSettings: readTrustedReviewSettings,
	cleanSnapshots: cleanupStaleReviewSnapshots,
	recoverWorktrees: recoverReviewWorktrees,
	readManifest: readReviewManifest,
	prepareManifest: prepareReviewManifestTarget,
}

function invalid(message: string): ReviewTargetError {
	return new ReviewTargetError("invalid_arguments", message)
}

function tokenize(args: string): string[] {
	try {
		const parsed = parseShell(args, {})
		if (!parsed.every((token) => typeof token === "string")) {
			throw invalid("Review operators and substitutions are not supported; quote literal ref and path arguments.")
		}
		return parsed as string[]
	} catch (error) {
		if (error instanceof ReviewTargetError) throw error
		throw invalid(`Could not parse /review arguments: ${error instanceof Error ? error.message : String(error)}`)
	}
}

function printReviewError(error: unknown): void {
	const code = error instanceof ReviewTargetError ? error.code : "review_error"
	const message = (error instanceof Error ? error.message : String(error)).replace(/\r?\n/g, " ")
	console.error(`Review error [${code}]: ${message}`)
}

function reviewCliEnabled(): boolean {
	return getParsedCliArgs().options.review === true
}

function jsonPrintEnabled(): boolean {
	return isPrintModeEnabled() && getParsedCliArgs().options.mode === "json"
}

function cliDirectories(ctx: ExtensionCommandContext) {
	const options = getParsedCliArgs().options
	return resolveReviewDirectories(ctx.cwd, {
		...(typeof options["review-context-dir"] === "string" ? { contextDir: options["review-context-dir"] } : {}),
		...(typeof options["review-output-dir"] === "string" ? { outputDir: options["review-output-dir"] } : {}),
	})
}

interface Reporter {
	scope: (target: ResolvedReviewTarget, runDirectory?: string) => void
	selection: (selection: ResolvedReviewPanel) => void
	progress: (progress: ReviewPanelProgress) => void
	result: (result: ReviewPanelResult) => void
	error: (error: unknown) => void
}

function notify(ctx: ExtensionCommandContext, message: string, severity: "info" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, severity)
}

function reporter(ctx: ExtensionCommandContext, visible: boolean): Reporter {
	let scopeLines: string[] = []
	let selectionLines: string[] = []
	let progressLines: string[] = []
	const paint = (resultLines: string[] = []) => {
		if (visible) {
			ctx.ui.setWidget("review-panel", [...scopeLines, ...selectionLines, ...progressLines, ...resultLines], {
				placement: "aboveEditor",
			})
		}
	}
	return {
		scope(target, runDirectory) {
			if (!visible) return
			const scope = target.scope
			scopeLines = [
				`Review scope pinned: ${scope.pinned.baseSha}..${scope.pinned.headSha}`,
				`${scope.kind}; ${scope.files.changed} changed files; checkout ${scope.checkoutPath}`,
				...(runDirectory ? [`Run directory: ${runDirectory}`] : []),
			]
			paint()
		},
		selection(selection) {
			if (!visible) return
			selectionLines = [
				"Review lenses:",
				...selection.lenses.map((lens) => `${lens.id} (${lens.reasons.join("; ")})`),
				`Effective concurrency: ${selection.slotCount}`,
			]
			paint()
		},
		progress(progress) {
			progressLines = [
				`Review: ${progress.phase}; candidates ${progress.counts.candidates}; reconciliation ${progress.reconciliation.status}`,
				...progress.lenses.map(
					(lens) =>
						`${lens.status === "running" ? "▶" : lens.status === "submitted" ? "✓" : lens.status === "queued" ? "○" : "×"} ${lens.id}: ${lens.status} (${lens.candidateCount} candidates)`,
				),
			]
			paint()
		},
		result(result) {
			if (!visible) return
			const coverage = result.progress.coverage
			const findings = result.findings.length
				? result.findings.map(
						(finding) => `${finding.severity.toUpperCase()} ${finding.path}:${finding.line} ${finding.description}`,
					)
				: ["No findings."]
			const partial = coverage.unfinished_lenses.length
				? `Partial coverage; unfinished lenses: ${coverage.unfinished_lenses.join(", ")}.`
				: "Complete review coverage."
			paint([`Review ${coverage.status}: ${result.findings.length} final findings.`, partial, ...findings])
			notify(
				ctx,
				`Review ${coverage.status}: ${result.findings.length} final findings. ${partial} Report: ${result.summaryPath}`,
			)
		},
		error(error) {
			if (!visible) return
			const message = `Review failed: ${error instanceof Error ? error.message : String(error)}`
			progressLines = [message]
			paint()
			notify(ctx, message, "error")
		},
	}
}

async function staleSweep(root: string, deps: ReviewCommandDependencies, signal?: AbortSignal): Promise<void> {
	await Promise.all([
		deps.cleanSnapshots({ root, olderThanMs: STALE_REVIEW_AGE_MS, signal }),
		deps.recoverWorktrees({ olderThanMs: STALE_REVIEW_AGE_MS, signal }),
	])
}

interface BareTargetSelection {
	request?: ExplicitReviewRequest
	message?: string
}

export async function selectBareTarget(
	request: BareReviewRequest,
	ctx: ExtensionCommandContext,
	deps: Pick<ReviewCommandDependencies, "choices">,
): Promise<BareTargetSelection> {
	const choices = await deps.choices(request, {
		root: ctx.cwd,
		excludedDirectories: reviewOwnedDirectories(cliDirectories(ctx)),
	})
	// ACP intentionally uses explicit syntax rather than a picker. Every other
	// headless frontend gets the same deterministic fallback; only a real TUI picks.
	if (!ctx.hasUI || getParsedCliArgs().options.mode !== undefined) {
		return {
			message:
				"Choose an explicit review target:\n" +
				choices.syntax.join("\n") +
				(choices.choices[1].baseSuggestion
					? `\nSuggested branch base: ${choices.choices[1].baseSuggestion.ref}`
					: "\nNo unique base was resolved; --base is required for a branch review."),
		}
	}
	const branch = choices.choices[1]
	const ordered = [...choices.choices].sort((left, right) => Number(right.preselected) - Number(left.preselected))
	const labels = ordered.map(
		(choice) =>
			`${choice.kind === "working-tree" ? "Working tree" : "Branch"}${choice.preselected ? " (default)" : ""}`,
	)
	const picked = await ctx.ui.select("Review target", labels)
	if (!picked) return {}
	const selected = ordered[labels.indexOf(picked)]
	if (selected?.kind === "working-tree") {
		return { request: { kind: "working-tree", fetch: request.fetch, panel: request.panel } }
	}
	const branchRef = await ctx.ui.input("Branch ref to review", "feature or origin/feature")
	if (!branchRef?.trim()) return {}
	const baseRef = await ctx.ui.input("Base ref", branch.baseSuggestion?.ref ?? "--base is required")
	if (!baseRef?.trim() && !branch.baseSuggestion?.ref) return {}
	return {
		request: {
			kind: "branch",
			branch: branchRef.trim(),
			base: baseRef?.trim() || branch.baseSuggestion?.ref,
			includeWorkingTree: false,
			fetch: request.fetch,
			panel: request.panel,
		},
	}
}

function manifestSyntax(args: string[]): { path: string; panelArgs: string[] } | undefined {
	if (args[0] !== "--manifest" && !args[0]?.startsWith("--manifest=")) return undefined
	let path: string
	let rest: string[]
	if (args[0] === "--manifest") {
		if (!args[1]) throw invalid("--manifest requires an absolute path.")
		path = args[1]
		rest = args.slice(2)
	} else {
		path = args[0].slice("--manifest=".length)
		rest = args.slice(1)
	}
	if (!path) throw invalid("--manifest requires an absolute path.")
	return { path, panelArgs: rest }
}

function assertHeadlessProtocol(): void {
	if (!reviewCliEnabled() || !jsonPrintEnabled()) {
		throw invalid("Manifest and wrap-up review commands require --review and print JSON mode.")
	}
	if ((getParsedCliArgs().options["review-writer"] ?? "final") !== "final") {
		throw invalid("Panel entry points require --review-writer final.")
	}
}

function matchDirectories(
	prepared: PreparedReviewManifest,
	directories: ReturnType<typeof resolveReviewDirectories>,
): void {
	if (
		directories.contextDir !== prepared.manifest.context_dir ||
		directories.outputDir !== prepared.manifest.output_dir
	) {
		throw new ReviewTargetError(
			"manifest_directory_mismatch",
			"Manifest context_dir and output_dir must exactly match --review-context-dir and --review-output-dir.",
		)
	}
}

function manifestPathForLog(args: string[]): string {
	return args[0] === "--manifest" ? (args[1] ?? "<required>") : args[0]?.slice("--manifest=".length) || "<required>"
}

async function runHeadless(
	args: string[],
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	deps: ReviewCommandDependencies,
	resumed: boolean,
): Promise<void> {
	await configureReviewPrintStream(reviewCliEnabled() && jsonPrintEnabled())
	emitReviewSystemMessage(ctx, pi)
	assertHeadlessProtocol()
	const wrapUp = args[0] === "wrap-up"
	if (wrapUp && (args.length !== 1 || !resumed)) {
		throw invalid("/review wrap-up requires a resumed review session and takes no arguments.")
	}
	const parsedManifest = wrapUp ? undefined : manifestSyntax(args)
	if (!wrapUp && !parsedManifest) throw invalid("Print review panels require /review --manifest <path>.")
	// Persist the protocol input at a message boundary without starting a model
	// turn or adding it to the JSON stream. SessionManager requires a user or
	// assistant message before it can create a resumable root session file.
	const sessionManager = ctx.sessionManager as unknown as Pick<SessionManager, "appendMessage">
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: wrapUp ? "/review wrap-up" : `/review --manifest ${manifestPathForLog(args)}` }],
		timestamp: Date.now(),
	})
	const dirs = cliDirectories(ctx)
	const manifestPath = parsedManifest?.path ?? join(dirs.contextDir, REVIEW_MANIFEST_FILENAME)
	const manifest = await deps.readManifest(manifestPath)
	const termination = startReviewPrintTermination({ deadlineMs: Date.parse(manifest.deadline), abort: () => {} })
	const report = reporter(ctx, false)
	try {
		const prepared = await deps.prepareManifest(manifest, termination.signal)
		matchDirectories(prepared, dirs)
		const tools = new Set(pi.getAllTools().map((tool) => tool.name))
		for (const required of ["submit_finding", "submit_summary", "submit_reply"]) {
			if (!tools.has(required))
				throw new ReviewTargetError("missing_submit_tool", `Review startup is missing ${required}.`)
		}
		const settings = deps.readSettings(pi)
		report.scope(prepared.target)
		if (wrapUp) {
			const result = await deps.wrapUp({
				ctx,
				pi,
				outputDir: prepared.manifest.output_dir,
				expected: {
					baseSha: prepared.manifest.base_sha,
					headSha: prepared.manifest.head_sha,
					checkoutPath: prepared.manifest.checkout_path,
					contextDir: prepared.manifest.context_dir,
					outputDir: prepared.manifest.output_dir,
				},
				...settings,
				checkDefinitions: settings.checkDefinitions,
				environmentGaps: headlessEnvironmentGaps(),
				deadline: prepared.deadlineMs,
				executionPolicy: { mode: "headless" },
				signal: termination.signal,
				onProgress: report.progress,
				onChildUsage: (usage) => emitReviewChildUsage(usage),
			})
			report.result(result)
			return
		}
		const targetRequest = deps.parseTarget(parsedManifest?.panelArgs ?? [])
		if (targetRequest.kind !== "bare") throw invalid("--manifest composes only with lens and concurrency options.")
		const selection = deps.resolvePanel({
			...targetRequest.panel,
			requiredLenses: settings.requiredLenses,
		})
		report.selection(selection)
		await staleSweep(prepared.manifest.checkout_path, deps, termination.signal)
		const result = await deps.runPanel({
			ctx,
			pi,
			target: prepared.target,
			outputDir: prepared.manifest.output_dir,
			...targetRequest.panel,
			requiredLenses: settings.requiredLenses,
			checkDefinitions: settings.checkDefinitions,
			environmentGaps: headlessEnvironmentGaps(),
			deadline: prepared.deadlineMs,
			executionPolicy: { mode: "headless" },
			signal: termination.signal,
			onProgress: report.progress,
			onChildUsage: (usage) => emitReviewChildUsage(usage),
		})
		report.result(result)
	} catch (error) {
		report.error(error)
		printReviewError(error)
		process.exitCode = termination.signal.aborted ? 143 : 1
	} finally {
		await termination.finish()
	}
}

async function runLocal(
	args: string[],
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	deps: ReviewCommandDependencies,
): Promise<void> {
	const parsed = deps.parseTarget(args)
	if (parsed.kind !== "bare" && args.some((arg) => arg === "--manifest" || arg.startsWith("--manifest="))) {
		throw invalid("--manifest is available only in a --review print JSON session.")
	}
	await staleSweep(ctx.cwd, deps)
	let request: ExplicitReviewRequest
	if (parsed.kind === "bare") {
		const selected = await selectBareTarget(parsed, ctx, deps)
		if (selected.message) {
			notify(ctx, selected.message)
			return
		}
		if (!selected.request) return
		request = selected.request
	} else {
		request = parsed
	}
	const settings = deps.readSettings(pi)
	const directories = cliDirectories(ctx)
	const target = await deps.resolveTarget(request, {
		root: ctx.cwd,
		contextDir: directories.contextDir,
		excludedDirectories: reviewOwnedDirectories(directories),
	})
	const report = reporter(ctx, true)
	let operation: ReviewOperation | undefined
	try {
		const outputDir = await createLocalReviewRunDirectory(directories.outputDir)
		operation = await acquireReviewOperation(ctx, target.scope.checkoutPath, outputDir)
		report.scope(target, outputDir)
		const selection = deps.resolvePanel({ ...request.panel, requiredLenses: settings.requiredLenses })
		report.selection(selection)
		const result = await deps.runPanel({
			ctx,
			pi,
			target,
			outputDir,
			...request.panel,
			requiredLenses: settings.requiredLenses,
			checkDefinitions: settings.checkDefinitions,
			signal: operation.signal,
			submitGraceMs: 1_000,
			onProgress: report.progress,
		})
		report.result(result)
	} catch (error) {
		report.error(error)
	} finally {
		try {
			await target.cleanup().catch(() => {})
		} finally {
			await operation?.finish()
		}
	}
}

export async function runReviewCommand(
	rawArgs: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	options: { resumed?: boolean; dependencies?: Partial<ReviewCommandDependencies> } = {},
): Promise<void> {
	const deps = { ...dependencies, ...options.dependencies }
	try {
		const args = tokenize(rawArgs)
		const headless = ["wrap-up", "--manifest"].includes(args[0] ?? "") || Boolean(args[0]?.startsWith("--manifest="))
		if (headless) await runHeadless(args, ctx, pi, deps, options.resumed === true)
		else await runLocal(args, ctx, pi, deps)
	} catch (error) {
		if (isPrintModeEnabled()) {
			printReviewError(error)
			if (reviewCliEnabled() && jsonPrintEnabled()) {
				emitReviewAgentSettled()
				await flushReviewPrintEvents()
			}
			process.exitCode = 1
		} else {
			reporter(ctx, true).error(error)
		}
	}
}

/** Test seam for manifest-preparation dispatch without loading the extension. */
export { loadPreparedReviewManifest }
