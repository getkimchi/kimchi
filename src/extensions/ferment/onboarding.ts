/**
 * First-run onboarding for /ferment.
 *
 * Asks the user (once, ever) whether they want a quick walkthrough. If yes,
 * pages them through a sequence of TUI dialogs explaining the core commands
 * with concrete examples. If no, the prompt never appears again.
 *
 * Persistence: a JSON flag at `~/.config/kimchi/onboarding.json`. We write
 * the flag on EITHER answer (Yes or No) — once the user has seen the
 * question, they shouldn't see it again. We deliberately do NOT use the
 * per-project ferments dir; this is a user-level preference, not a project
 * artifact, and a returning user picks up where they left off everywhere.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent"

interface OnboardingFlag {
	seenAt: string
	choseWalkthrough: boolean
}

function flagPath(): string {
	return resolve(homedir(), ".config", "kimchi", "onboarding.json")
}

export function hasSeenOnboarding(): boolean {
	const p = flagPath()
	if (!existsSync(p)) return false
	try {
		const raw = readFileSync(p, "utf8")
		const parsed = JSON.parse(raw) as Partial<OnboardingFlag>
		return typeof parsed.seenAt === "string"
	} catch {
		// Corrupt flag file — treat as unseen so the user gets onboarding,
		// then we'll overwrite it cleanly on their next answer.
		return false
	}
}

function markOnboardingSeen(choseWalkthrough: boolean): void {
	const p = flagPath()
	try {
		mkdirSync(dirname(p), { recursive: true })
		const flag: OnboardingFlag = {
			seenAt: new Date().toISOString(),
			choseWalkthrough,
		}
		writeFileSync(p, JSON.stringify(flag, null, 2), "utf8")
	} catch {
		// Best-effort; if we can't write the flag the user will be asked again
		// next time. That's annoying but not broken — better than crashing.
	}
}

/**
 * Sequential walkthrough screens. Each is a `select` dialog with a "Next"
 * action and a "Skip" option so the user can bail at any step.
 *
 * Returns true if the walkthrough completed (or the user skipped it
 * partway). Always marks the flag as seen so the user isn't asked again.
 */
async function runWalkthrough(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.ui.select) return

	const screens: Array<{ title: string; next: string }> = [
		{
			title: `🍺  Welcome to ferment!

A ferment is a multi-session unit of work. You scope a goal once, the agent breaks it into phases and steps, and you can pause/resume across sessions without losing context.

Three commands you'll use most:
  /ferment        — start or pick a ferment
  /ferment auto   — continue across future phase boundaries automatically
  /ferment pause  — stop and freeze state

Let's see how each one works.`,
			next: "Next: /ferment",
		},
		{
			title: `📝  /ferment

Type /ferment with no arguments to start one. You'll be asked:
  1. What you want to ferment (free-form; rough is fine)

The agent drafts the goal, success criteria, constraints, assumptions, and
3–7 phases. If the request is ambiguous, it asks a few focused questions with
recommended answers. Review the markdown plan, then choose Start execution.

Other forms:
  /ferment list                    — pick from existing ferments
  /ferment new "Name"              — start with a known name
  /ferment one-shot "task"         — automated one-shot run, no confirmations`,
			next: "Next: /ferment auto and lifecycle",
		},
		{
			title: `🔄  /ferment auto and lifecycle pause/resume

After you confirm Start execution, the planner activates phases and steps.
Type:

  /ferment auto    — sets continuation policy to automated; it does not
                     start or resume work by itself.

  /ferment pause   — flips to paused. The state machine refuses every ferment
                     tool call until you resume. Safe to use mid-step.

  /ferment resume  — resumes the paused lifecycle using the current policy.`,
			next: "Next: /ferment progress",
		},
		{
			title: `📊  /ferment progress

Open the phase/step navigator for the active ferment.

  • Layer 1: phase list with status + grades
  • Layer 2: step list inside a phase
  • Layer 3: per-step detail (logs, retry, skip, fail)

Also useful:
  /ferment manual or /ferment auto — change continuation policy
  /ferment revise goal|criteria    — edit scoping after the fact
  /ferment abandon                 — give up and free the slot`,
			next: "Next: example flow",
		},
		{
			title: `✨  Example flow

  > /ferment
  What would you like to ferment? Add Google OAuth login

  [agent drafts goal/criteria/constraints/assumptions + 4 phases]
  [agent asks any needed scoping questions with recommended answers]
  [you review the markdown plan and click "Start execution"]

  [agent runs phase 1 step 1, returns with a summary]
  [agent runs phase 1 step 2 …]

  > /ferment pause
  [you check something, eat lunch]

  > /ferment resume
  [agent picks up at phase 1 step 3 with full context]

That's the whole loop. You're ready — let's start your first ferment.`,
			next: "Start fermenting",
		},
	]

	for (const screen of screens) {
		const choice = await ctx.ui.select(screen.title, [screen.next, "Skip walkthrough"])
		if (!choice || choice === "Skip walkthrough") return
	}
}

/**
 * Show the first-run prompt if the user hasn't seen onboarding yet. Returns
 * `true` if onboarding ran (so the caller can decide whether to continue
 * straight into the normal flow); always returns true if the flag was
 * already set (no-op).
 *
 * Headless sessions skip the prompt entirely — there's no UI to ask.
 */
export async function maybeRunOnboarding(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.ui?.select) return
	if (hasSeenOnboarding()) return

	const choice = await ctx.ui.select(
		`🍺  First time using /ferment?

Want a quick walkthrough of how it works (Yes), or jump straight in (No)?`,
		["Yes, show me how it works", "No, I know what I'm doing"],
	)

	// User dismissed the dialog without picking — don't write the flag, ask again next time.
	if (!choice) return

	const wantsWalkthrough = choice.startsWith("Yes")
	markOnboardingSeen(wantsWalkthrough)
	if (wantsWalkthrough) {
		await runWalkthrough(ctx)
	}
}
