import { resolveWorkspaceResources, WorkspaceResourcesError } from "./resources.js"
import type { EgressPolicyConfig, WorkspaceResourcesConfig, WorkspaceSpecConfig } from "./types.js"
import type { WorkspaceFileConfig } from "./workspace-file.js"
import { WORKSPACE_FILE_NAME } from "./workspace-file.js"

/**
 * Thrown when `kimchi_workspace.yaml` dependency or egress entries violate
 * the server-side workspace-creation rules. The message lists every
 * violation found (one per line) and is surfaced as a refusal before any
 * network call.
 */
export class WorkspaceSpecError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "WorkspaceSpecError"
	}
}

// The dependency grammar and caps mirror the server's buf.validate rules on
// WorkspaceSpec.dependencies (workspaces_api.proto) — keep the regexes
// byte-identical so client and server accept the same tool references.
// Grammar: [registry:]tool[@version].
const DEPENDENCY_RE = /^([a-z0-9]+:)?[a-zA-Z0-9@][a-zA-Z0-9._/-]*(@(latest|[0-9][0-9A-Za-z.*+_-]*))?$/
// The proto's no_bare_version CEL rule — a tool reference must not start
// with a version (e.g. "@latest").
const BARE_VERSION_RE = /^([a-z0-9]+:)?@(latest|[0-9]).*$/

const MAX_DEPENDENCIES = 50 // buf.validate max_items
const MAX_DEPENDENCY_LENGTH = 128 // buf.validate items.string.max_len
const MAX_EGRESS_ENTRIES = 100 // buf.validate max_items on allowed/denied
const MAX_EGRESS_ENTRY_LENGTH = 253 // buf.validate items.string.max_len

/**
 * Validate and normalize the workspace spec from `kimchi_workspace.yaml`.
 *
 * Values pass through to the server verbatim — validation is client-side
 * fail-fast only. All violations across all sections are collected and
 * reported in one error. Returns undefined when no section is set at all.
 */
export function resolveWorkspaceSpec(config: WorkspaceFileConfig | undefined): WorkspaceSpecConfig | undefined {
	if (!config) return undefined

	const violations: string[] = []
	let resources: WorkspaceResourcesConfig | undefined
	try {
		resources = resolveWorkspaceResources(config.resources)
	} catch (err) {
		if (err instanceof WorkspaceResourcesError) {
			violations.push(...err.message.split("\n"))
		} else {
			throw err
		}
	}
	violations.push(...dependencyViolations(config.dependencies))
	violations.push(...egressPolicyViolations(config.egressPolicy))

	if (violations.length > 0) {
		throw new WorkspaceSpecError(violations.join("\n"))
	}

	const out: WorkspaceSpecConfig = {}
	if (resources) out.resources = resources
	if (config.dependencies && config.dependencies.length > 0) out.dependencies = config.dependencies
	if (config.egressPolicy) out.egressPolicy = config.egressPolicy
	return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Dependency violations (count, per-entry empty/length/grammar/bare-version,
 * duplicates) in the file's own order. Entries pass through unnormalized.
 */
function dependencyViolations(deps: string[] | undefined): string[] {
	if (!deps || deps.length === 0) return []
	const violations: string[] = []
	if (deps.length > MAX_DEPENDENCIES) {
		violations.push(
			`Invalid dependencies in ${WORKSPACE_FILE_NAME} — ${deps.length} entries exceeds the maximum of ${MAX_DEPENDENCIES}.`,
		)
	}
	const seen = new Set<string>()
	for (const [i, d] of deps.entries()) {
		if (seen.has(d)) {
			violations.push(`Invalid dependencies[${i}] value "${d}" in ${WORKSPACE_FILE_NAME} — duplicate entry.`)
			continue
		}
		seen.add(d)
		if (d === "") {
			violations.push(`Invalid dependencies[${i}] in ${WORKSPACE_FILE_NAME} — empty entry.`)
		} else if (d.length > MAX_DEPENDENCY_LENGTH) {
			violations.push(
				`Invalid dependencies[${i}] in ${WORKSPACE_FILE_NAME} — entry exceeds ${MAX_DEPENDENCY_LENGTH} characters.`,
			)
		} else if (!DEPENDENCY_RE.test(d) || BARE_VERSION_RE.test(d)) {
			violations.push(
				`Invalid dependencies[${i}] value "${d}" in ${WORKSPACE_FILE_NAME} — not a valid tool reference (expected [registry:]tool[@version]).`,
			)
		}
	}
	return violations
}

/**
 * Egress-policy violations: API-edge bounds only (list cardinality, entry
 * length, present-but-empty). The entry grammar (lowercase domains, leading
 * `*.` wildcards, IPv4/IPv6 CIDRs, optional `:<port>`) is deliberately NOT
 * checked here — the in-cluster operator is the authoritative validator.
 */
function egressPolicyViolations(policy: EgressPolicyConfig | undefined): string[] {
	if (!policy) return []
	if (policy.denyByDefault === undefined && (policy.allowed ?? []).length === 0 && (policy.denied ?? []).length === 0) {
		return [`Invalid egressPolicy in ${WORKSPACE_FILE_NAME} — set at least one of denyByDefault, allowed, denied.`]
	}
	const violations: string[] = []
	for (const list of [
		{ name: "egressPolicy.allowed", entries: policy.allowed },
		{ name: "egressPolicy.denied", entries: policy.denied },
	] as const) {
		if (!list.entries) continue
		if (list.entries.length > MAX_EGRESS_ENTRIES) {
			violations.push(
				`Invalid ${list.name} in ${WORKSPACE_FILE_NAME} — ${list.entries.length} entries exceeds the maximum of ${MAX_EGRESS_ENTRIES}.`,
			)
		}
		for (const [i, entry] of list.entries.entries()) {
			if (entry === "") {
				violations.push(`Invalid ${list.name}[${i}] in ${WORKSPACE_FILE_NAME} — empty entry.`)
			} else if (entry.length > MAX_EGRESS_ENTRY_LENGTH) {
				violations.push(
					`Invalid ${list.name}[${i}] in ${WORKSPACE_FILE_NAME} — entry exceeds ${MAX_EGRESS_ENTRY_LENGTH} characters.`,
				)
			}
		}
	}
	return violations
}
