/**
 * Side-loop surface contract, modelled on A2UI v0.9: producers describe a card
 * as a flat list of catalog components bound to a data model, and send
 * create/update/delete messages. Only the renderer turns that into terminal
 * output, so a producer can never inject ANSI or layout.
 *
 * Pure: no pi, no I/O. See docs/side-loop.md.
 */

/** Event-bus channel other extensions publish surface messages on. */
export const SIDE_SURFACE_CHANNEL = "kimchi:side-surface"

export type Tone = "ok" | "warn" | "error" | "pending" | "info"

/** A literal, or a JSON-pointer-ish path into the surface's data model (`/ci/summary`). */
export type Bound<T> = T | { path: string }

export type SideComponent =
	| { id: string; type: "text"; text: Bound<string>; tone?: Bound<Tone> }
	| { id: string; type: "status"; label: string; value: Bound<string>; tone?: Bound<Tone> }
	| { id: string; type: "link"; label: Bound<string>; url: Bound<string> }
	| { id: string; type: "kv"; items: { label: string; value: Bound<string> }[] }
	| { id: string; type: "list"; children: string[] }

export const SURFACE_KINDS = ["pr", "artifact", "tests", "deploy", "changes", "context", "message", "custom"] as const
export type SurfaceKind = (typeof SURFACE_KINDS)[number]

/** How the surface was admitted: the d3 decision model or the rule fallback. */
export interface SurfaceVerdict {
	source: "d3" | "rule"
	attention: "interrupt" | "badge"
	confidence?: number
}

export interface SideSurface {
	id: string
	kind: SurfaceKind
	title: string
	/** One-line summary for the dock chip; may be bound. */
	summary?: Bound<string>
	tone?: Bound<Tone>
	link?: string
	components: SideComponent[]
	data: Record<string, unknown>
	verdict?: SurfaceVerdict
	/** Prompt counter when the card appeared; fresh cards stay visible whatever the stage. */
	bornAtPrompt?: number
	createdAt: number
	updatedAt: number
}

export type SurfaceMessage =
	| { op: "create"; surface: Omit<SideSurface, "createdAt" | "updatedAt"> }
	| { op: "update"; id: string; data?: Record<string, unknown>; components?: SideComponent[]; tone?: Bound<Tone> }
	| { op: "delete"; id: string }

const MAX_SURFACES = 12

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Resolve a bound value against the data model; unknown paths resolve to undefined. */
export function resolve<T>(value: Bound<T> | undefined, data: Record<string, unknown>): T | undefined {
	if (!isRecord(value) || typeof value.path !== "string") return value as T | undefined
	let cursor: unknown = data
	for (const key of value.path.split("/").filter(Boolean)) {
		if (!isRecord(cursor)) return undefined
		cursor = cursor[key]
	}
	return cursor as T | undefined
}

/** Validate a message from the bus; anything malformed is dropped rather than half-applied. */
export function readSurfaceMessage(value: unknown): SurfaceMessage | undefined {
	if (!isRecord(value)) return undefined
	if (value.op === "delete" && typeof value.id === "string") return { op: "delete", id: value.id }
	if (value.op === "update" && typeof value.id === "string") {
		return {
			op: "update",
			id: value.id,
			data: isRecord(value.data) ? value.data : undefined,
			components: Array.isArray(value.components) ? (value.components as SideComponent[]) : undefined,
			tone: value.tone as Bound<Tone> | undefined,
		}
	}
	if (value.op === "create" && isRecord(value.surface)) {
		const s = value.surface
		if (typeof s.id !== "string" || typeof s.title !== "string" || !Array.isArray(s.components)) return undefined
		return {
			op: "create",
			surface: {
				id: s.id,
				kind: SURFACE_KINDS.find((k) => k === s.kind) ?? "custom",
				title: s.title,
				summary: s.summary as Bound<string> | undefined,
				tone: s.tone as Bound<Tone> | undefined,
				link: typeof s.link === "string" ? s.link : undefined,
				components: s.components as SideComponent[],
				data: isRecord(s.data) ? s.data : {},
				verdict: s.verdict as SurfaceVerdict | undefined,
			},
		}
	}
	return undefined
}

/** Ordered surface collection; newest first. Bounded so a noisy producer can't grow it forever. */
export class SurfaceStore {
	private surfaces: SideSurface[] = []
	private readonly listeners = new Set<(surfaces: readonly SideSurface[]) => void>()

	list(): readonly SideSurface[] {
		return this.surfaces
	}

	get(id: string): SideSurface | undefined {
		return this.surfaces.find((s) => s.id === id)
	}

	subscribe(listener: (surfaces: readonly SideSurface[]) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	apply(message: SurfaceMessage, now = Date.now()): void {
		if (message.op === "create") {
			const existing = this.get(message.surface.id)
			const next: SideSurface = {
				...message.surface,
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
			}
			this.surfaces = [next, ...this.surfaces.filter((s) => s.id !== next.id)].slice(0, MAX_SURFACES)
		} else if (message.op === "update") {
			const existing = this.get(message.id)
			if (!existing) return
			const next: SideSurface = {
				...existing,
				data: message.data ? { ...existing.data, ...message.data } : existing.data,
				components: message.components ?? existing.components,
				tone: message.tone ?? existing.tone,
				updatedAt: now,
			}
			this.surfaces = this.surfaces.map((s) => (s.id === message.id ? next : s))
		} else {
			const before = this.surfaces.length
			this.surfaces = this.surfaces.filter((s) => s.id !== message.id)
			if (this.surfaces.length === before) return
		}
		for (const listener of this.listeners) listener(this.surfaces)
	}

	clear(): void {
		if (!this.surfaces.length) return
		this.surfaces = []
		for (const listener of this.listeners) listener(this.surfaces)
	}
}
