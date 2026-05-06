/**
 * Trigger primitives for behaviour discovery.
 *
 * Factories return pure predicates over a pre-resolved `SessionContext` (probes)
 * with a `__spec` describing what they probe. The resolver walks the union of
 * declared specs at session start and runs each kind of probe at most once,
 * even when multiple behaviours declare the same probe.
 *
 * Tool-call matchers and combinator parameterisation by tool args land in
 * later phases. The `any`/`all` combinators are session-probe-only here.
 */

import type { SessionContext } from "./session-context.js"

export type ProbeSpec =
	| { kind: "cli"; name: string }
	| { kind: "gitRemote"; host: string }
	| { kind: "path"; glob: string }
	| { kind: "any"; children: ProbeSpec[] }
	| { kind: "all"; children: ProbeSpec[] }

export interface SessionProbe {
	(ctx: SessionContext): boolean
	__spec: ProbeSpec
}

function withSpec(fn: (ctx: SessionContext) => boolean, spec: ProbeSpec): SessionProbe {
	const probe = fn as SessionProbe
	probe.__spec = spec
	return probe
}

export function cli(name: string): SessionProbe {
	return withSpec((ctx) => ctx.cliPresent.has(name), { kind: "cli", name })
}

export function gitRemote(host: string): SessionProbe {
	return withSpec((ctx) => ctx.gitRemoteHost === host, { kind: "gitRemote", host })
}

export function path(glob: string): SessionProbe {
	return withSpec((ctx) => ctx.pathMatches.has(glob), { kind: "path", glob })
}

export function any(...probes: SessionProbe[]): SessionProbe {
	return withSpec((ctx) => probes.some((p) => p(ctx)), { kind: "any", children: probes.map((p) => p.__spec) })
}

export function all(...probes: SessionProbe[]): SessionProbe {
	return withSpec((ctx) => probes.every((p) => p(ctx)), { kind: "all", children: probes.map((p) => p.__spec) })
}

/** Walk a probe spec tree, calling `visit` on each leaf (non-combinator) node. */
export function walkLeaves(spec: ProbeSpec, visit: (leaf: ProbeSpec) => void): void {
	if (spec.kind === "any" || spec.kind === "all") {
		for (const child of spec.children) walkLeaves(child, visit)
		return
	}
	visit(spec)
}
