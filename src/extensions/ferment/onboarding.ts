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
  /auto           — let the agent run autonomously
  /pause          — stop and freeze state

Let's see how each one works.`,
			next: "Next: /ferment",
		},
		{
			title: `📝  /ferment

Type /ferment with no arguments to start one. You'll be asked:
  1. What you want to ferment (e.g. "Add Google OAuth login")
  2. Goal (what does done look like?)
  3. Success criteria (how will we know we got there?)
  4. Constraints (anything to avoid? — optional)

The agent then proposes 3–7 phases. Confirm via dropdown and you're scoped.

Other forms:
  /ferment list                    — pick from existing ferments
  /ferment add "Name"              — start with a known name
  /ferment one-shot "task"         — autonomous exec mode, no confirmations`,
			next: "Next: /auto and /pause",
		},
		{
			title: `🔄  /auto and ⏸  /pause

After scoping, the planner waits at "Ready to execute?". Type:

  /auto    — flips to running, kicks the planner to execute the next step.
             Use this whenever you want the agent to keep going on its own.

  /pause   — flips to paused. The state machine refuses every ferment tool
             call until you resume. Safe to use mid-step.

Resuming after /pause: type /auto. The planner picks up exactly where it
stopped — no re-explaining, no re-scoping.`,
			next: "Next: /progress",
		},
		{
			title: `📊  /progress

Open the phase/step navigator for the active ferment.

  • Layer 1: phase list with status + grades
  • Layer 2: step list inside a phase
  • Layer 3: per-step detail (logs, retry, skip, fail)

Also useful:
  /ferment mode plan|exec|auto     — change interaction style
  /ferment revise goal|criteria    — edit scoping after the fact
  /ferment abandon                 — give up and free the slot`,
			next: "Next: example flow",
		},
		{
			title: `✨  Example flow

  > /ferment
  What would you like to ferment? Add Google OAuth login
  Goal? Users can sign in with their Google account
  Success criteria? E2E test passes; no regressions in /login
  Constraints? No external auth libs

  [agent proposes 4 phases — you click "Yes, this looks right"]

  > /auto
  [agent runs phase 1 step 1, returns with a summary]
  [agent runs phase 1 step 2 …]

  > /pause
  [you check something, eat lunch]

  > /auto
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
