import { appendFileSync, closeSync, openSync, readFileSync, unlinkSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { convertToLlm } from "@earendil-works/pi-coding-agent"
import { parse as parseYaml } from "yaml"
import { spawnKimchiSubprocess } from "../../utils/spawn-kimchi-subprocess.js"
import type { SkillManager } from "../skills-manager/skill-manager.js"
import { agentCreatedReport } from "../skills-manager/usage.js"
import { loadState, saveState } from "./state.js"

export interface CuratorCandidate {
	name: string
	description: string
	state: string
}

export interface CuratorSummary {
	consolidations: Array<{ from: string; into: string; reason: string }>
	prunings: Array<{ name: string; reason: string }>
}

export function buildCuratorPrompt(candidates: CuratorCandidate[]): string {
	const candidateList =
		candidates.length === 0
			? "(no agent_created skills to review)"
			: candidates.map((c) => `- ${c.name} [${c.state}]: ${c.description}`).join("\n")

	return `You are the Kimchi skill curator. Your job is **consolidation only** — not gap-finding, not creating new skills from scratch.

## Your scope

- **Agent-created skills only** — the candidate list below is pre-filtered. Bundled or harness skills are never touched.
- **No deletion** — only archive via \`skill_manage action=delete\` (archives are recoverable from .archive/).
- **Pinned skills are off-limits** — skip entirely.
- **Two consolidation strategies:**
  1. Merge into existing umbrella: patch it, archive siblings with \`absorbed_into\`
  2. Create new umbrella: \`skill_manage action=create\`, then archive absorbed skills

## Tools available

You have three tools: \`skill_manage\`, \`skill_view\`, \`skill_list\`. No terminal, no bash.

## Candidate skills (agent_created, capped at 40)

${candidateList}

## Instructions

1. Review the candidate list. Use \`skill_view\` to read any skill's full content before deciding.
2. Identify clusters of overlapping skills that can be consolidated under an umbrella.
3. Execute consolidations using \`skill_manage\`. When archiving a skill, set \`absorbed_into\` to the umbrella name.
4. After all tool calls are complete, output the structured summary below as your **final message**.

## Required output (emit after all tool calls)

\`\`\`yaml
consolidations:
  - from: <absorbed-skill-name>
    into: <umbrella-skill-name>
    reason: <one sentence>
prunings:
  - name: <archived-skill-name>
    reason: <one sentence>
\`\`\`

Every skill you archived must appear in exactly one list. If nothing was consolidated, output empty lists.`
}

export function parseCuratorOutput(text: string): CuratorSummary | null {
	const stripped = text.replace(/```ya?ml\n?/g, "").replace(/```\n?/g, "")
	const match = stripped.match(/(consolidations\s*:[\s\S]*|prunings\s*:[\s\S]*)/)
	if (!match) return null

	try {
		const parsed = parseYaml(match[0]) as Partial<CuratorSummary>
		return {
			consolidations: Array.isArray(parsed.consolidations) ? parsed.consolidations : [],
			prunings: Array.isArray(parsed.prunings) ? parsed.prunings : [],
		}
	} catch {
		return null
	}
}

async function readSkillDescription(skillPath: string): Promise<string> {
	try {
		const content = await readFile(join(skillPath, "SKILL.md"), "utf-8")
		const match = content.match(/^description:\s*(.+)$/m)
		return match ? match[1].trim() : "(no description)"
	} catch {
		return "(unreadable)"
	}
}

export async function buildCandidateList(
	manager: SkillManager,
	skillsDir: string,
	cap = 40,
): Promise<CuratorCandidate[]> {
	const [inventory, usageReports] = await Promise.all([manager.listInventory(), agentCreatedReport(skillsDir)])

	const stateMap = new Map(usageReports.map((r) => [r.name, r.state ?? "active"]))

	const agentCreated = inventory.filter((s) => s.agent_created).slice(0, cap)

	return Promise.all(
		agentCreated.map(async (s) => ({
			name: s.name,
			description: await readSkillDescription(s.path),
			state: stateMap.get(s.name) ?? "active",
		})),
	)
}

export interface RunCuratorReviewOptions {
	provider: string
	model: string
	statePath: string
	skillsDir: string
	manager: SkillManager
	background?: boolean
}

function collectExtensionArgs(): string[] {
	const result: string[] = []
	const argv = process.argv
	for (let i = 0; i < argv.length; i++) {
		if ((argv[i] === "-e" || argv[i] === "--extension") && i + 1 < argv.length) {
			result.push("-e", argv[i + 1])
			i++
		} else if (argv[i].startsWith("--extension=")) {
			result.push("-e", argv[i].slice("--extension=".length))
		}
	}
	return result
}

function buildReviewAgentArgs(provider: string, model: string, prompt: string): string[] {
	return [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--provider",
		provider,
		"--model",
		model,
		...collectExtensionArgs(),
		prompt,
	]
}

function parseReviewAgentDelta(line: string): string {
	if (!line.trim()) return ""
	try {
		const event = JSON.parse(line) as { type?: string; assistantMessageEvent?: { type?: string; delta?: string } }
		if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
			return event.assistantMessageEvent.delta ?? ""
		}
	} catch {
		return ""
	}
	return ""
}

