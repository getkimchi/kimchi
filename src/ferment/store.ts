/**
 * FermentStorage v4 — CRUD on ferments/*.json
 *
 * - One JSON file per ferment, named <id>.json
 * - Atomic writes via tmp + rename
 * - Name uniqueness enforcement (case-insensitive)
 * - Resolve by id or fuzzy name match
 * - Backward compat: reads V1→V2→V3 and upgrades to V4 on load
 * - Per-project storage: ferments live in .kimchi/ferments/ inside the repo, or global fallback
 */

import { execSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"
import { v7 as uuidv7 } from "uuid"

import { activateSinglePhase, settleAfterPhaseTerminal } from "./lifecycle.js"
import type {
	Decision,
	Ferment,
	FermentStatus,
	FermentV3,
	FermentWorkMode,
	JudgeGrade,
	Memory,
	MemoryCategory,
	Phase,
	Scoping,
	Step,
	StepResult,
} from "./types.js"

export interface FermentListItem {
	id: string
	name: string
	description?: string
	status: FermentStatus
	phaseCount: number
	createdAt: string
}

export class FermentError extends Error {
	constructor(
		message: string,
		public readonly code?: string,
	) {
		super(message)
		this.name = "FermentError"
	}
}

// ─── Directory resolution ─────────────────────────────────────────────────────

// Memoize project root per cwd — `detectProjectRoot()` does up to N existsSync
// calls walking up the tree, and is invoked on every `new FermentStorage()`.
const projectRootCache = new Map<string, string>()

export function detectProjectRoot(cwd: string = process.cwd()): string {
	const key = resolve(cwd)
	const cached = projectRootCache.get(key)
	if (cached !== undefined) return cached

	// Walk up to find a .git boundary (git repo root). Fall back to the closest
	// package.json if no git root is found, then to cwd.
	let current = key
	let firstPackageJson: string | undefined
	const stop = resolve(current, "/")
	while (current !== stop) {
		if (existsSync(resolve(current, ".git"))) {
			projectRootCache.set(key, current)
			return current
		}
		if (firstPackageJson === undefined && existsSync(resolve(current, "package.json"))) {
			firstPackageJson = current
		}
		const parent = dirname(current)
		if (parent === current) break
		current = parent
	}
	const result = firstPackageJson ?? cwd
	projectRootCache.set(key, result)
	return result
}

export function getGlobalFermentsDir(): string {
	return resolve(homedir(), ".config", "kimchi", "ferments")
}

export function resolveFermentsDir(cwd?: string): string {
	// Explicit env override wins over project / global resolution. Used by
	// terminal-bench-2 to land per-trial ferments under the bind-mounted
	// /logs/agent/ferments directory; also handy for tests that pin storage
	// to a tmpdir without touching the working tree.
	const envDir = process.env.KIMCHI_FERMENTS_DIR
	if (envDir) return envDir
	const project = detectProjectRoot(cwd)
	if (project) return resolve(project, ".kimchi", "ferments")
	return getGlobalFermentsDir()
}

// ─── Git worktree capture ─────────────────────────────────────────────────────

export function captureWorktree(cwd?: string): import("./types.js").FermentWorktree {
	const path = detectProjectRoot(cwd) ?? process.cwd()
	let branch: string | undefined
	let commit: string | undefined
	try {
		branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: path, encoding: "utf-8", timeout: 1000 }).trim()
	} catch {
		// not a git repo or git not available
	}
	try {
		commit = execSync("git rev-parse HEAD", { cwd: path, encoding: "utf-8", timeout: 1000 }).trim()
	} catch {
		// not a git repo or git not available
	}
	return { path, branch, commit }
}

// ─── V3 → V4 migration ────────────────────────────────────────────────────────

function mapV3BatchRefStatus(s: string): Phase["status"] {
	switch (s) {
		case "completed":
			return "completed"
		case "abandoned":
			return "skipped"
		case "active":
			return "active"
		case "planned":
			return "planned"
		default:
			return "planned"
	}
}

