import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import { test } from "@microsoft/tui-test"
import type { Terminal } from "@microsoft/tui-test/lib/terminal/term.js"
import { STARTUP_TIMEOUT_MS, fullText, viewText, waitForText } from "./support/assertions.js"
import { PROMPT_READY, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import {
	type LiveKimchiFixture,
	appendLiveEvent,
	appendLiveTerminalObservation,
	createLiveKimchiFixture,
	exportLatestSessionHtml,
	launchLiveKimchi,
	snapshotWorkspace,
	stopLiveKimchi,
	writeLiveArtifact,
} from "./support/live-kimchi-fixture.js"
import {
	type LiveKey,
	type SupervisorDecision,
	normalizeSupervisorDecision,
	questionnaireNavigationDecision,
} from "./support/live-user-agent.js"

test.use(TUI_TEST_CONFIG)

const LIVE_ENABLED = process.env.KIMCHI_TUI_LIVE_EVAL === "1" && Boolean(process.env.KIMCHI_API_KEY)
const liveTest = LIVE_ENABLED ? test : test.skip
const TASK =
	process.env.KIMCHI_TUI_LIVE_TASK ?? "Build a Python application that prints hello world in 5 European languages."
const LIVE_EVAL_DEFAULTS = {
	loopTimeoutMs: 20 * 60 * 1000,
	stallTimeoutMs: 3 * 60 * 1000,
	semanticStallTimeoutMs: 2 * 60 * 1000,
	metaLlmTimeoutMs: 45_000,
	healthJudgeAttempts: 2,
	healthJudgeRetryDelayMs: 2000,
	userSimulatorAttempts: 2,
	userSimulatorRetryDelayMs: 2000,
}
const LOOP_TIMEOUT_MS = positiveInteger(process.env.KIMCHI_TUI_LIVE_TIMEOUT_MS, LIVE_EVAL_DEFAULTS.loopTimeoutMs)
const STALL_TIMEOUT_MS = positiveInteger(
	process.env.KIMCHI_TUI_LIVE_STALL_TIMEOUT_MS,
	LIVE_EVAL_DEFAULTS.stallTimeoutMs,
)
const SEMANTIC_STALL_TIMEOUT_MS = positiveInteger(
	process.env.KIMCHI_TUI_LIVE_SEMANTIC_STALL_TIMEOUT_MS,
	LIVE_EVAL_DEFAULTS.semanticStallTimeoutMs,
)
const META_LLM_TIMEOUT_MS = positiveInteger(
	process.env.KIMCHI_TUI_LIVE_LLM_TIMEOUT_MS,
	LIVE_EVAL_DEFAULTS.metaLlmTimeoutMs,
)
const HEALTH_JUDGE_ATTEMPTS = positiveInteger(
	process.env.KIMCHI_TUI_LIVE_HEALTH_JUDGE_ATTEMPTS,
	LIVE_EVAL_DEFAULTS.healthJudgeAttempts,
)
const HEALTH_JUDGE_RETRY_DELAY_MS = positiveInteger(
	process.env.KIMCHI_TUI_LIVE_HEALTH_JUDGE_RETRY_DELAY_MS,
	LIVE_EVAL_DEFAULTS.healthJudgeRetryDelayMs,
)
const USER_SIMULATOR_ATTEMPTS = positiveInteger(
	process.env.KIMCHI_TUI_LIVE_USER_SIMULATOR_ATTEMPTS,
	LIVE_EVAL_DEFAULTS.userSimulatorAttempts,
)
const USER_SIMULATOR_RETRY_DELAY_MS = positiveInteger(
	process.env.KIMCHI_TUI_LIVE_USER_SIMULATOR_RETRY_DELAY_MS,
	LIVE_EVAL_DEFAULTS.userSimulatorRetryDelayMs,
)

liveTest("live ferment workflow builds a python hello-world app", async ({ terminal }) => {
	const fixture = createLiveKimchiFixture("live-ferment-workflow")
	const decisions: SupervisorDecision[] = []
	let notes: unknown = { decisions }
	let outcome: "pass" | "fail" = "fail"
	let caught: unknown

	try {
		appendLiveEvent(fixture, { type: "run_start", task: TASK })
		launchLiveKimchi(terminal, fixture)
		appendLiveEvent(fixture, { type: "binary_launched", provider: fixture.provider, model: fixture.model })
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS })
		appendLiveEvent(fixture, { type: "prompt_ready" })
		appendLiveTerminalObservation(fixture, terminal, { type: "prompt_ready" })

		const command = formatFermentNewCommand(TASK)
		const beforeSubmit = viewText(terminal)
		terminal.submit(command)
		appendLiveEvent(fixture, { type: "task_submitted", command })
		await waitForInitialActivity(terminal, fixture, beforeSubmit)
		await superviseFermentRun(terminal, fixture, decisions)

		appendLiveEvent(fixture, { type: "running_python_app" })
		const appRun = runPythonApp(fixture)
		appendLiveEvent(fixture, { type: "python_app_result", appRun })
		const judge = await judgeFinalResult({ fixture, terminal, task: TASK, appRun })
		appendLiveEvent(fixture, { type: "judge_result", judge })
		notes = { decisions, appRun, judge }
		if (!judge.passed) {
			throw new Error(`Judge failed live Ferment run: ${judge.summary}`)
		}
		outcome = "pass"
	} catch (error) {
		caught = error
		appendLiveEvent(fixture, {
			type: "run_error",
			error: formatUnknownError(error),
			failureKind: classifyLiveEvalFailure(error),
		})
		throw error
	} finally {
		await stopLiveKimchi(terminal, fixture)
		const htmlExport = exportLatestSessionHtml(fixture)
		const workspaceSnapshot = snapshotWorkspace(fixture)
		const sessionArtifacts = listSessionArtifacts(fixture)
		const terminalTranscript = fixture.terminalTranscriptPath
		appendLiveEvent(fixture, {
			type: "artifacts_written",
			outcome,
			htmlExport,
			workspaceSnapshot,
			sessionArtifacts,
			terminalTranscript,
		})
		writeLiveArtifact({
			name: "live-ferment-workflow",
			outcome,
			terminal,
			fixture,
			error: caught,
			notes: { notes, htmlExport, workspaceSnapshot, sessionArtifacts, terminalTranscript },
		})
	}
})