function spawnReviewAgent(
	provider: string,
	model: string,
	prompt: string,
	opts?: { detached?: boolean; stdout?: "pipe" | "ignore" | number; stderr?: "pipe" | "ignore" | number },
) {
	const args = buildReviewAgentArgs(provider, model, prompt)
	debugLog(`spawning review agent with args: ${args.slice(0, 6).join(" ")} ...`)
	return spawnKimchiSubprocess({
		args,
		stdout: opts?.stdout,
		stderr: opts?.stderr,
		detached: opts?.detached,
		env: { KIMCHI_SUBAGENT: "1", KIMCHI_SESSION_REVIEW: "1" },
	})
}

// Mirrors the legacy `subagent.ts` foreground guards: a long-stalled review
// agent (no stdout for 3 minutes) or a runaway one (>30 minutes wall clock)
// must reject the promise rather than hang. The deleted subprocess primitive
// enforced these; keeping them here so curator session reviews don't pin a
// process indefinitely if the model hangs.
const REVIEW_TIMEOUT_MS = 30 * 60 * 1000
const REVIEW_INACTIVITY_TIMEOUT_MS = 3 * 60 * 1000

function runReviewAgent(provider: string, model: string, prompt: string): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const proc = spawnReviewAgent(provider, model, prompt)
		let output = ""
		let stderr = ""
		let buffer = ""
		let closed = false
		let killReason: "timeout" | "output_stalled" | undefined

		// Force-kill the spawned process and disarm both watchdogs. Called from
		// either the hard wall-clock timeout or the inactivity watchdog below.
		// SIGTERM gives the child a chance to flush; we don't escalate to
		// SIGKILL because curator review is short-lived and SIGTERM is
		// universally honored by node/bun/tsx targets.
		const kill = (reason: "timeout" | "output_stalled") => {
			if (closed) return
			killReason = reason
			try {
				proc.kill("SIGTERM")
			} catch {
				// Process may already be gone; ignore.
			}
		}

		const hardTimeout = setTimeout(() => kill("timeout"), REVIEW_TIMEOUT_MS)
		let inactivityHandle = setTimeout(() => kill("output_stalled"), REVIEW_INACTIVITY_TIMEOUT_MS)
		// Reset on every stdout chunk; stderr does NOT reset because a hung
		// model still typically emits stderr noise (provider keep-alives, log
		// lines from the bun shim) — counting those would defeat the watchdog.
		const resetInactivity = () => {
			if (closed) return
			clearTimeout(inactivityHandle)
			inactivityHandle = setTimeout(() => kill("output_stalled"), REVIEW_INACTIVITY_TIMEOUT_MS)
		}

		proc.stdout?.on("data", (chunk: Buffer) => {
			buffer += chunk.toString()
			const lines = buffer.split("\n")
			buffer = lines.pop() ?? ""
			for (const line of lines) output += parseReviewAgentDelta(line)
			resetInactivity()
		})
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString()
		})
		proc.on("close", (code) => {
			if (closed) return
			closed = true
			clearTimeout(hardTimeout)
			clearTimeout(inactivityHandle)
			if (buffer.trim()) output += parseReviewAgentDelta(buffer)
			if (killReason === "timeout") {
				reject(new Error(`review agent timed out after ${REVIEW_TIMEOUT_MS / 60000} minutes`))
				return
			}
			if (killReason === "output_stalled") {
				reject(new Error(`review agent stalled — no output for ${REVIEW_INACTIVITY_TIMEOUT_MS / 60000} minutes`))
				return
			}
			if (code === 0) resolvePromise(output)
			else reject(new Error(stderr.trim() || `review agent exited with code ${code}`))
		})
		proc.on("error", (err) => {
			if (closed) return
			closed = true
			clearTimeout(hardTimeout)
			clearTimeout(inactivityHandle)
			reject(err)
		})
	})
}

export async function runCuratorReview(opts: RunCuratorReviewOptions): Promise<CuratorSummary | null> {
	const { provider, model, statePath, manager, background = false } = opts

	const state = await loadState(statePath)
	await saveState(statePath, { ...state, running: true })

	const candidates = await buildCandidateList(manager, opts.skillsDir)
	const prompt = buildCuratorPrompt(candidates)

	const finalize = async (output: string, error?: string): Promise<CuratorSummary | null> => {
		const summary = error ? null : parseCuratorOutput(output)
		const current = await loadState(statePath)
		await saveState(statePath, {
			...current,
			running: false,
			last_run_at: new Date().toISOString(),
			run_count: current.run_count + 1,
			last_run_summary: error
				? `error: ${error}`
				: summary
					? `${summary.consolidations.length} merged, ${summary.prunings.length} archived`
					: "completed (no structured output)",
		})
		return summary
	}

	if (background) {
		const proc = spawnReviewAgent(provider, model, prompt, { detached: true, stderr: "ignore" })
		proc.unref()
		let output = ""
		let buffer = ""
		proc.stdout?.on("data", (chunk: Buffer) => {
			buffer += chunk.toString()
			const lines = buffer.split("\n")
			buffer = lines.pop() ?? ""
			for (const line of lines) output += parseReviewAgentDelta(line)
		})
		proc.on("close", () => {
			if (buffer.trim()) output += parseReviewAgentDelta(buffer)
			void finalize(output)
		})
		proc.on("error", (err) => {
			void finalize("", err.message)
		})
		return null
	}

	try {
		const output = await runReviewAgent(provider, model, prompt)
		return finalize(output)
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		await finalize("", msg)
		throw err
	}
}