function upgradeV3toV4(raw: FermentV3): Ferment {
	// Map old 7 statuses to 5 new statuses
	const statusMap: Record<FermentV3["status"], FermentStatus> = {
		pending_goal: "draft",
		planned: "planned",
		batch_planned: "planned",
		executing: "running",
		paused: "paused",
		completed: "complete",
		abandoned: "complete",
	}

	// Merge plannedBatches + batchRefs into phases[]
	const phases: Phase[] = raw.plannedBatches.map((pb, idx) => {
		// Find matching batchRef if any
		const ref = raw.batchRefs.find((br) => br.plannedBatchId === pb.id)
		// Map statuses
		const phaseStatus = ref ? mapV3BatchRefStatus(ref.status) : mapV3BatchRefStatus(pb.status)

		return {
			id: pb.id,
			index: pb.index,
			name: pb.name,
			description: pb.description,
			goal: pb.goal,
			status: phaseStatus,
			startedAt: ref ? undefined : pb.status === "active" ? raw.updatedAt : undefined,
			completedAt: ref?.completedAt,
			summary: ref?.summary,
			steps: [],
			parallel: false,
		}
	})

	// If an actualBatchRef exists but no matching plannedBatch, add it as a stray ref
	for (const ref of raw.batchRefs) {
		if (ref.plannedBatchId) continue // already handled above
		phases.push({
			id: ref.id,
			index: phases.length + 1,
			name: ref.name ?? "Unknown batch",
			description: "",
			goal: "",
			status: ref.status === "completed" ? "completed" : ref.status === "abandoned" ? "skipped" : "planned",
			completedAt: ref.completedAt,
			summary: ref.summary,
			steps: [],
			parallel: false,
		})
	}

	// Sort by index, reassign indices
	phases.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
	phases.forEach((p, i) => {
		p.index = i + 1
	})

	// Determine active phase
	const activePhaseId = phases.find((p) => p.status === "active")?.id

	return {
		id: raw.id,
		name: raw.name,
		description: raw.description,
		status: statusMap[raw.status] ?? "draft",
		mode: "auto",
		activePhaseId,
		goal: raw.goal,
		successCriteria: raw.successCriteria,
		worktree: { path: detectProjectRoot() ?? process.cwd() },
		scoping: {},
		phases,
		decisions: raw.decisions ?? [],
		memories: raw.memories ?? [],
		createdAt: raw.createdAt,
		updatedAt: raw.updatedAt,
	}
}

// ─── Storage ───────────────────────────────────────────────────────────────────

// Module-level in-memory cache. Each Ferment is keyed by id (full UUID).
// Invalidated on write/delete. Avoids re-reading + re-parsing the JSON on every
// tool call — a hot path that previously did 4–6 disk reads per tool execution.
const fermentCache = new Map<string, Ferment>()

/** Clear the in-memory ferment cache. Useful for tests; also invoked on file mutations. */
export function clearFermentCache(): void {
	fermentCache.clear()
}

export class FermentStorage {
	private readonly dir: string

	constructor(dir?: string) {
		this.dir = dir ?? resolveFermentsDir()
		this.ensureDir()
	}

	private ensureDir(): void {
		if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
	}

	private filePath(id: string): string {
		return resolve(this.dir, `${id}.json`)
	}

	// ─── Core CRUD ─────────────────────────────────────────────────────────────

	/** Load a ferment by ID. Migrations: V1→V2→V3→V4 applied on read and persisted. */
	get(id: string): Ferment | undefined {
		return this.loadById(id)
	}