type ScreenActivity = "busy" | "needs_user" | "idle" | "complete" | "unknown"
type ScreenIssueKind = "bug" | "infra" | "unknown"
type ScreenIssueSeverity = "fatal" | "recoverable" | "watch"
type LiveEvalFailureKind = "product" | "infra" | "user_simulator" | "health_judge" | "final_judge" | "harness"

interface AppRunResult {
	command?: string
	stdout: string
	stderr: string
	error?: string
}

interface JudgeVerdict {
	passed: boolean
	summary: string
	issues: string[]
}

interface RuntimeHealthVerdict {
	state: "healthy" | "stall" | "error"
	summary: string
	evidence: string[]
}

interface ScreenIssue {
	kind: ScreenIssueKind
	severity: ScreenIssueSeverity
	reason: string
	evidence: string
}

interface ScreenAssessment {
	activity: ScreenActivity
	reason: string
	issues: ScreenIssue[]
}

interface DecisionRepeatState {
	signature: string
	semanticScreen: string
	count: number
}

interface SuppressedDecision {
	signature: string
	semanticScreen: string
}

class LiveEvalError extends Error {
	constructor(
		readonly kind: LiveEvalFailureKind,
		message: string,
		readonly cause?: unknown,
	) {
		super(message)
		this.name = "LiveEvalError"
	}
}

async function waitForInitialActivity(
	terminal: Terminal,
	fixture: LiveKimchiFixture,
	beforeSubmit: string,
): Promise<void> {
	const runStartedAt = Date.now()
	while (Date.now() - runStartedAt < 30_000) {
		const screen = viewText(terminal)
		if (
			screen !== beforeSubmit &&
			/Started ferment|Fermenting|Create a Ferment workflow|Phase changed|Propose Ferment|Scoping|Rinsing|Reducing|hello world/i.test(
				screen,
			)
		) {
			appendLiveEvent(fixture, {
				type: "initial_activity_seen",
				durationMs: Date.now() - runStartedAt,
				screenTail: screen.slice(-1200),
			})
			return
		}
		await sleep(250)
	}
	appendLiveEvent(fixture, { type: "initial_activity_timeout", durationMs: Date.now() - runStartedAt })
}

async function superviseFermentRun(
	terminal: Terminal,
	fixture: LiveKimchiFixture,
	decisions: SupervisorDecision[],
): Promise<void> {
	const deadline = Date.now() + LOOP_TIMEOUT_MS
	const startedAt = Date.now()
	let lastScreen = ""
	let lastSemanticScreen = ""
	let lastChangeAt = Date.now()
	let lastSemanticChangeAt = Date.now()
	let lastDecisionAt = 0
	let actions = 0
	let iterations = 0
	let lastBusyLogAt = 0
	let fermentSeen = false
	let lastTerminalTranscript = ""
	const repeatedDecision: DecisionRepeatState = { signature: "", semanticScreen: "", count: 0 }
	let suppressedKnownDecision: SuppressedDecision | undefined
	const loggedIssueKeys = new Set<string>()

	while (Date.now() < deadline) {
		iterations += 1
		const screen = viewText(terminal)
		const terminalTranscript = fullText(terminal)
		if (terminalTranscript !== lastTerminalTranscript) {
			lastTerminalTranscript = terminalTranscript
			appendLiveTerminalObservation(fixture, terminal, {
				type: "terminal_changed",
				iteration: iterations,
				fullChars: terminalTranscript.length,
				viewChars: screen.length,
			})
		}
		const semanticScreen = normalizeScreenForProgress(screen)
		if (hasFermentWorkflowEvidence(screen)) fermentSeen = true
		if (screen !== lastScreen) {
			lastScreen = screen
			lastChangeAt = Date.now()
			appendLiveEvent(fixture, {
				type: "screen_changed",
				iteration: iterations,
				screenChars: screen.length,
				screenTail: screen.slice(-1200),
			})
		}
		if (semanticScreen !== lastSemanticScreen) {
			lastSemanticScreen = semanticScreen
			lastSemanticChangeAt = Date.now()
			appendLiveEvent(fixture, {
				type: "semantic_screen_changed",
				iteration: iterations,
				semanticChars: semanticScreen.length,
				semanticTail: semanticScreen.slice(-1200),
			})
		}

		const assessment = assessScreen(screen, {
			fermentSeen,
			elapsedMs: Date.now() - startedAt,
			workDir: fixture.workDir,
		})
		for (const issue of assessment.issues) {
			logScreenIssueOnce(fixture, loggedIssueKeys, issue, { iteration: iterations })
			if (issue.kind === "infra" && issue.severity === "fatal") {
				throw new LiveEvalError("infra", issue.reason)
			}
			if (issue.kind === "bug" && issue.severity === "fatal") {
				throw new Error(issue.reason)
			}
		}
		if (Date.now() - lastChangeAt > STALL_TIMEOUT_MS) {
			const issue: ScreenIssue = {
				kind: "unknown",
				severity: "fatal",
				reason: `Live Ferment run stalled for ${STALL_TIMEOUT_MS}ms`,
				evidence: screen.slice(-1200),
			}
			logScreenIssueOnce(fixture, loggedIssueKeys, issue, { iteration: iterations })
			throw new Error(issue.reason)
		}
		if (Date.now() - lastSemanticChangeAt > SEMANTIC_STALL_TIMEOUT_MS) {
			const health = await judgeRuntimeHealth({
				fixture,
				screen,
				reason: `No semantic progress for ${SEMANTIC_STALL_TIMEOUT_MS}ms`,
			})
			appendLiveEvent(fixture, { type: "runtime_health_judge_result", health })
			if (health.state !== "healthy") {
				throw new Error(`Runtime health judge detected ${health.state}: ${health.summary}`)
			}
			lastSemanticChangeAt = Date.now()
		}

		if (assessment.activity === "complete") return

		const known = assessment.activity === "needs_user" ? knownFermentControl(screen) : undefined
		if (known && !isSuppressedKnownDecision(known, semanticScreen, suppressedKnownDecision)) {
			decisions.push(known)
			appendLiveEvent(fixture, { type: "known_control_decision", iteration: iterations, decision: known })
			const repeated = await guardRepeatedDecision({
				fixture,
				screen,
				semanticScreen,
				state: repeatedDecision,
				decision: known,
				source: "known_control",
			})
			if (repeated) {
				suppressedKnownDecision = { signature: repeated.signature, semanticScreen }
				appendLiveEvent(fixture, {
					type: "known_control_suppressed",
					iteration: iterations,
					signature: repeated.signature,
					reason: "Deterministic UI action repeated without progress; falling back to supervisor LLM.",
				})
				lastDecisionAt = 0
				continue
			}
			await applyDecision(terminal, known)
			actions += 1
			await sleep(1200)
			continue
		}

		if (assessment.activity === "busy") {
			if (Date.now() - lastBusyLogAt > 10_000) {
				lastBusyLogAt = Date.now()
				appendLiveEvent(fixture, {
					type: "busy_wait",
					iteration: iterations,
					reason: assessment.reason,
					screenTail: screen.slice(-1200),
				})
			}
			await sleep(2000)
			continue
		}

		if (Date.now() - lastDecisionAt < 7000) {
			await sleep(1000)
			continue
		}
		lastDecisionAt = Date.now()

		const decisionStartedAt = Date.now()
		const decision = await askSupervisor({ task: TASK, screen, fixture })
		appendLiveEvent(fixture, {
			type: "supervisor_decision",
			iteration: iterations,
			durationMs: Date.now() - decisionStartedAt,
			decision,
		})
		decisions.push(decision)
		await guardRepeatedDecision({
			fixture,
			screen,
			semanticScreen,
			state: repeatedDecision,
			decision,
			source: "supervisor_llm",
		})
		if (decision.action === "complete") return
		if (decision.action === "fail") throw new Error(`Supervisor failed live Ferment run: ${decision.reason}`)
		if (decision.action !== "wait") {
			await applyDecision(terminal, decision)
			actions += 1
		}
		if (actions > 80) throw new Error("Supervisor exceeded 80 terminal actions")
		await sleep(1000)
	}

	throw new Error(`Live Ferment run exceeded ${LOOP_TIMEOUT_MS}ms`)
}

