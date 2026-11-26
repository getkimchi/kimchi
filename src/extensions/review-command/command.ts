import { join } from "node:path"
import type { ExtensionAPI, ExtensionCommandContext, SessionManager } from "@earendil-works/pi-coding-agent"
import { truncateToWidth } from "@earendil-works/pi-tui"
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
	type ReviewBaseSuggestion,
	type ReviewBranchRevisionChoice,
	type ReviewTargetInteractions,
	resolveReviewTarget,
} from "../review-targets/index.js"
import { ReviewTargetError } from "../review-targets/types.js"
import {
	acquireReviewOperation,
	cancelActiveReview,
	type ReviewOperation,
	registerPendingReview,
} from "./active-runs.js"
import { headlessEnvironmentGaps } from "./environment-gaps.js"
import {
	loadPreparedReviewManifest,
	type PreparedReviewManifest,
	prepareReviewManifestTarget,
	REVIEW_MANIFEST_FILENAME,
	readReviewManifest,
} from "./manifest.js"
import {
	mountReviewProgressComponent,
	type ReviewProgressModel,
	stopReviewProgressAnimation,
} from "./progress-widget.js"
import { REVIEW_RESULT_CUSTOM_TYPE, renderReviewResult, reviewResultDetails } from "./result-message.js"
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
	result: (result: Pick<ReviewPanelResult, "progress" | "findings" | "summaryPath">) => void
	error: (error: unknown) => void
}

function notify(ctx: ExtensionCommandContext, message: string, severity: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, severity)
}

const REVIEW_WIDGET_OPTIONS = { placement: "aboveEditor" } as const

function clearReviewWidget(ctx: ExtensionCommandContext): void {
	stopReviewProgressAnimation(ctx)
	if (ctx.hasUI && ctx.mode === "tui") ctx.ui.setWidget("review-panel", undefined, REVIEW_WIDGET_OPTIONS)
}

// Matches the original ACP string-array widget lifecycle; component factories
// and the custom result-message renderer remain local to the real TUI.
function nonTuiWidgetLine(value: string): string {
	return truncateToWidth(value, 52, "…")
}

function reviewResultSummary(result: Pick<ReviewPanelResult, "progress" | "findings" | "summaryPath">): string[] {
	const coverage = result.progress.coverage
	return [
		`Review ${coverage.status}: ${result.findings.length} final finding${result.findings.length === 1 ? "" : "s"}.`,
		coverage.unfinished_lenses.length
			? `Partial coverage; unfinished lenses: ${coverage.unfinished_lenses.join(", ")}.`
			: "Complete review coverage.",
	]
}