	private loadById(id: string): Ferment | undefined {
		// Cache hit on full UUID
		const cached = fermentCache.get(id)
		if (cached) return cached

		// 1. Exact match (full UUID → direct file read)
		try {
			const raw = readFileSync(this.filePath(id), "utf-8")
			const parsed = JSON.parse(raw) as unknown
			if (hasV3Shape(parsed)) {
				const v4 = upgradeV3toV4(parsed as FermentV3)
				this.write(v4) // populates cache
				return v4
			}
			if (hasV4Shape(parsed)) {
				normalizeFerment(parsed as Ferment)
				const f = parsed as Ferment
				fermentCache.set(f.id, f)
				return f
			}
			return undefined
		} catch {
			// Fall through to prefix matching
		}

		// 2. ID prefix match (the LLM may pass a truncated UUID like "019dfd4f")
		// Avoid guessing if the input looks like a name with spaces or quotes
		if (id.includes(" ") || id.includes('"')) return undefined
		const all = this.list()
		const matches = all.filter((f) => f.id.toLowerCase().startsWith(id.toLowerCase()))
		if (matches.length === 1) {
			return this.loadById(matches[0].id)
		}
		return undefined
	}

	/** List all ferments as summary items. */
	list(): FermentListItem[] {
		this.ensureDir()
		let files: string[]
		try {
			files = readdirSync(this.dir).filter((f) => f.endsWith(".json"))
		} catch {
			return []
		}

		const items: FermentListItem[] = []
		for (const file of files) {
			try {
				const raw = readFileSync(resolve(this.dir, file), "utf-8")
				const parsed = JSON.parse(raw) as unknown
				const ferment = hasV3Shape(parsed) ? upgradeV3toV4(parsed as FermentV3) : (parsed as Ferment)
				items.push({
					id: ferment.id,
					name: ferment.name,
					description: ferment.description,
					status: ferment.status,
					phaseCount: ferment.phases.length,
					createdAt: ferment.createdAt,
				})
			} catch {
				// skip corrupted
			}
		}
		return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
	}

	/** Resolve by ID, name, or prefix. Throws FermentError if ambiguous. */
	resolve(value: string): Ferment | undefined {
		// 1. Try exact ID match
		const byId = this.get(value)
		if (byId) return byId

		// 2. Try ID prefix match if value looks like an ID prefix
		if (value.length >= 3) {
			const all = this.list()
			const idMatches = all.filter((f) => f.id.toLowerCase().startsWith(value.toLowerCase()))
			if (idMatches.length === 1) return this.get(idMatches[0].id)
			if (idMatches.length > 1) {
				throw new FermentError(
					`Ambiguous ID prefix "${value}". Matches: ${idMatches.map((m) => `${m.name} (${m.id.slice(0, 8)}...)`).join(", ")}`,
					"AMBIGUOUS",
				)
			}
		}

		// 3. Try exact name match (case-insensitive)
		const all = this.list()
		const nameMatch = all.find((f) => f.name.toLowerCase() === value.toLowerCase())
		if (nameMatch) return this.get(nameMatch.id)

		// 4. Try name prefix match
		const prefix = value.toLowerCase()
		const matches = all.filter((f) => f.name.toLowerCase().startsWith(prefix))
		if (matches.length === 1) return this.get(matches[0].id)
		if (matches.length > 1) {
			throw new FermentError(
				`Ambiguous name "${value}". Matches: ${matches.map((m) => `"${m.name}" (${m.id.slice(0, 8)}...)`).join(", ")}`,
				"AMBIGUOUS",
			)
		}
		return undefined
	}

	/** Accepts a name. Caller should already have shortened it if desired. */
	create(name: string, description?: string): Ferment {
		let shortName = name.trim()
		// De-duplicate: if name collides, append a counter
		const all = this.list()
		let suffix = 1
		const baseName = shortName
		while (all.some((f) => f.name.toLowerCase() === shortName.toLowerCase())) {
			shortName = `${baseName} (${suffix})`
			suffix++
		}
		const now = new Date().toISOString()
		const ferment: Ferment = {
			id: uuidv7(),
			name: shortName,
			description,
			status: "draft",
			mode: "plan",
			worktree: captureWorktree(),
			scoping: {},
			phases: [],
			decisions: [],
			memories: [],
			createdAt: now,
			updatedAt: now,
		}

		this.write(ferment)
		return ferment
	}

	/** Delete by ID. Returns true if deleted. */
	delete(id: string): boolean {
		const path = this.filePath(id)
		if (!existsSync(path)) return false
		unlinkSync(path)
		fermentCache.delete(id)
		return true
	}