function knownFermentControl(screen: string): SupervisorDecision | undefined {
	const questionnaireNavigation = questionnaireNavigationDecision(screen)
	if (questionnaireNavigation) return questionnaireNavigation
	if (/Planned · Stop: Phase Boundary/i.test(screen) && /\/ferment auto/i.test(screen)) {
		return { action: "submit", answer: "/ferment auto", reason: "Continue the active Ferment past a phase boundary." }
	}
	if (/Yes, this looks right|Yes, looks good/.test(screen)) {
		return { action: "keys", keys: ["enter"], reason: "Accept the proposed Ferment scoping." }
	}
	if (/Proceed with this plan\?/i.test(screen) && />\s*Start execution/i.test(screen)) {
		return { action: "keys", keys: ["enter"], reason: "Start execution from the focused Ferment plan prompt." }
	}
	if (/Review the proposed phases/.test(screen) && /Confirm and start/.test(screen)) {
		if (/->\s*(?:✓\s*)?Confirm and start|→\s*(?:✓\s*)?Confirm and start/.test(screen)) {
			return { action: "keys", keys: ["enter"], reason: "Start the reviewed Ferment phases." }
		}
		return { action: "keys", keys: ["down"], reason: "Move focus toward Confirm and start." }
	}
	if (/Continue|Confirm|Start/.test(screen) && /->|→/.test(screen)) {
		return { action: "keys", keys: ["enter"], reason: "Accept the focused Ferment prompt option." }
	}
	return undefined
}

async function guardRepeatedDecision(input: {
	fixture: LiveKimchiFixture
	screen: string
	semanticScreen: string
	state: DecisionRepeatState
	decision: SupervisorDecision
	source: "known_control" | "supervisor_llm"
}): Promise<{ signature: string } | undefined> {
	const signature = decisionSignature(input.decision)
	if (signature === input.state.signature && input.semanticScreen === input.state.semanticScreen) {
		input.state.count += 1
	} else {
		input.state.signature = signature
		input.state.semanticScreen = input.semanticScreen
		input.state.count = 1
	}
	if (input.state.count < 3) return undefined
	appendLiveEvent(input.fixture, {
		type: "repeated_decision_detected",
		source: input.source,
		count: input.state.count,
		decision: input.decision,
		semanticTail: input.semanticScreen.slice(-1200),
	})
	if (input.source === "known_control") {
		input.state.count = 0
		return { signature }
	}
	const health = await judgeRuntimeHealth({
		fixture: input.fixture,
		screen: input.screen,
		reason: `Same ${input.source} decision repeated ${input.state.count} times without semantic progress: ${signature}`,
	})
	appendLiveEvent(input.fixture, { type: "runtime_health_judge_result", health })
	if (health.state !== "healthy") {
		throw new Error(`Runtime health judge detected ${health.state}: ${health.summary}`)
	}
	input.state.count = 0
	return undefined
}

function decisionSignature(decision: SupervisorDecision): string {
	return JSON.stringify({
		action: decision.action,
		answer: decision.answer ?? "",
		keys: decision.keys ?? [],
	})
}

function isSuppressedKnownDecision(
	decision: SupervisorDecision,
	semanticScreen: string,
	suppressed: SuppressedDecision | undefined,
): boolean {
	return Boolean(
		suppressed && suppressed.signature === decisionSignature(decision) && suppressed.semanticScreen === semanticScreen,
	)
}

