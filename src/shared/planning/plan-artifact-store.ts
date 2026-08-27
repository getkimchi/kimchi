/**
 * # Plan Artifact Store
 *
 * A persistence abstraction for the two kinds of plan artifacts that the
 * planning modes produce:
 *
 * | Mode | Artifact | Format | Location | Today |
 * |---|---|---|---|---|
 * | adhoc (`--plan`) | approved plan text | `.md` | `<cwd>/.kimchi/plans/plan-<timestamp>.md` | `saveApprovedPlan` (`permissions/plan-persistence.ts:4-11`) |
 * | ferment | structured ferment artifact | `.json` | `<cwd>/.kimchi/ferments/<id>.json` | inline at `permissions/index.ts:602-642` (pre-Phase-4 placeholder) |
 *
 * ## Why two stores?
 *
 * The two artifacts serve different purposes:
 *
 * - **Adhoc plans** are human-readable Markdown the user can review,
 *   edit, and execute. They're the canonical "what the agent proposed"
 *   artifact and are written once when the user approves the dropdown.
 *
 * - **Ferment artifacts** are structured JSON that the ferment FSM
 *   consumes (phase enumeration, step tracking, gate verdicts, decisions,
 *   memories). They're loaded and mutated throughout the ferment lifecycle,
 *   so they need a richer shape than Markdown.
 *
 * Forcing both into the same `PlanArtifactStore` interface would require a
 * payload union that's wider than either consumer needs, and would leak the
 * ferment FSM's internal shape into the adhoc path. Two distinct concrete
 * stores behind a common interface gives each mode the payload shape it
 * actually uses while keeping the consumer code uniform.
 *
 * ## Interface contract
 *
 * ```ts
 * interface PlanArtifactStore<P> {
 *   save(payload: P, ctx: { cwd: string }): Promise<ArtifactRef>
 *   load(ref: ArtifactRef): Promise<P>
 * }
 * ```
 *
 * - `save(payload, ctx)` writes the artifact to disk and returns an
 *   `ArtifactRef` the caller can use later to load it.
 * - `load(ref)` reads the artifact from disk and returns the typed payload.
 *   Throws if the file is missing, unreadable, or fails schema validation.
 *
 * `ArtifactRef` is a tagged union with `kind: 'adhoc-plan' | 'ferment'`. The
 * `kind` discriminator lets the caller route the ref to the correct store
 * without inspecting the path.
 *
 * ## Session-agnostic by design
 *
 * Like the other Phase 4 registries, both stores are session-agnostic:
 * they take a `cwd: string` (not a pi-mono session) so they can be used in
 * tests, in the future ACP event-bus layer, and in bench/oneshot code paths
 * that don't have a session handle.
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Discriminated union of artifact references. The `kind` discriminator lets
 * callers route a ref to the correct store without inspecting the path.
 */
export type ArtifactRef =
	| { readonly kind: "adhoc-plan"; readonly path: string; readonly format: "markdown" }
	| { readonly kind: "ferment"; readonly path: string; readonly format: "json"; readonly id: string }

/**
 * The context required by `save()`. Just the working directory today; new
 * fields can be added later without breaking existing call sites.
 */
export interface SaveContext {
	readonly cwd: string
}

/**
 * Payload for an adhoc plan (raw Markdown the user can review). This is the
 * same shape `saveApprovedPlan` accepts today.
 */
export interface AdhocPlanPayload {
	readonly planText: string
	/** Optional human-readable hint used for filename generation. */
	readonly name?: string
}

/**
 * Payload for a ferment artifact (structured JSON the ferment FSM mutates).
 * The shape is intentionally narrow at the interface level — concrete
 * ferment artifacts may have additional fields (decisions, memories, etc.)
 * that consumers add via TypeScript subtyping, but the store treats the
 * payload as an opaque JSON-serializable value.
 */
export interface FermentArtifactPayload {
	readonly id: string
	readonly name: string
	readonly goal: string
	readonly status: string
	/** Anything else the ferment FSM wants to persist alongside the core fields. */
	readonly extra?: Readonly<Record<string, unknown>>
}

/**
 * Common interface for both stores. The generic parameter `P` is the payload
 * type: `AdhocPlanPayload` for the adhoc store, `FermentArtifactPayload`
 * for the ferment store.
 */
export interface PlanArtifactStore<P> {
	/** Persist `payload` to disk and return a reference the caller can use to load it later. */
	save(payload: P, ctx: SaveContext): Promise<ArtifactRef>

	/**
	 * Synchronous variant of `save`. The Phase 4 stores are file-local and
	 * don't perform any I/O that requires async; the synchronous API is kept
	 * for backwards compat with the existing `saveApprovedPlan(cwd, planText)`
	 * signature and its tests, which call it without `await`.
	 */
	saveSync(payload: P, ctx: SaveContext): ArtifactRef

	/** Read the artifact at `ref` from disk and return the typed payload. */
	load(ref: ArtifactRef): Promise<P>

	/** Synchronous variant of `load` for callers that can't `await`. */
	loadSync(ref: ArtifactRef): P
}

// ---------------------------------------------------------------------------
// AdhocPlanStore — `.kimchi/plans/<timestamp>.md`
// ---------------------------------------------------------------------------