	// ─── Atomic write helper ───────────────────────────────────────────────────

	/** Atomic write of a ferment. Public so callers can persist results from
	 *  the pure state machine without going through storage's mutation helpers. */
	write(ferment: Ferment): void {
		const path = this.filePath(ferment.id)
		const tmp = `${path}.${process.pid}.tmp`
		mkdirSync(dirname(path), { recursive: true })
		writeFileSync(tmp, `${JSON.stringify(ferment, null, 2)}\n`, "utf-8")
		renameSync(tmp, path)
		// Update cache with the freshly-written ferment (avoid stale reads next get())
		fermentCache.set(ferment.id, ferment)
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// Convenience mutation helpers
	//
	// PREFER `applyAndPersist` from extensions/ferment/tool-helpers.ts when
	// writing new ferment tools — it routes mutations through the pure state
	// machine and gets you typed errors + invariant checks for free.
	//
	// These helpers remain for:
	//   - TUI command handlers (/progress overlay, /ferment switch/abandon)
	//   - Test fixtures that need to bypass the state machine
	//
	// They write directly without going through the state machine, so they DO
	// NOT enforce invariants. Caller is responsible for state validity.
	// ═══════════════════════════════════════════════════════════════════════════

	updateMode(id: string, mode: FermentWorkMode): Ferment | undefined {
		const f = this.get(id)
		if (!f) return undefined
		const updated: Ferment = { ...f, mode, updatedAt: new Date().toISOString() }
		this.write(updated)
		return updated
	}

	updateConstraints(id: string, constraints: string[]): Ferment | undefined {
		const f = this.get(id)
		if (!f) return undefined
		const updated: Ferment = { ...f, constraints, updatedAt: new Date().toISOString() }
		this.write(updated)
		return updated
	}

	updateStatus(id: string, status: FermentStatus): Ferment | undefined {
		const f = this.get(id)
		if (!f) return undefined
		const updated: Ferment = { ...f, status, updatedAt: new Date().toISOString() }
		this.write(updated)
		return updated
	}

	updateGoal(id: string, goal?: string, successCriteria?: string): Ferment | undefined {
		const f = this.get(id)
		if (!f) return undefined
		const updated: Ferment = { ...f, goal, successCriteria, updatedAt: new Date().toISOString() }
		this.write(updated)
		return updated
	}

	/** Update goal scoping field. */
	setScopingGoal(id: string, answer: string): Ferment | undefined {
		const f = this.get(id)
		if (!f) return undefined
		const updated: Ferment = {
			...f,
			goal: answer,
			scoping: { ...f.scoping, goal: { answer, confirmedAt: new Date().toISOString() } },
			updatedAt: new Date().toISOString(),
		}
		this.write(updated)
		return updated
	}

	/** Update criteria scoping field. */
	setScopingCriteria(id: string, answer: string): Ferment | undefined {
		const f = this.get(id)
		if (!f) return undefined
		const updated: Ferment = {
			...f,
			successCriteria: answer,
			scoping: { ...f.scoping, criteria: { answer, confirmedAt: new Date().toISOString() } },
			updatedAt: new Date().toISOString(),
		}
		this.write(updated)
		return updated
	}

	/** Update constraints scoping field. */
	setScopingConstraints(id: string, constraints: string[]): Ferment | undefined {
		const f = this.get(id)
		if (!f) return undefined
		const answer = constraints.join(", ")
		const updated: Ferment = {
			...f,
			constraints,
			scoping: { ...f.scoping, constraints: { answer, confirmedAt: new Date().toISOString() } },
			updatedAt: new Date().toISOString(),
		}
		this.write(updated)
		return updated
	}

	/** Update phases scoping field (marks phases as answered after user review). */
	setScopingPhases(id: string, phases: Phase[]): Ferment | undefined {
		const f = this.get(id)
		if (!f) return undefined
		const answer = phases.map((p) => p.name).join(", ")
		const updated: Ferment = {
			...f,
			phases,
			scoping: { ...f.scoping, phases: { answer, confirmedAt: new Date().toISOString() } },
			updatedAt: new Date().toISOString(),
		}
		this.write(updated)
		return updated
	}

	/** Mark a step as failed with an optional error message. */
	failStep(id: string, phaseId: string, stepId: string, error?: string): Ferment | undefined {
		return this.updateStep(id, phaseId, stepId, {
			status: "failed",
			completedAt: new Date().toISOString(),
			result: error ? { success: false, stderr: error, completedAt: new Date().toISOString() } : undefined,
		})
	}

	/** Mark a phase as failed with a reason. */
	failPhase(id: string, phaseId: string, reason: string): Ferment | undefined {
		const f = this.get(id)
		if (!f) return undefined
		const now = new Date().toISOString()
		const phases = f.phases.map((p) =>
			p.id === phaseId ? { ...p, status: "failed" as const, summary: reason, completedAt: now } : p,
		)
		const updated = settleAfterPhaseTerminal(f, phases, now)
		this.write(updated)
		return updated
	}

	/** Abandon a ferment (terminal state, like complete but not success). */
	abandonFerment(id: string, reason?: string): Ferment | undefined {
		const f = this.get(id)
		if (!f) return undefined
		const now = new Date().toISOString()
		const updated: Ferment = {
			...f,
			status: "abandoned",
			description: reason ? `${f.description ?? ""}\n\nAbandoned: ${reason}`.trim() : f.description,
			updatedAt: now,
		}
		this.write(updated)
		return updated
	}

	/** Rename a ferment. */
	rename(id: string, name: string): Ferment | undefined {
		const f = this.get(id)
		if (!f) return undefined
		const updated: Ferment = { ...f, name, updatedAt: new Date().toISOString() }
		this.write(updated)
		return updated
	}

	// ─── Phase Lifecycle ────────────────────────────────────────────────────────

	/** Overwrite phases array (used during scope_ferment). */
	setPhases(id: string, phases: Phase[]): Ferment | undefined {
		const f = this.get(id)
		if (!f) return undefined
		const updated: Ferment = { ...f, phases, updatedAt: new Date().toISOString() }
		this.write(updated)
		return updated
	}

	/** Activate a phase: set it to "active" and deactivate any other active phase. */
	activatePhase(id: string, phaseId: string): Ferment | undefined {
		const f = this.get(id)
		if (!f) return undefined
		const now = new Date().toISOString()
		const updated: Ferment = {
			...f,
			phases: activateSinglePhase(f.phases, phaseId, now),
			activePhaseId: phaseId,
			lastActiveAt: now,
			updatedAt: now,
		}
		this.write(updated)
		return updated
	}

	/** Activate all phases sharing the same groupIndex (parallel group). */
	activatePhaseGroup(id: string, groupIndex: number): Ferment | undefined {
		const f = this.get(id)
		if (!f) return undefined
		const now = new Date().toISOString()
		const groupPhases = f.phases.filter((p) => p.groupIndex === groupIndex && p.status === "planned")
		if (groupPhases.length === 0) return undefined
		const firstId = groupPhases[0].id
		const updated: Ferment = {
			...f,
			phases: f.phases.map((p) => {
				if (p.groupIndex === groupIndex && p.status === "planned")
					return { ...p, status: "active" as const, startedAt: now }
				return p
			}),
			activePhaseId: firstId,
			lastActiveAt: now,
			updatedAt: now,
		}
		this.write(updated)
		return updated
	}

	/** Check if a ferment is fully terminal (all phases done/skipped/failed). */
	isFullyTerminal(id: string): boolean {
		const f = this.get(id)
		if (!f) return false
		return f.phases.every((p) => p.status === "completed" || p.status === "skipped" || p.status === "failed")
	}

	/** Mark a phase as completed with a summary. */
	completePhase(id: string, phaseId: string, summary: string): Ferment | undefined {
		const f = this.get(id)
		if (!f) return undefined
		const now = new Date().toISOString()
		const phases = f.phases.map((p) =>
			p.id === phaseId ? { ...p, status: "completed" as const, summary, completedAt: now } : p,
		)
		const updated = settleAfterPhaseTerminal(f, phases, now)
		this.write(updated)
		return updated
	}

	/** Skip a phase. */
	skipPhase(id: string, phaseId: string, reason?: string): Ferment | undefined {
		const f = this.get(id)
		if (!f) return undefined
		const now = new Date().toISOString()
		const phases = f.phases.map((p) =>
			p.id === phaseId ? { ...p, status: "skipped" as const, summary: reason ?? "Skipped", completedAt: now } : p,
		)
		const updated = settleAfterPhaseTerminal(f, phases, now)
		this.write(updated)
		return updated
	}

	/** Refine phase: set its steps. */
	refinePhase(id: string, phaseId: string, steps: Step[]): Ferment | undefined {
		const f = this.get(id)
		if (!f) return undefined
		const updated: Ferment = {
			...f,
			phases: f.phases.map((p) =>
				p.id === phaseId ? { ...p, steps: steps.map((s, i) => ({ ...s, index: i + 1 })) } : p,
			),
			updatedAt: new Date().toISOString(),
		}
		this.write(updated)
		return updated
	}

	// ─── Step Lifecycle ─────────────────────────────────────────────────────────

	private findPhase(f: Ferment, phaseId: string): Phase | undefined {
		return f.phases.find((p) => p.id === phaseId)
	}

	startStep(id: string, phaseId: string, stepId: string): Ferment | undefined {
		return this.updateStep(id, phaseId, stepId, { status: "running", startedAt: new Date().toISOString() })
	}

	completeStep(id: string, phaseId: string, stepId: string): Ferment | undefined {
		return this.updateStep(id, phaseId, stepId, {
			status: "done",
			completedAt: new Date().toISOString(),
		})
	}

	skipStep(id: string, phaseId: string, stepId: string): Ferment | undefined {
		return this.updateStep(id, phaseId, stepId, {
			status: "skipped",
			completedAt: new Date().toISOString(),
		})
	}

	verifyStep(id: string, phaseId: string, stepId: string, result: StepResult): Ferment | undefined {
		return this.updateStep(id, phaseId, stepId, {
			status: result.success ? "verified" : "done",
			completedAt: result.completedAt,
			result,
		})
	}

	setStepGrade(id: string, phaseId: string, stepId: string, grade: JudgeGrade): Ferment | undefined {
		return this.updateStep(id, phaseId, stepId, { grade })
	}

	setPhaseGrade(id: string, phaseId: string, grade: JudgeGrade): Ferment | undefined {
		const f = this.get(id)
		if (!f) return undefined
		const updated: Ferment = {
			...f,
			phases: f.phases.map((p) => (p.id === phaseId ? { ...p, grade } : p)),
			updatedAt: new Date().toISOString(),
		}
		this.write(updated)
		return updated
	}

	setFermentGrade(id: string, grade: JudgeGrade): Ferment | undefined {
		const f = this.get(id)
		if (!f) return undefined
		const updated: Ferment = { ...f, grade, updatedAt: new Date().toISOString() }
		this.write(updated)
		return updated
	}

	/** Update a step in a phase. */
	private updateStep(id: string, phaseId: string, stepId: string, patch: Partial<Step>): Ferment | undefined {
		const f = this.get(id)
		if (!f) return undefined
		const updated: Ferment = {
			...f,
			phases: f.phases.map((p) =>
				p.id === phaseId
					? {
							...p,
							steps: p.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)),
						}
					: p,
			),
			updatedAt: new Date().toISOString(),
		}
		this.write(updated)
		return updated
	}

	// ─── Decisions & Memories ───────────────────────────────────────────────────

	addDecision(id: string, title: string, description: string, phaseId?: string, stepId?: string): Ferment | undefined {
		const f = this.get(id)
		if (!f) return undefined
		const decisions = f.decisions
		// Compute next ID as max existing index + 1 (resilient to gaps from edits)
		const maxIdx = decisions.reduce((m, d) => {
			const n = Number.parseInt(d.id.slice(1), 10)
			return Number.isFinite(n) && n > m ? n : m
		}, 0)
		const decision: Decision = {
			id: `D${String(maxIdx + 1).padStart(3, "0")}`,
			title,
			description,
			phaseId,
			stepId,
			createdAt: new Date().toISOString(),
		}
		const updated: Ferment = {
			...f,
			decisions: [...decisions, decision],
			updatedAt: decision.createdAt,
		}
		this.write(updated)
		return updated
	}

	addMemory(
		id: string,
		category: MemoryCategory,
		content: string,
		phaseId?: string,
		stepId?: string,
	): Ferment | undefined {
		const f = this.get(id)
		if (!f) return undefined
		const memories = f.memories
		const maxIdx = memories.reduce((m, mem) => {
			const n = Number.parseInt(mem.id.slice(1), 10)
			return Number.isFinite(n) && n > m ? n : m
		}, 0)
		const memory: Memory = {
			id: `M${String(maxIdx + 1).padStart(3, "0")}`,
			category,
			content,
			phaseId,
			stepId,
			createdAt: new Date().toISOString(),
		}
		const updated: Ferment = {
			...f,
			memories: [...memories, memory],
			updatedAt: memory.createdAt,
		}
		this.write(updated)
		return updated
	}

	// ─── Migration (global → project-local) ─────────────────────────────────────

	migrateGlobalToProject(globalDir: string, projectDir: string): number {
		if (!existsSync(globalDir)) return 0
		let migrated = 0
		let files: string[]
		try {
			files = readdirSync(globalDir).filter((f) => f.endsWith(".json"))
		} catch {
			return 0
		}
		mkdirSync(projectDir, { recursive: true })
		for (const file of files) {
			try {
				const src = resolve(globalDir, file)
				const raw = readFileSync(src, "utf-8")
				const parsed = JSON.parse(raw) as unknown
				const ferment = hasV3Shape(parsed) ? upgradeV3toV4(parsed as FermentV3) : (parsed as Ferment)
				const dest = resolve(projectDir, file)
				writeFileSync(dest, `${JSON.stringify(ferment, null, 2)}\n`, "utf-8")
				migrated++
			} catch {
				// skip corrupted
			}
		}
		return migrated
	}
}

