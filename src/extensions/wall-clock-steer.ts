/**
 * Wall-clock budget steer for the single-model main agent.
 *
 * The main agent in `--print` (benchmark) mode has no wall-clock budget
 * awareness — subagents already receive progress steers at 50%/75%/90% of
 * their turn budget (PROGRESS_STEER_POINTS in agent-runner.ts), but the main
 * agent does not. This extension tracks elapsed wall-clock time since the
 * session started and steers the main agent at time-based thresholds, pushing
 * it to prioritize implementation and verification over exploration and
 * perfectionism.
 *
 * Two modes:
 * - **Percentage-based** (when `KIMCHI_TASK_TIMEOUT_SECONDS` is set): steers
 *   at 50%, 75%, and 90% of the task timeout. Calibrated to the actual budget.
 *   Note: harbor does not currently expose the trial timeout to the agent's
 *   `run()` method, so this mode is only activated when the caller explicitly
 *   sets the env var (e.g. via `extra_env` in the trial config).
 * - **Fixed-interval** (fallback, the mode actually used in benchmark runs):
 *   steers at 5, 10, 15, 20, 25, 30, 40, 45, 50, and 55 minutes. The messages
 *   are tier-agnostic and hedged so they remain appropriate across the three
 *   benchmark timeout tiers (900s, 1800s, 3600s) — a steer at 30 minutes does
 *   not claim the task is ending, because for a 3600s task that is only 50%
 *   of the budget. Later steers (40–55 min) cover the 67–92% range of 3600s
 *   tasks that the original 30-min ceiling left as a blind spot.
 *
 * Skips subagents (they have their own progress steers). Resets the time
 * window on real user input (a new task starts a new window). Each steer
 * fires at most once per session.
 */
import type { ExtensionAPI, InputEvent } from "@earendil-works/pi-coding-agent"
import { isAgentWorker } from "./agent-worker-context.js"

const TASK_TIMEOUT_ENV = "KIMCHI_TASK_TIMEOUT_SECONDS"

export const STEER_MESSAGE_TYPE = "wall-clock-steer"

// Sanity bounds for KIMCHI_TASK_TIMEOUT_SECONDS. A typo (e.g. "90000" intending
// 900s) would otherwise push the first percentage steer to 12.5h and silently
// disable all time awareness for a short task. Values outside this range fall
// back to the fixed-interval steers.
const MIN_TASK_TIMEOUT_SECONDS = 60 // 1 min
const MAX_TASK_TIMEOUT_SECONDS = 14_400 // 4 h

// Fixed-interval steers (used when KIMCHI_TASK_TIMEOUT_SECONDS is not set).
// Covers the three benchmark timeout tiers (900s, 1800s, 3600s). Messages are
// tier-agnostic and hedged: they never claim the task is about to end, because
// the same elapsed time can be 80% of a 900s task or 50% of a 3600s task. Later
// steers (40–55 min) only fire for 1800s+/3600s tasks (900s tasks have already
// timed out), so they can escalate urgency for the long-task tail.
const FIXED_STEERS: { elapsedMs: number; message: string }[] = [
	{
		elapsedMs: 5 * 60_000, // 5 min
		message:
			"Time check: you've been working for 5 minutes. " +
			"If you haven't started implementing your solution, do so now. " +
			"Prioritize writing code over further exploration.",
	},
	{
		elapsedMs: 10 * 60_000, // 10 min — 67% of 900s, 56% of 1800s, 17% of 3600s
		message:
			"Time check: 10 minutes elapsed. " +
			"Prioritize completing your solution: finish your current implementation, " +
			"run verification, and prepare to wrap up. " +
			"Do not start new exploratory work or long-running commands.",
	},
	{
		elapsedMs: 15 * 60_000, // 15 min — 100% of 900s (timed out), 83% of 1800s, 25% of 3600s
		message:
			"Time check: 15 minutes elapsed. " +
			"If this is a short task, finalize and verify your solution now. " +
			"If you have more time, ensure you've started implementing and are " +
			"making steady progress — do not start any command that will run for " +
			"more than 2 minutes without checking it is necessary.",
	},
	{
		elapsedMs: 20 * 60_000, // 20 min — 67% of 1800s, 33% of 3600s
		message:
			"Time check: 20 minutes elapsed. " +
			"If this is a short task, write your best solution and run verification now. " +
			"If you have more time, confirm you are progressing toward a complete " +
			"solution and have not gotten stuck exploring.",
	},
	{
		elapsedMs: 25 * 60_000, // 25 min — 83% of 1800s, 42% of 3600s
		message:
			"Time check: 25 minutes elapsed. " +
			"If this is a medium-length task, finalize and verify your solution now. " +
			"If you have more time, ensure your current implementation is saved and " +
			"you are not starting new exploratory work.",
	},
	{
		elapsedMs: 30 * 60_000, // 30 min — 100% of 1800s (timed out), 50% of 3600s
		message:
			"Time check: 30 minutes elapsed. " +
			"If this is a long task, you are likely around halfway — ensure you are " +
			"progressing toward a complete solution and have not gotten stuck. " +
			"If this is a shorter task, finalize and verify your solution now.",
	},
	{
		elapsedMs: 40 * 60_000, // 40 min — 67% of 3600s
		message:
			"Time check: 40 minutes elapsed. " +
			"Prioritize completing your implementation and running verification. " +
			"Do not start new exploratory work or long-running commands.",
	},
	{
		elapsedMs: 45 * 60_000, // 45 min — 75% of 3600s
		message:
			"Time check: 45 minutes elapsed. " +
			"If your time budget is around 60 minutes, you are approximately 75% " +
			"through it — start wrapping up: finish your implementation and run " +
			"verification. Do not start new exploratory work.",
	},
	{
		elapsedMs: 50 * 60_000, // 50 min — 83% of 3600s
		message:
			"URGENT: 50 minutes elapsed. " +
			"If your time budget is around 60 minutes, finalize and verify your " +
			"solution now. Do not start any command that will run for more than " +
			"2 minutes.",
	},
	{
		elapsedMs: 55 * 60_000, // 55 min — 92% of 3600s
		message:
			"URGENT: 55 minutes elapsed. " +
			"Write your best solution and ensure it is saved to disk immediately. " +
			"Do not start any new commands — finalize what you have.",
	},
]