const ADHOC_DIR = ".kimchi/plans"
const ADHOC_PREFIX = "plan-"

/**
 * Persists approved `--plan` mode artifacts as Markdown in
 * `<cwd>/.kimchi/plans/plan-<timestamp>.md`. Mirrors the existing
 * `saveApprovedPlan` semantics exactly:
 *
 * - Creates the directory if it doesn't exist.
 * - Filename uses `Date.now()` for ordering (no collisions within one process).
 * - Returns the absolute path so the caller can show it to the user.
 */
export class AdhocPlanStore implements PlanArtifactStore<AdhocPlanPayload> {
	async save(payload: AdhocPlanPayload, ctx: SaveContext): Promise<ArtifactRef> {
		return this.saveSync(payload, ctx)
	}

	saveSync(payload: AdhocPlanPayload, ctx: SaveContext): ArtifactRef {
		const plansDir = resolve(ctx.cwd, ADHOC_DIR)
		if (!existsSync(plansDir)) mkdirSync(plansDir, { recursive: true })
		const fileName = `${ADHOC_PREFIX}${Date.now()}.md`
		const filePath = resolve(plansDir, fileName)
		writeFileSync(filePath, payload.planText, "utf-8")
		return { kind: "adhoc-plan", path: filePath, format: "markdown" }
	}

	async load(ref: ArtifactRef): Promise<AdhocPlanPayload> {
		return this.loadSync(ref)
	}

	loadSync(ref: ArtifactRef): AdhocPlanPayload {
		if (ref.kind !== "adhoc-plan") {
			throw new Error(`AdhocPlanStore.load: ref.kind is '${ref.kind}', expected 'adhoc-plan'`)
		}
		const planText = readFileSync(ref.path, "utf-8")
		return { planText }
	}
}

// ---------------------------------------------------------------------------
// FermentPlanStore — `.kimchi/ferments/<id>.json`
// ---------------------------------------------------------------------------

const FERMENT_DIR = ".kimchi/ferments"
const FERMENT_EXT = ".json"

/**
 * Persists ferment artifacts as JSON in `<cwd>/.kimchi/ferments/<id>.json`.
 * Mirrors the existing inline writer at `permissions/index.ts:602-642`.
 *
 * - The `id` field in the payload is the canonical filename stem.
 * - Extra fields (`payload.extra`) are merged into the top-level JSON
 *   object so the ferment FSM's `decisions`, `memories`, etc. land in the
 *   same file rather than a separate sidecar.
 * - `load` returns the parsed JSON verbatim; the caller is responsible for
 *   narrowing it to a concrete ferment shape.
 */
export class FermentPlanStore implements PlanArtifactStore<FermentArtifactPayload> {
	async save(payload: FermentArtifactPayload, ctx: SaveContext): Promise<ArtifactRef> {
		return this.saveSync(payload, ctx)
	}

	saveSync(payload: FermentArtifactPayload, ctx: SaveContext): ArtifactRef {
		const fermentsDir = resolve(ctx.cwd, FERMENT_DIR)
		if (!existsSync(fermentsDir)) mkdirSync(fermentsDir, { recursive: true })
		const fileName = `${payload.id}${FERMENT_EXT}`
		const filePath = resolve(fermentsDir, fileName)
		const { id, name, goal, status, extra } = payload
		const artifact = { id, name, goal, status, ...(extra ?? {}) }
		writeFileSync(filePath, JSON.stringify(artifact, null, 2), "utf-8")
		return { kind: "ferment", path: filePath, format: "json", id: payload.id }
	}

	async load(ref: ArtifactRef): Promise<FermentArtifactPayload> {
		return this.loadSync(ref)
	}

	loadSync(ref: ArtifactRef): FermentArtifactPayload {
		if (ref.kind !== "ferment") {
			throw new Error(`FermentPlanStore.load: ref.kind is '${ref.kind}', expected 'ferment'`)
		}
		const raw = readFileSync(ref.path, "utf-8")
		const parsed = JSON.parse(raw) as Record<string, unknown>
		// id falls back to ref.id (the filename stem) for legacy artifacts written
		// before id was stored in the JSON body.
		const id = typeof parsed.id === "string" ? parsed.id : ref.id
		// name and goal are required — throw a clear error rather than returning
		// an empty string that silently produces a semantically invalid artifact.
		if (typeof parsed.name !== "string" || parsed.name.trim() === "") {
			throw new Error(`FermentPlanStore.load: missing required field 'name' in ${ref.path}`)
		}
		if (typeof parsed.goal !== "string" || parsed.goal.trim() === "") {
			throw new Error(`FermentPlanStore.load: missing required field 'goal' in ${ref.path}`)
		}
		const name = parsed.name
		const goal = parsed.goal
		// status defaults to 'draft' for backwards compat with legacy artifacts
		// that predate the status field.
		const status = typeof parsed.status === "string" ? parsed.status : "draft"
		const { id: _id, name: _name, goal: _goal, status: _status, ...rest } = parsed
		void _id
		void _name
		void _goal
		void _status
		return { id, name, goal, status, extra: rest }
	}
}