function isAgentBusy(screen: string): boolean {
	if (/ask anything or type \/ for commands|❯/i.test(screen)) {
		return hasCurrentBusyIndicator(screen)
	}
	const busyPatterns = [
		/\bReducing\b/i,
		/\bRinsing\b/i,
		/\bCooking\b/i,
		/\bBraising\b/i,
		/\bStirring\b/i,
		/\bMarinating\b/i,
		/\bSalting\b/i,
		/\bBuilding\b/i,
		/\bChilling\b/i,
		/\bPrepping\b/i,
		/\bMassaging\b/i,
		/\bChopping\b/i,
		/\bMixing\b/i,
		/\bTasting\b/i,
		/\bResting\b/i,
		/\bLetting it rest\b/i,
		/\bGrinding\b/i,
		/\bThinking\b/i,
		/\bWorking\b/i,
		/\bSimmering\b/i,
		/▍\s*[○●◌]\s+[A-Z][^\n]+/,
		/○\s+\w.*\n/,
		/~\s+[A-Z][a-z]+/,
	]
	return busyPatterns.some((pattern) => pattern.test(screen))
}

function hasCurrentBusyIndicator(screen: string): boolean {
	const lines = screen
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
	const tipIndex = lines.findLastIndex((line) => /^Tip:/.test(line))
	const statusIndex = lines.findLastIndex((line) => /·\s*(?:Draft|Planned|Running|Completed|Paused)\s*·/.test(line))
	const end = tipIndex >= 0 ? tipIndex : statusIndex >= 0 ? statusIndex : lines.length
	const nearby = lines.slice(Math.max(0, end - 4), end).join("\n")
	return [
		/^[\s~\/\\|+\-`_·.○●◔◕◓◒❄✧zZ×ˊ▂▃█⠋⠇⠸⠧]*\s*(Working|Stirring|Marinating|Massaging|Chopping|Mixing|Tasting|Letting it rest|Rinsing|Reducing|Seasoning|Packing|Chilling|Simmering|Prepping|Cooking|Braising|Salting|Building|Grinding)/im,
		/\bthinking…/i,
		/\bthinking\.\.\./i,
	].some((pattern) => pattern.test(nearby))
}

function isPermissionPrompt(screen: string): boolean {
	return /The assistant wants to run(?: a compound command|:)|↑↓ navigate\s+enter select/i.test(screen)
}

function isQuestionnairePrompt(screen: string): boolean {
	return (
		/Tab\/←→ navigate|↑↓ navigate[\s\S]*Enter select|Type answer[\s\S]*Enter edit|Press Enter or start typing to answer|Ready to submit|✓ Submit/i.test(
			screen,
		) || /(?:\[[ xX]\]\s+\d+\.|Space toggle|Enter submit|↑↓\/1-9 navigate)/i.test(screen)
	)
}

function hasFermentWorkflowEvidence(screen: string): boolean {
	return /Propose Ferment|Ferment Scoping|would you like to ferment|Review the proposed phases|Confirm and start|completion criteria|ferment_id/i.test(
		screen,
	)
}

function assessScreen(
	screen: string,
	state: { fermentSeen: boolean; elapsedMs: number; workDir: string },
): ScreenAssessment {
	const issues = detectScreenIssues(screen, state)
	if (knownFermentControl(screen)) {
		return { activity: "needs_user", reason: "Terminal shows a known Ferment user prompt.", issues }
	}
	if (isQuestionnairePrompt(screen)) {
		return { activity: "needs_user", reason: "Terminal is asking the user a Ferment question.", issues }
	}
	if (isPermissionPrompt(screen)) {
		return { activity: "needs_user", reason: "Terminal is asking for command permission.", issues }
	}
	if (/Ferment completed|workflow completed|All phases complete/i.test(screen)) {
		return { activity: "complete", reason: "Terminal appears to show completed workflow.", issues }
	}
	if (isAgentBusy(screen)) {
		return { activity: "busy", reason: "Terminal shows agent/tool activity; supervisor LLM skipped.", issues }
	}
	if (/ask anything or type \/ for commands|❯/i.test(screen)) {
		return { activity: "idle", reason: "Terminal appears idle and ready for supervisor classification.", issues }
	}
	return { activity: "unknown", reason: "No deterministic activity classifier matched.", issues }
}

function detectScreenIssues(
	screen: string,
	state: { fermentSeen: boolean; elapsedMs: number; workDir: string },
): ScreenIssue[] {
	return [
		...detectInfrastructureIssues(screen),
		...detectFatalBugIssues(screen),
		...detectRecoverableBugIssues(screen),
		...detectWorkspaceEscapeIssues(screen, state.workDir),
		...detectFermentBypassIssues(screen, state),
	]
}

function detectInfrastructureIssues(screen: string): ScreenIssue[] {
	const patterns = [
		{
			pattern: /Hosted_vllmException[\s\S]{0,120}Server disconnected/i,
			reason: "Hosted model backend disconnected during the live Ferment workflow",
		},
		{
			pattern: /InternalServerError/i,
			reason: "Model backend returned an internal server error during the live Ferment workflow",
		},
		{
			pattern: /\b(?:502|503|504)\b[\s\S]{0,160}(?:Bad Gateway|Service Unavailable|Gateway Timeout|upstream|server)/i,
			reason: "Model backend returned a transient gateway/server error during the live Ferment workflow",
		},
	]
	return patterns.flatMap(({ pattern, reason }) => issueFromPatternWithKind(screen, pattern, reason, "infra", "fatal"))
}

function detectFermentBypassIssues(screen: string, state: { fermentSeen: boolean; elapsedMs: number }): ScreenIssue[] {
	const issues: ScreenIssue[] = []
	if (/Todos · Global/i.test(screen) && /Propose Ferment scoping|Activate phase and implement/i.test(screen)) {
		issues.push({
			kind: "bug",
			severity: "fatal",
			reason:
				"Kimchi is using ordinary global todos to simulate Ferment instead of entering an actual Ferment workflow",
			evidence: excerptMatch(
				screen,
				/Todos · Global[\s\S]{0,500}(?:Propose Ferment scoping|Activate phase and implement)/i,
			),
		})
	}
	if (
		!state.fermentSeen &&
		/The assistant wants to run:\s*write\(|Create hello_world\.py|just create a Python script/i.test(screen)
	) {
		issues.push({
			kind: "bug",
			severity: "fatal",
			reason: "Kimchi attempted direct file implementation before entering the Ferment workflow",
			evidence: excerptMatch(
				screen,
				/The assistant wants to run:\s*write\(|Create hello_world\.py|just create a Python script/i,
			),
		})
	}
	if (
		!state.fermentSeen &&
		/before,? I need to create the actual Python application|first,? I need to create the actual Python application/i.test(
			screen,
		)
	) {
		issues.push({
			kind: "bug",
			severity: "fatal",
			reason: "Kimchi plans to implement the app before entering the Ferment workflow",
			evidence: excerptMatch(
				screen,
				/before,? I need to create the actual Python application|first,? I need to create the actual Python application/i,
			),
		})
	}
	if (state.fermentSeen || state.elapsedMs < 45_000) return issues
	if (/Todos · Global/i.test(screen) && /Create Python application|Stage and commit|Add test script/i.test(screen)) {
		issues.push({
			kind: "bug",
			severity: "fatal",
			reason:
				"Kimchi appears to be implementing the task with normal global todos instead of entering the Ferment workflow",
			evidence: excerptMatch(
				screen,
				/Todos · Global[\s\S]{0,500}(?:Create Python application|Stage and commit|Add test script)/i,
			),
		})
	}
	if (
		/Let me first explore|create the application|test it, and git commit/i.test(screen) &&
		!hasFermentWorkflowEvidence(screen)
	) {
		issues.push({
			kind: "bug",
			severity: "fatal",
			reason: "Kimchi appears to be treating the Ferment request as a normal coding task",
			evidence: excerptMatch(screen, /Let me first explore|create the application|test it, and git commit/i),
		})
	}
	return issues
}

function detectWorkspaceEscapeIssues(screen: string, workDir: string): ScreenIssue[] {
	const paths = extractVisibleWritePaths(screen)
	return paths
		.filter((path) => !isInsidePath(path, workDir))
		.map((path) => ({
			kind: "bug" as const,
			severity: "fatal" as const,
			reason: "Kimchi attempted to write outside the isolated live-eval workspace",
			evidence: `workDir: ${workDir}\nwritePath: ${path}`,
		}))
}

function extractVisibleWritePaths(screen: string): string[] {
	const paths = new Set<string>()
	for (const pattern of [/●\s+Write\s+(\/[^\n(]+?)(?:\s+\(|\n)/g, /Successfully wrote [^\n]+ to (\/\S+)/g]) {
		for (const match of screen.matchAll(pattern)) {
			const path = match[1]?.trim()
			if (path) paths.add(path)
		}
	}
	return [...paths]
}

function isInsidePath(path: string, parent: string): boolean {
	const resolvedPath = resolve(path)
	const resolvedParent = resolve(parent)
	return resolvedPath === resolvedParent || resolvedPath.startsWith(`${resolvedParent}${sep}`)
}

function detectFatalBugIssues(screen: string): ScreenIssue[] {
	const patterns = [
		{ pattern: /Tool .* not found/i, reason: "Kimchi attempted to call a tool that is not available" },
		{ pattern: /Extension error/i, reason: "Kimchi displayed an extension error" },
		{ pattern: /Unhandled rejection/i, reason: "Kimchi displayed an unhandled rejection" },
		{ pattern: /Error: worker was terminated/i, reason: "Kimchi worker terminated unexpectedly" },
		{
			pattern: /invalid tag .*tag contains invalid characters/i,
			reason: "Kimchi generated an invalid tag for a tool call",
		},
		{ pattern: /ferment_id not found/i, reason: "Ferment tool call referenced a missing ferment_id" },
		{
			pattern: /ferment (?:doesn't|does not) exist yet/i,
			reason: "Ferment workflow is blocked because no draft ferment exists",
		},
		{
			pattern: /ferment must already exist in draft state/i,
			reason: "Ferment lifecycle tool requires an existing draft ferment",
		},
		{
			pattern: /scope_ferment tool is failing because the ferment doesn't exist/i,
			reason: "Ferment scoping cannot proceed because the ferment does not exist",
		},
		{
			pattern: /Error:\s*Failed to save plan:[\s\S]{0,240}No pending scope/i,
			reason: "Ferment failed to save a confirmed plan because no pending scope remained",
		},
		{
			pattern: /Propose Ferment Scoping[\s\S]{0,1500}new ferment_id[\s\S]{0,700}scoping sequence again/i,
			reason: "Ferment restarted scoping with a new ferment_id after a scoping proposal already succeeded",
		},
		{
			pattern:
				/Propose Ferment Scoping[\s\S]{0,1800}(?:User sends SAME task again|task is being repeated|system state was reset)/i,
			reason: "Ferment looped after scoping by treating the original task as repeated input",
		},
		{
			pattern: /doesn't seem to be a "create ferment" tool/i,
			reason: "Model cannot find a valid Ferment creation path",
		},
		{ pattern: /Both tools need it/i, reason: "Model is looping on Ferment tools that require an existing id" },
		{
			pattern: /this tool is for an existing ferment context/i,
			reason: "Model recognized it is missing an existing Ferment context",
		},
		{
			pattern:
				/The assistant wants to run a compound command[\s\S]{0,1000}(?:which ferment|ferment --help|no ferment cli found)/i,
			reason: "Kimchi is searching for an external Ferment CLI instead of using the workflow",
		},
		{
			pattern: /(?:I have no write tool|I cannot create files|I genuinely can't execute|without write tools)/i,
			reason: "Kimchi model believes it cannot write files while running an implementation workflow",
		},
	]
	return patterns.flatMap(({ pattern, reason }) => issueFromPattern(screen, pattern, reason, "fatal"))
}

function detectRecoverableBugIssues(screen: string): ScreenIssue[] {
	const patterns = [
		{ pattern: /Error:\s*\d{3}\b/i, reason: "A tool or model request displayed an HTTP-style error" },
		{ pattern: /context canceled/i, reason: "A tool or model request displayed context cancellation" },
		{ pattern: /Tool .* failed/i, reason: "A tool call failed while the run may still recover" },
		{ pattern: /Operation aborted/i, reason: "An operation was aborted while the run may still recover" },
	]
	return patterns.flatMap(({ pattern, reason }) => issueFromPattern(screen, pattern, reason, "recoverable"))
}

function issueFromPattern(
	screen: string,
	pattern: RegExp,
	reason: string,
	severity: ScreenIssueSeverity,
): ScreenIssue[] {
	return issueFromPatternWithKind(screen, pattern, reason, "bug", severity)
}

function issueFromPatternWithKind(
	screen: string,
	pattern: RegExp,
	reason: string,
	kind: ScreenIssueKind,
	severity: ScreenIssueSeverity,
): ScreenIssue[] {
	if (!pattern.test(screen)) return []
	return [
		{
			kind,
			severity,
			reason,
			evidence: excerptMatch(screen, pattern),
		},
	]
}

function excerptMatch(screen: string, pattern: RegExp): string {
	const match = screen.match(pattern)
	if (match?.index === undefined) return match?.[0] ?? pattern.toString()
	const start = Math.max(0, match.index - 160)
	const end = Math.min(screen.length, match.index + match[0].length + 160)
	return screen.slice(start, end)
}

function logScreenIssueOnce(
	fixture: LiveKimchiFixture,
	loggedIssueKeys: Set<string>,
	issue: ScreenIssue,
	context: Record<string, unknown>,
): void {
	const key = `${issue.kind}:${issue.severity}:${issue.reason}:${issue.evidence.slice(0, 120)}`
	if (loggedIssueKeys.has(key)) return
	loggedIssueKeys.add(key)
	appendLiveEvent(fixture, { type: "screen_issue", ...context, issue })
}

function normalizeScreenForProgress(screen: string): string {
	return screen
		.split("\n")
		.map((line) =>
			line
				.trimEnd()
				.replace(/\b\d+(?:\.\d+)?s\b/g, "<duration>")
				.replace(/↑\d+k?\s+↓\d+(?:\.\d+)?k?/gi, "↑<tokens> ↓<tokens>"),
		)
		.filter((line) => {
			const trimmed = line.trim()
			if (!trimmed) return false
			if (/^Tip:/.test(trimmed)) return false
			if (/^Update available!/.test(trimmed)) return false
			if (/ask anything or type \/ for commands/.test(trimmed)) return false
			if (/^(default|kimi-|[^ ]+ → shift\+tab)/.test(trimmed)) return false
			if (/\(\s*thinking…\s*\)|\(\s*thinking\.\.\.\s*\)/i.test(trimmed)) return false
			if (
				/^[\s~\/\\|+\-`_·.○●◔◕◓◒❄✧zZ×ˊ▂▃█⠋⠇⠸⠧]*\s*(Working|Stirring|Marinating|Massaging|Chopping|Mixing|Tasting|Letting it rest|Rinsing|Reducing|Seasoning|Packing|Chilling|Simmering|Prepping|Cooking|Braising|Salting|Building|Grinding)/i.test(
					trimmed,
				)
			) {
				return false
			}
			return true
		})
		.join("\n")
}