// Percentage-based steers (used when KIMCHI_TASK_TIMEOUT_SECONDS is set).
const PERCENTAGE_STEERS: { fraction: number; message: string }[] = [
	{
		fraction: 0.5,
		message:
			"Time check: you are approximately 50% through your time budget. " +
			"Pause briefly: evaluate your progress, confirm you're on the right path, " +
			"and prioritize implementation over further exploration.",
	},
	{
		fraction: 0.75,
		message:
			"Time check: you are approximately 75% through your time budget. " +
			"Prioritize completing your solution: finish your current implementation, " +
			"run verification, and prepare to wrap up. " +
			"Do not start new exploratory work or long-running commands.",
	},
	{
		fraction: 0.9,
		message:
			"URGENT: you are approximately 90% through your time budget. " +
			"Write your best solution NOW, run whatever verification exists, " +
			"and ensure your work is saved to disk. " +
			"Do not start new exploratory work or long-running commands.",
	},
]

export function resolveSteers(
	env: NodeJS.ProcessEnv = process.env,
): { thresholdMs: number; message: string }[] {
	const raw = env[TASK_TIMEOUT_ENV]
	if (raw !== undefined && raw !== "") {
		const parsed = Number.parseInt(raw, 10)
		if (
			Number.isInteger(parsed) &&
			parsed >= MIN_TASK_TIMEOUT_SECONDS &&
			parsed <= MAX_TASK_TIMEOUT_SECONDS
		) {
			return PERCENTAGE_STEERS.map((s) => ({
				thresholdMs: parsed * 1000 * s.fraction,
				message: s.message,
			}))
		}
	}
	return FIXED_STEERS.map((s) => ({ thresholdMs: s.elapsedMs, message: s.message }))
}

export default function wallClockSteerExtension(pi: ExtensionAPI): void {
	let sessionStartMs: number | null = null
	const steers = resolveSteers()
	const firedIndices = new Set<number>()

	pi.on("session_start", () => {
		sessionStartMs = Date.now()
		firedIndices.clear()
	})

	pi.on("input", (event: InputEvent) => {
		if (event.source === "extension") return
		// Reset on real user input — a new task starts a new time window.
		sessionStartMs = Date.now()
		firedIndices.clear()
	})

	pi.on("turn_end", () => {
		// Skip subagents — they have PROGRESS_STEER_POINTS in agent-runner.ts.
		if (isAgentWorker()) return
		if (sessionStartMs === null) return

		const elapsedMs = Date.now() - sessionStartMs
		for (let i = 0; i < steers.length; i++) {
			if (firedIndices.has(i)) continue
			if (elapsedMs >= steers[i].thresholdMs) {
				firedIndices.add(i)
				pi.sendMessage(
					{
						customType: STEER_MESSAGE_TYPE,
						content: [{ type: "text", text: steers[i].message }],
						display: false,
					},
					{ deliverAs: "steer" },
				)
			}
		}
	})
}