// ─── Shape detection helpers ──────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v)
}

function hasV3Shape(v: unknown): boolean {
	if (!isObject(v)) return false
	return Array.isArray(v.batchRefs) || Array.isArray(v.plannedBatches)
}

function hasV4Shape(v: unknown): boolean {
	if (!isObject(v)) return false
	if (!Array.isArray(v.phases)) return false
	if (Array.isArray(v.batchRefs) || Array.isArray(v.plannedBatches)) return false
	// Validate the minimum required fields so a corrupted file is rejected early
	// instead of silently producing undefined behavior downstream.
	if (typeof v.id !== "string" || typeof v.name !== "string") return false
	if (typeof v.status !== "string") return false
	if (!isObject(v.scoping ?? {}) || (v.scoping !== undefined && !isObject(v.scoping))) return false
	return true
}

function normalizeFerment(f: Ferment): void {
	if (!f.worktree) {
		f.worktree = { path: detectProjectRoot() ?? process.cwd() }
	}
	if (!f.scoping) {
		f.scoping = {}
	} else if ("goalAnswered" in f.scoping) {
		// Migrate from v4.0 boolean scoping to v4.1 answer-based scoping
		const old = f.scoping as Record<string, unknown>
		const now = new Date().toISOString()
		f.scoping = {}
		if (old.goalAnswered && f.goal) {
			f.scoping.goal = { answer: f.goal, confirmedAt: now }
		}
		if (old.criteriaAnswered && f.successCriteria) {
			f.scoping.criteria = { answer: f.successCriteria, confirmedAt: now }
		}
		if (old.constraintsAnswered) {
			f.scoping.constraints = { answer: (f.constraints ?? []).join(", "), confirmedAt: now }
		}
		if (old.phasesAnswered) {
			f.scoping.phases = { answer: `${f.phases.length} phases`, confirmedAt: now }
		}
	}
}