async function applyDecision(terminal: Terminal, decision: SupervisorDecision): Promise<void> {
	if (decision.action === "submit") {
		if (!decision.answer?.trim()) throw new Error("Supervisor returned submit without answer")
		terminal.submit(decision.answer)
		return
	}
	for (const key of decision.keys ?? []) {
		if (key === "enter") terminal.submit("")
		else if (key === "down") terminal.keyDown()
		else if (key === "up") terminal.keyUp()
		else if (key === "left") terminal.keyLeft()
		else if (key === "right") terminal.keyRight()
		else if (key === "tab") terminal.write("\t")
		else if (key === "space") terminal.write(" ")
		else if (key === "escape") terminal.keyEscape()
		else if (key === "ctrl_c") terminal.keyCtrlC()
		else if (/^[1-9]$/.test(key)) terminal.write(key)
		await sleep(key === "enter" ? 250 : 150)
	}
}

async function askSupervisor(input: {
	task: string
	screen: string
	fixture: LiveKimchiFixture
}): Promise<SupervisorDecision> {
	appendLiveEvent(input.fixture, {
		type: "user_agent_observation",
		screenChars: input.screen.length,
		screen: input.screen.slice(-7000),
	})
	const messages: Array<{ role: "system" | "user"; content: string }> = [
		{
			role: "system",
			content: [
				"You are a user-simulator agent driving a live Kimchi terminal UI eval for Ferment.",
				"Return JSON only.",
				"Your job is to act like a competent user: answer questions, choose options, toggle checkboxes, navigate form tabs, approve valid Ferment prompts, and fail on clear product errors.",
				'Allowed actions: {"action":"wait","reason":"..."}, {"action":"submit","answer":"...","reason":"..."}, {"action":"keys","keys":["enter","down","up","left","right","tab","space","escape","ctrl_c","1","2","3","4","5","6","7","8","9"],"reason":"..."}, {"action":"complete","reason":"..."}, {"action":"fail","reason":"..."}.',
				'Optional diagnostic fields are encouraged: {"confidence":0.0-1.0,"ui_state":"brief UI state","blocked_by":"only when blocked"}.',
				"The original task has already been submitted. Never restart the task or type /ferment new again.",
				"It is allowed to use active-workflow Ferment controls shown by the UI, such as /ferment auto, when needed to continue the current workflow.",
				"For keys, every item must be exactly one allowed key. To answer text/input prompts, use submit with answer.",
				"For single-choice lists, use arrow keys then enter, a visible 1-9 shortcut as a keys action, or enter if the selected option is good. Do not use submit for numeric shortcuts.",
				"For checkbox/multi-select lists, use space to toggle, arrows to move, and enter/tab/right to submit or move to Submit when appropriate.",
				"For multi-tab forms, tabs marked □ or listed under Unanswered must be answered before Submit. If a summary shows an unanswered tab, navigate to that tab first instead of answering another visible question.",
				"This eval must exercise Ferment. If the screen shows ordinary implementation outside Ferment, return fail.",
				"For the task, prefer a Python CLI app. If asked which languages, use English, Spanish, French, German, and Italian.",
				"Only answer if the UI is waiting for the user. If the agent is working, return wait.",
				"Do not return complete merely because a subagent says Task complete, a file exists, or a step completed.",
				"Return complete only when Ferment itself appears finished: explicit completion text, all phases complete, or a completed/reviewed phase with no remaining Ferment continuation prompt and the terminal is ready for a new user turn.",
			].join("\n"),
		},
		{
			role: "user",
			content: [
				`Task: ${input.task}`,
				`Workdir: ${input.fixture.workDir}`,
				"Current visible terminal:",
				"```",
				input.screen.slice(-7000),
				"```",
			].join("\n"),
		},
	]
	let lastError: unknown
	for (let attempt = 1; attempt <= USER_SIMULATOR_ATTEMPTS; attempt += 1) {
		try {
			const decision = await callKimchiJson<SupervisorDecision>({
				model: process.env.KIMCHI_TUI_LIVE_SUPERVISOR_MODEL ?? input.fixture.model,
				event: { fixture: input.fixture, type: "supervisor_llm" },
				messages,
			})
			return normalizeSupervisorDecision(decision)
		} catch (error) {
			lastError = error
			appendLiveEvent(input.fixture, {
				type: "user_simulator_attempt_error",
				attempt,
				attempts: USER_SIMULATOR_ATTEMPTS,
				error: formatUnknownError(error),
			})
			if (attempt < USER_SIMULATOR_ATTEMPTS) {
				await sleep(USER_SIMULATOR_RETRY_DELAY_MS * attempt)
			}
		}
	}
	throw new LiveEvalError(
		"user_simulator",
		`User simulator failed after ${USER_SIMULATOR_ATTEMPTS} attempt(s): ${formatUnknownError(lastError)}`,
		lastError,
	)
}