function nonTuiReporter(ctx: ExtensionCommandContext, visible: boolean): Reporter {
	let scopeLines: string[] = []
	let selectionLines: string[] = []
	let progressLines: string[] = []
	const paint = (resultLines: string[] = []) => {
		if (!visible) return
		ctx.ui.setWidget(
			"review-panel",
			[...scopeLines, ...selectionLines, ...progressLines, ...resultLines].map(nonTuiWidgetLine),
			{ placement: "aboveEditor" },
		)
	}
	return {
		scope(target, runDirectory) {
			if (!visible) return
			const scope = target.scope
			scopeLines = [`Review ${scope.kind}; ${scope.files.changed} changed files`]
			notify(
				ctx,
				[
					"Review scope pinned:",
					`${scope.pinned.baseSha}..${scope.pinned.headSha}`,
					`Checkout: ${scope.checkoutPath}`,
					...(runDirectory ? [`Run directory: ${runDirectory}`] : []),
				].join("\n"),
			)
			paint()
		},
		selection(selection) {
			if (!visible) return
			selectionLines = [`Lenses: ${selection.lenses.length}; concurrency ${selection.slotCount}`]
			notify(
				ctx,
				[
					"Review lenses:",
					...selection.lenses.map((lens) => `${lens.id} (${lens.reasons.join("; ")})`),
					`Effective concurrency: ${selection.slotCount}`,
				].join("\n"),
			)
			paint()
		},
		progress(progress) {
			if (progress.phase === "finalizing") return
			progressLines = [
				`Review ${progress.phase}; ${progress.counts.candidates} candidates; recon ${progress.reconciliation.status}`,
				...progress.lenses.map(
					(lens) =>
						`${lens.status === "running" ? "▶" : lens.status === "submitted" ? "✓" : lens.status === "queued" ? "○" : "×"} ${lens.id}: ${lens.status} (${lens.candidateCount})`,
				),
			]
			paint()
		},
		result(result) {
			if (!visible) return
			const findings = result.findings.length
				? result.findings.map((finding) => `${finding.priority} ${finding.path}:${finding.line} ${finding.title}`)
				: ["No findings."]
			const summary = reviewResultSummary(result)
			// Keep complete findings in scrollback; the live widget shrinks to a summary.
			scopeLines = []
			selectionLines = []
			progressLines = []
			paint(summary)
			notify(ctx, [...summary, ...findings, `Report: ${result.summaryPath}`].join("\n"))
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

export function reporter(ctx: ExtensionCommandContext, visible: boolean, pi: ExtensionAPI): Reporter {
	if (ctx.mode !== "tui") return nonTuiReporter(ctx, visible)
	return tuiReporter(ctx, visible, pi)
}

function tuiReporter(ctx: ExtensionCommandContext, visible: boolean, pi: ExtensionAPI): Reporter {
	let target: ResolvedReviewTarget | undefined
	let model: ReviewProgressModel | undefined
	const showWidget = visible && ctx.hasUI && ctx.mode === "tui"
	const paint = () => {
		if (!showWidget || !model) return
		ctx.ui.setWidget(
			"review-panel",
			(tui, theme) => mountReviewProgressComponent(ctx, tui, theme, () => model as ReviewProgressModel),
			REVIEW_WIDGET_OPTIONS,
		)
	}
	return {
		scope(nextTarget) {
			if (!visible) return
			target = nextTarget
			model = { target: nextTarget }
			paint()
		},
		selection(selection) {
			if (!visible || !model) return
			model = { ...model, selection }
			paint()
		},
		progress(progress) {
			if (!visible || !model) return
			model = { ...model, progress }
			paint()
		},
		result(result) {
			if (!visible) return
			if (showWidget) clearReviewWidget(ctx)
			if (!target) return
			const details = reviewResultDetails(target.scope, result, target.baseDisplayRef)
			// The registered renderer adds theme colors; content remains a complete
			// plain-text fallback for persistence and non-TUI consumers.
			pi.sendMessage({
				customType: REVIEW_RESULT_CUSTOM_TYPE,
				content: renderReviewResult(details),
				display: true,
				details,
			})
		},
		error(error) {
			if (!visible) return
			const message = `Review failed: ${error instanceof Error ? error.message : String(error)}`
			if (model) {
				model = { ...model, error: message }
				paint()
			}
			notify(ctx, message, "error")
		},
	}
}

function friendlyRef(ref: string): string {
	return ref.replace(/^refs\/(?:heads|remotes)\//, "")
}

async function chooseDivergedBranch(
	ctx: ExtensionCommandContext,
	choice: ReviewBranchRevisionChoice,
	signal: AbortSignal,
): Promise<"local" | "remote" | undefined> {
	const counts = `${choice.local.ahead} ahead, ${choice.local.behind} behind`
	const local = `Review local ${choice.branch} (${counts}; ${choice.local.sha.slice(0, 7)})`
	const remote = `Review ${choice.remote}/${choice.branch} (${choice.remoteRevision.sha.slice(0, 7)})`
	const picked = await ctx.ui.select(`Review local ${choice.branch} (${counts})?`, [local, remote], { signal })
	signal.throwIfAborted()
	return picked === local ? "local" : picked === remote ? "remote" : undefined
}

async function chooseReviewBase(
	ctx: ExtensionCommandContext,
	choice: { branch: string; candidates: ReviewBaseSuggestion[] },
	signal: AbortSignal,
): Promise<string | undefined> {
	const chooseAnother = "Choose another base"
	if (choice.candidates.length === 1) {
		const candidate = choice.candidates[0]
		const yes = `Yes, use ${friendlyRef(candidate.ref)}`
		const picked = await ctx.ui.select(
			`Review ${choice.branch} against ${friendlyRef(candidate.resolvedRef ?? candidate.ref)}?`,
			[yes, chooseAnother],
			{ signal },
		)
		signal.throwIfAborted()
		if (picked === yes) return candidate.ref
		if (picked !== chooseAnother) return undefined
	}
	const enterBase = "Enter another base"
	const labels = [...choice.candidates.map((candidate) => friendlyRef(candidate.ref)), enterBase]
	const picked = await ctx.ui.select(`Base for ${choice.branch}`, labels, { signal })
	signal.throwIfAborted()
	if (!picked) return undefined
	if (picked !== enterBase) {
		return choice.candidates.find((candidate) => friendlyRef(candidate.ref) === picked)?.ref
	}
	const enteredBase = await ctx.ui.input("Base ref", "main or origin/main", { signal })
	signal.throwIfAborted()
	return enteredBase?.trim() || undefined
}

export function reviewTargetInteractions(
	ctx: ExtensionCommandContext,
	signal: AbortSignal,
): ReviewTargetInteractions | undefined {
	if (!ctx.hasUI || ctx.mode !== "tui" || isPrintModeEnabled()) return undefined
	return {
		chooseBranchRevision: (choice) => chooseDivergedBranch(ctx, choice, signal),
		chooseBase: (choice) => chooseReviewBase(ctx, choice, signal),
	}
}

function surfaceNotice(ctx: ExtensionCommandContext, message: string, warning = false): void {
	if (isPrintModeEnabled() && !jsonPrintEnabled()) console.error(message)
	else notify(ctx, message, warning ? "warning" : "info")
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
	signal?: AbortSignal,
): Promise<BareTargetSelection> {
	const choices = await deps.choices(request, {
		root: ctx.cwd,
		excludedDirectories: reviewOwnedDirectories(cliDirectories(ctx)),
		signal,
	})
	const branch = choices.choices[1]
	if (branch?.kind !== "branch") {
		throw new ReviewTargetError(
			"invalid_target_choices",
			"Review target discovery did not provide the required branch choice.",
		)
	}
	// ACP intentionally uses explicit syntax rather than a picker. Every other
	// headless frontend gets the same deterministic fallback; only a real TUI picks.
	if (!ctx.hasUI || getParsedCliArgs().options.mode !== undefined) {
		return {
			message:
				"Choose an explicit review target:\n" +
				choices.syntax.join("\n") +
				(branch.baseSuggestion
					? `\nSuggested branch base: ${branch.baseSuggestion.ref}`
					: "\nNo unique base was resolved; --base is required for a branch review."),
		}
	}
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
	if (baseRef === undefined) return {}
	if (!baseRef.trim() && !branch.baseSuggestion?.ref) return {}
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
	const report = reporter(ctx, false, pi)
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
	const pending = registerPendingReview(ctx)
	if (parsed.kind !== "bare") pending.captureInput()
	try {
		let deferredSweep = parsed.kind === "pull-request"
		try {
			await staleSweep(ctx.cwd, deps, pending.signal)
			deferredSweep = false
		} catch (error) {
			if (!deferredSweep || !(error instanceof ReviewTargetError) || error.code !== "not_a_worktree") throw error
		}
		let request: ExplicitReviewRequest
		if (parsed.kind === "bare") {
			const selected = await selectBareTarget(parsed, ctx, deps, pending.signal)
			if (selected.message) {
				if (isPrintModeEnabled()) throw invalid(selected.message)
				notify(ctx, selected.message)
				return
			}
			if (!selected.request) return
			request = selected.request
		} else {
			request = parsed
		}
		// Bare pickers own Esc themselves; begin review cancellation once the
		// picker is gone and before target snapshots or lock acquisition.
		pending.captureInput()
		const settings = deps.readSettings(pi)
		const directories = cliDirectories(ctx)
		const target = await deps.resolveTarget(request, {
			root: ctx.cwd,
			contextDir: directories.contextDir,
			excludedDirectories: reviewOwnedDirectories(directories),
			interactions: reviewTargetInteractions(ctx, pending.signal),
			signal: pending.signal,
			onCacheCompromised: (error) => {
				void cancelActiveReview(ctx.sessionManager.getSessionId(), error.message)
			},
			onBaseSelected: (suggestion) => surfaceNotice(ctx, `Using base ${friendlyRef(suggestion.ref)}.`),
			onWarning: (message) => surfaceNotice(ctx, message, true),
		})
		const report = reporter(ctx, !isPrintModeEnabled(), pi)
		let operation: ReviewOperation | undefined
		try {
			pending.signal.throwIfAborted()
			const run = await createLocalReviewRunDirectory(directories.outputDir)
			operation = await acquireReviewOperation(ctx, target.scope.checkoutPath, run, undefined, pending.signal)
			// Transfer terminal ownership. Otherwise the pending listener consumes
			// the key and the panel's distinct active controller never aborts.
			pending.releaseInput()
			operation.signal.throwIfAborted()
			if (deferredSweep) await staleSweep(target.scope.checkoutPath, deps, operation.signal)
			report.scope(target, run.runDir)
			const selection = deps.resolvePanel({ ...request.panel, requiredLenses: settings.requiredLenses })
			report.selection(selection)
			const result = await deps.runPanel({
				ctx,
				pi,
				target,
				outputDir: run.runDir,
				...request.panel,
				requiredLenses: settings.requiredLenses,
				checkDefinitions: settings.checkDefinitions,
				signal: operation.signal,
				submitGraceMs: 1_000,
				onProgress: report.progress,
			})
			report.result(result)
			if (isPrintModeEnabled()) {
				console.log([...reviewResultSummary(result), `Report: ${result.summaryPath}`].join("\n"))
			}
		} catch (error) {
			if (isPrintModeEnabled()) throw error
			report.error(error)
		} finally {
			try {
				await target.cleanup().catch(() => {})
			} finally {
				await operation?.finish()
			}
		}
	} finally {
		pending.finish()
	}
}

export async function runReviewCommand(
	rawArgs: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	options: { resumed?: boolean; allowLocal?: boolean; dependencies?: Partial<ReviewCommandDependencies> } = {},
): Promise<void> {
	const deps = { ...dependencies, ...options.dependencies }
	try {
		const args = tokenize(rawArgs)
		const headless = ["wrap-up", "--manifest"].includes(args[0] ?? "") || Boolean(args[0]?.startsWith("--manifest="))
		if (headless) await runHeadless(args, ctx, pi, deps, options.resumed === true)
		else if (options.allowLocal === false) {
			throw invalid("Local /review targets require --enable-experimental-features; use --manifest or wrap-up.")
		} else await runLocal(args, ctx, pi, deps)
	} catch (error) {
		if (isPrintModeEnabled() || !ctx.hasUI || ctx.mode === "print" || ctx.mode === "json") {
			printReviewError(error)
			if (reviewCliEnabled() && jsonPrintEnabled()) {
				emitReviewAgentSettled()
				await flushReviewPrintEvents()
			}
			process.exitCode = 1
		} else {
			reporter(ctx, true, pi).error(error)
		}
	} finally {
		clearReviewWidget(ctx)
	}
}

/** Test seam for manifest-preparation dispatch without loading the extension. */
export { loadPreparedReviewManifest }
