/**
 * Trigger primitives for behaviour discovery.
 *
 * Two families of pure predicates:
 * - **Session probes** evaluate a pre-resolved `SessionContext` (`cli`,
 *   `gitRemote`, `path`).
 * - **Tool matchers** evaluate a single tool-call event (`tool<T>`).
 *
 * `any`/`all` combinators are overloaded — they compose homogeneously within
 * a slot (probes-with-probes, matchers-with-matchers). Mixing the two kinds
 * is a type error and a runtime error.
 *
 * Each predicate carries a `__spec` describing what it probes / matches. The
 * session resolver walks probe specs to deduplicate I/O; the engines apply
 * the predicate at evaluation time.
 */

import type { SessionContext } from "./session-context.js"
import type { KnownToolName, ToolArgs } from "./tool-args.js"

// ============================================================================
// Session probes
// ============================================================================

export type ProbeSpec =
	| { kind: "cli"; name: string }
	| { kind: "gitRemote"; host: string }
	| { kind: "gitRepo" }
	| { kind: "path"; glob: string }
	| { kind: "any"; children: ProbeSpec[] }
	| { kind: "all"; children: ProbeSpec[] }

export interface SessionProbe {
	(ctx: SessionContext): boolean
	__kind: "session"
	__spec: ProbeSpec
}

function withProbeSpec(fn: (ctx: SessionContext) => boolean, spec: ProbeSpec): SessionProbe {
	const probe = fn as SessionProbe
	probe.__kind = "session"
	probe.__spec = spec
	return probe
}

export function cli(name: string): SessionProbe {
	return withProbeSpec((ctx) => ctx.cliPresent.has(name), { kind: "cli", name })
}

export function gitRemote(host: string): SessionProbe {
	return withProbeSpec((ctx) => ctx.gitRemoteHost === host, { kind: "gitRemote", host })
}

export function gitRepo(): SessionProbe {
	return withProbeSpec((ctx) => ctx.inGitRepo, { kind: "gitRepo" })
}

export function path(glob: string): SessionProbe {
	return withProbeSpec((ctx) => ctx.pathMatches.has(glob), { kind: "path", glob })
}

// ============================================================================
// Tool-call matchers
// ============================================================================

export interface ToolCallEvent {
	toolName: string
	input: Record<string, unknown>
}

export type ToolMatcherSpec =
	| { kind: "tool"; toolName: string }
	| { kind: "any"; children: ToolMatcherSpec[] }
	| { kind: "all"; children: ToolMatcherSpec[] }

export interface ToolMatcher {
	(event: ToolCallEvent): boolean
	__kind: "tool"
	__spec: ToolMatcherSpec
}

function withToolSpec(fn: (event: ToolCallEvent) => boolean, spec: ToolMatcherSpec): ToolMatcher {
	const matcher = fn as ToolMatcher
	matcher.__kind = "tool"
	matcher.__spec = spec
	return matcher
}

/**
 * Match a tool-call event by name, with an optional predicate over typed args.
 *
 * For built-in tool names, `predicate` receives the input typed via `ToolArgs`.
 * Custom tools fall through to the untyped overload.
 */
export function tool<TName extends KnownToolName>(
	name: TName,
	predicate?: (input: ToolArgs[TName]) => boolean,
): ToolMatcher
export function tool(name: string, predicate?: (input: Record<string, unknown>) => boolean): ToolMatcher
export function tool(name: string, predicate?: (input: never) => boolean): ToolMatcher {
	return withToolSpec(
		(event) => {
			if (event.toolName !== name) return false
			if (!predicate) return true
			return predicate(event.input as never)
		},
		{ kind: "tool", toolName: name },
	)
}

// ============================================================================
// Combinators (homogeneous: probes-with-probes or matchers-with-matchers)
// ============================================================================

export function any(...probes: SessionProbe[]): SessionProbe
export function any(...matchers: ToolMatcher[]): ToolMatcher
export function any(...items: Array<SessionProbe | ToolMatcher>): SessionProbe | ToolMatcher {
	return combine("any", items)
}

export function all(...probes: SessionProbe[]): SessionProbe
export function all(...matchers: ToolMatcher[]): ToolMatcher
export function all(...items: Array<SessionProbe | ToolMatcher>): SessionProbe | ToolMatcher {
	return combine("all", items)
}

function combine(kind: "any" | "all", items: Array<SessionProbe | ToolMatcher>): SessionProbe | ToolMatcher {
	if (items.length === 0) {
		throw new Error(`${kind} requires at least one operand`)
	}
	const first = items[0].__kind
	for (const item of items) {
		if (item.__kind !== first) {
			throw new Error(`${kind} cannot mix session probes and tool matchers`)
		}
	}
	return first === "tool" ? combineMatchers(kind, items as ToolMatcher[]) : combineProbes(kind, items as SessionProbe[])
}

function combineProbes(kind: "any" | "all", probes: SessionProbe[]): SessionProbe {
	const reducer = kind === "any" ? "some" : "every"
	return withProbeSpec((ctx) => probes[reducer]((p) => p(ctx)), { kind, children: probes.map((p) => p.__spec) })
}

function combineMatchers(kind: "any" | "all", matchers: ToolMatcher[]): ToolMatcher {
	const reducer = kind === "any" ? "some" : "every"
	return withToolSpec((event) => matchers[reducer]((m) => m(event)), {
		kind,
		children: matchers.map((m) => m.__spec),
	})
}

// ============================================================================
// Spec walkers
// ============================================================================

/** Walk a probe spec tree, calling `visit` on each leaf (non-combinator) node. */
export function walkLeaves(spec: ProbeSpec, visit: (leaf: ProbeSpec) => void): void {
	if (spec.kind === "any" || spec.kind === "all") {
		for (const child of spec.children) walkLeaves(child, visit)
		return
	}
	visit(spec)
}