async function judgeFinalResult(input: {
	task: string
	terminal: Terminal
	fixture: LiveKimchiFixture
	appRun: AppRunResult
}): Promise<JudgeVerdict> {
	const workspace = collectWorkspace(input.fixture.workDir)
	const verdict = await callKimchiJson<JudgeVerdict>({
		model: process.env.KIMCHI_TUI_LIVE_JUDGE_MODEL ?? input.fixture.model,
		event: { fixture: input.fixture, type: "judge_llm" },
		messages: [
			{
				role: "system",
				content: [
					"You are judging a live Kimchi Ferment eval.",
					'Return JSON only with shape: {"passed": boolean, "summary": string, "issues": string[]}.',
					"Pass only if the run visibly used the Ferment workflow and the workspace contains a Python app that plausibly prints hello world in exactly five European languages and the app run output supports that.",
				].join("\n"),
			},
			{
				role: "user",
				content: [
					`Task: ${input.task}`,
					"App run:",
					JSON.stringify(input.appRun, null, "\t"),
					"Workspace files:",
					workspace,
					"Visible terminal tail:",
					viewText(input.terminal).slice(-5000),
				].join("\n\n"),
			},
		],
	})
	return {
		passed: Boolean(verdict.passed),
		summary: String(verdict.summary ?? ""),
		issues: Array.isArray(verdict.issues) ? verdict.issues.map(String) : [],
	}
}