const SESSION_REVIEW_PROMPT = `Review the conversation above and update the skill library. Be \
ACTIVE — most sessions produce at least one skill update, even if small. A pass that does nothing \
is a missed learning opportunity, not a neutral outcome.

Target shape of the library: CLASS-LEVEL skills, each with a rich SKILL.md. Not a long flat list \
of narrow one-session-one-skill entries.

Signals to look for (any one warrants action):
- User corrected your style, tone, format, or verbosity. "Stop doing X", "too verbose", \
"just give me the answer", "remember this" — these are FIRST-CLASS skill signals. Update the \
relevant skill to embed the preference.
- User corrected your workflow, approach, or sequence of steps. Encode it as a pitfall or step \
in the governing skill.
- Non-trivial technique, fix, workaround, or tool-usage pattern emerged that a future session \
would benefit from.
- A skill loaded this session turned out to be wrong or missing a step. Patch it now.

Preference order — prefer the earliest action that fits:
1. UPDATE a currently-loaded skill if it covers the territory.
2. UPDATE an existing skill via skill_view + patch.
3. CREATE a new class-level skill when nothing existing fits. The name must be class-level — \
no PR numbers, error strings, session artifacts, or "fix-X / debug-Y / audit-Z-today" names.

Tools available: skill_manage, skill_view, skill_list. No bash or file tools.

"Nothing to save." is a real option but must not be the default. If the session ran smoothly \
with no corrections and no reusable technique emerged, say "Nothing to save." and stop. Otherwise, act.`

// biome-ignore lint/suspicious/noExplicitAny: messages type not exported from pi-coding-agent
function serializeTranscript(messages: any[]): string {
	const llm = convertToLlm(messages)
	const lines: string[] = []
	for (const msg of llm) {
		if (msg.role !== "user" && msg.role !== "assistant") continue
		const content = Array.isArray(msg.content)
			? msg.content
					.filter((b): b is { type: "text"; text: string } => (b as { type: string }).type === "text")
					.map((b) => b.text)
					.join("")
			: String(msg.content)
		if (!content.trim()) continue
		lines.push(`[${msg.role}] ${content.trim()}`)
	}
	return lines.join("\n\n")
}

export interface ReviewAction {
	action: string
	name?: string
}

export interface ReviewNotification {
	actions: ReviewAction[]
	timestamp: string
}

export const NOTIFICATION_FILE = ".review_notification.json"

export function readAndClearNotification(skillsDir: string): ReviewNotification | null {
	const path = join(skillsDir, NOTIFICATION_FILE)
	try {
		const raw = readFileSync(path, "utf-8")
		unlinkSync(path)
		return JSON.parse(raw) as ReviewNotification
	} catch {
		return null
	}
}

export interface RunSessionReviewOptions {
	provider: string
	model: string
	skillsDir: string
	// biome-ignore lint/suspicious/noExplicitAny: messages type not exported from pi-coding-agent
	messages: any[]
}

export function debugLog(msg: string): void {
	const path = process.env.KIMCHI_REVIEW_LOG
	if (!path) return
	appendFileSync(path, `[${new Date().toISOString()}] ${msg}\n`)
}

export function spawnSessionReview(opts: RunSessionReviewOptions): void {
	const { provider, model, messages } = opts

	debugLog(`spawnSessionReview called: provider=${provider} model=${model} messages=${messages.length}`)

	const transcript = serializeTranscript(messages)
	if (!transcript.trim()) {
		debugLog("spawnSessionReview: empty transcript, skipping")
		return
	}

	debugLog(`transcript serialized: ${transcript.length} chars, ${transcript.split("\n\n").length} turns`)

	const prompt = `${transcript}\n\n---\n\n${SESSION_REVIEW_PROMPT}`
	const reviewLogPath = process.env.KIMCHI_REVIEW_LOG
	let stdoutOption: "ignore" | number = "ignore"
	let logFd: number | undefined
	if (reviewLogPath) {
		appendFileSync(reviewLogPath, `\n=== session-review output ${new Date().toISOString()} ===\n`)
		logFd = openSync(reviewLogPath, "a")
		stdoutOption = logFd
	}

	const proc = spawnReviewAgent(provider, model, prompt, { detached: true, stdout: stdoutOption, stderr: "ignore" })

	if (logFd !== undefined) {
		closeSync(logFd)
	}

	proc.unref()
	proc.on("error", (err) => {
		debugLog(`review agent spawn error: ${err.message}`)
	})

	debugLog(`review agent spawned pid=${proc.pid ?? "unknown"}`)
}