async function judgeRuntimeHealth(input: {
	fixture: LiveKimchiFixture
	screen: string
	reason: string
}): Promise<RuntimeHealthVerdict> {
	const recentEvents = readRecentEvents(input.fixture, 80)
	const messages: Array<{ role: "system" | "user"; content: string }> = [
		{
			role: "system",
			content: [
				"You are judging whether a live Kimchi TUI eval is healthy, stalled, or errored.",
				'Return JSON only with shape: {"state":"healthy"|"stall"|"error","summary":"...","evidence":["..."]}.',
				"Use state=stall when the agent is looping, only changing spinner/cooking text, repeatedly inspecting without progress, or clearly not moving toward the requested Ferment workflow.",
				"Use state=error when the terminal shows tool errors, contradictory instructions, unavailable tools, or clear workflow misuse.",
				"Use state=healthy only if there is plausible ongoing progress or the UI is waiting for a valid user response.",
			].join("\n"),
		},
		{
			role: "user",
			content: [
				`Trigger: ${input.reason}`,
				`Task: ${TASK}`,
				"Recent event log:",
				recentEvents,
				"Current visible terminal:",
				"```",
				input.screen.slice(-7000),
				"```",
			].join("\n\n"),
		},
	]
	let lastError: unknown
	for (let attempt = 1; attempt <= HEALTH_JUDGE_ATTEMPTS; attempt += 1) {
		try {
			const verdict = await callKimchiJson<RuntimeHealthVerdict>({
				model: process.env.KIMCHI_TUI_LIVE_HEALTH_JUDGE_MODEL ?? input.fixture.model,
				event: { fixture: input.fixture, type: "runtime_health_llm" },
				messages,
			})
			return normalizeRuntimeHealth(verdict)
		} catch (error) {
			lastError = error
			appendLiveEvent(input.fixture, {
				type: "runtime_health_judge_attempt_error",
				attempt,
				attempts: HEALTH_JUDGE_ATTEMPTS,
				error: formatUnknownError(error),
			})
			if (attempt < HEALTH_JUDGE_ATTEMPTS) {
				await sleep(HEALTH_JUDGE_RETRY_DELAY_MS * attempt)
			}
		}
	}
	appendLiveEvent(input.fixture, { type: "runtime_health_judge_error", error: formatUnknownError(lastError) })
	return {
		state: "stall",
		summary: `Health judge failed after ${HEALTH_JUDGE_ATTEMPTS} attempt(s): ${formatUnknownError(lastError)}`,
		evidence: [input.reason],
	}
}

async function callKimchiJson<T>(input: {
	model: string
	messages: Array<{ role: "system" | "user"; content: string }>
	event?: { fixture: LiveKimchiFixture; type: string }
}): Promise<T> {
	const apiKey = process.env.KIMCHI_API_KEY
	if (!apiKey) throw new Error("KIMCHI_API_KEY is required")
	const baseUrl = (process.env.KIMCHI_TUI_LIVE_BASE_URL ?? "https://llm.kimchi.dev/openai/v1").replace(/\/+$/, "")
	const startedAt = Date.now()
	if (input.event) {
		appendLiveEvent(input.event.fixture, {
			type: `${input.event.type}_request`,
			model: stripProvider(input.model),
			timeoutMs: META_LLM_TIMEOUT_MS,
			messageChars: input.messages.reduce((sum, message) => sum + message.content.length, 0),
		})
	}
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), META_LLM_TIMEOUT_MS)
	let response: Response
	try {
		response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			signal: controller.signal,
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: stripProvider(input.model),
				stream: false,
				temperature: 0,
				messages: input.messages,
			}),
		})
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(`Kimchi judge request timed out after ${META_LLM_TIMEOUT_MS}ms`)
		}
		throw error
	} finally {
		clearTimeout(timeout)
	}
	if (!response.ok) {
		throw new Error(`Kimchi judge request failed ${response.status}: ${await response.text()}`)
	}
	const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
	const content = data.choices?.[0]?.message?.content
	if (!content) throw new Error("Kimchi judge response did not include content")
	if (input.event) {
		appendLiveEvent(input.event.fixture, {
			type: `${input.event.type}_response`,
			durationMs: Date.now() - startedAt,
			contentChars: content.length,
			contentPreview: content.slice(0, 1000),
		})
	}
	return parseJsonContent<T>(content)
}

function normalizeRuntimeHealth(raw: RuntimeHealthVerdict): RuntimeHealthVerdict {
	const state = ["healthy", "stall", "error"].includes(raw.state) ? raw.state : "error"
	return {
		state,
		summary: String(raw.summary ?? ""),
		evidence: Array.isArray(raw.evidence) ? raw.evidence.map(String) : [],
	}
}

function parseJsonContent<T>(content: string): T {
	const trimmed = content.trim()
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
	return JSON.parse(fenced?.[1] ?? trimmed) as T
}

function stripProvider(model: string): string {
	const slash = model.indexOf("/")
	return slash === -1 ? model : model.slice(slash + 1)
}

function formatFermentNewCommand(task: string): string {
	return `/ferment new "${task.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function runPythonApp(fixture: LiveKimchiFixture): AppRunResult {
	const entrypoint = findPythonEntrypoint(fixture.workDir)
	if (!entrypoint) {
		return { stdout: "", stderr: "", error: "No Python file found in workspace" }
	}
	const rel = relative(fixture.workDir, entrypoint)
	try {
		const stdout = execFileSync("python3", [entrypoint], {
			cwd: fixture.workDir,
			encoding: "utf-8",
			timeout: 10_000,
		})
		const result = { command: `python3 ${rel}`, stdout, stderr: "" }
		writeFileSync(join(fixture.artifactDir, "app-output.txt"), stdout, "utf-8")
		return result
	} catch (error) {
		const e = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string }
		const result = {
			command: `python3 ${rel}`,
			stdout: String(e.stdout ?? ""),
			stderr: String(e.stderr ?? ""),
			error: e.message ?? String(error),
		}
		writeFileSync(join(fixture.artifactDir, "app-output.txt"), JSON.stringify(result, null, "\t"), "utf-8")
		return result
	}
}

function findPythonEntrypoint(root: string): string | undefined {
	const files = walk(root).filter((file) => file.endsWith(".py"))
	const preferred = ["main.py", "app.py", "hello.py", "hello_world.py"]
	for (const name of preferred) {
		const hit = files.find((file) => file.endsWith(`/${name}`) || file.endsWith(`\\${name}`))
		if (hit) return hit
	}
	return files[0]
}

function collectWorkspace(root: string): string {
	const files = walk(root).slice(0, 40)
	return files
		.map((file) => {
			const rel = relative(root, file)
			if (!/\.(py|md|txt|toml|json)$/i.test(file)) return `## ${rel}\n(binary or unsupported text omitted)`
			const content = readFileSync(file, "utf-8").slice(0, 4000)
			return `## ${rel}\n${content}`
		})
		.join("\n\n")
}

function listSessionArtifacts(fixture: LiveKimchiFixture): string[] {
	if (!existsSync(fixture.sessionDir)) return []
	return readdirSync(fixture.sessionDir)
		.filter((name) => name.endsWith(".jsonl"))
		.sort()
		.map((name) => join(fixture.sessionDir, name))
}

function readRecentEvents(fixture: LiveKimchiFixture, count: number): string {
	if (!existsSync(fixture.eventLogPath)) return "(no events yet)"
	return readFileSync(fixture.eventLogPath, "utf-8").trim().split("\n").slice(-count).join("\n")
}

function walk(root: string): string[] {
	if (!existsSync(root)) return []
	const out: string[] = []
	for (const name of readdirSync(root)) {
		if (name === ".git" || name === ".kimchi" || name === "__pycache__") continue
		const path = join(root, name)
		const stat = statSync(path)
		if (stat.isDirectory()) out.push(...walk(path))
		else if (stat.isFile()) out.push(path)
	}
	return out.sort()
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function positiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number(value)
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function classifyLiveEvalFailure(error: unknown): LiveEvalFailureKind {
	if (error instanceof LiveEvalError) return error.kind
	const message = formatUnknownError(error)
	if (/Hosted_vllmException|InternalServerError|\b(?:502|503|504)\b|Server disconnected/i.test(message)) return "infra"
	if (/User simulator|Supervisor returned/i.test(message)) return "user_simulator"
	if (/Runtime health judge|Health judge/i.test(message)) return "health_judge"
	if (/Judge failed live Ferment run|judge_result/i.test(message)) return "final_judge"
	if (
		/Supervisor failed live Ferment run|Terminal matched failure pattern|Kimchi .*Ferment|Ferment .*blocked/i.test(
			message,
		)
	) {
		return "product"
	}
	return "harness"
}

function formatUnknownError(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`
	return String(error)
}
