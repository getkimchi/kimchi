import { WORKSPACE_RESOURCE_FIELDS, type WorkspaceResourcesConfig } from "./types.js"
import { WORKSPACE_FILE_NAME } from "./workspace-file.js"

/**
 * Thrown when a resource value in `kimchi_workspace.yaml` is not a valid,
 * positive Kubernetes quantity. The message names the field and the offending
 * value; surfaced as a refusal before any network call.
 */
export class WorkspaceResourcesError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "WorkspaceResourcesError"
	}
}

/**
 * Kubernetes quantity: numeric part (optionally decimal), then EITHER an
 * exponent OR a decimal-SI (n,u,m,k,M,G,T,P,E) / binary-SI (Ki…Ei) suffix —
 * never both (`1e3m` passes client validation only to 400 server-side, so it
 * is rejected here). Group 1 captures the mantissa (positivity check),
 * group 2 the exponent/suffix (base-unit parsing).
 */
const QUANTITY_RE = /^([0-9]+(?:\.[0-9]+)?|\.[0-9]+)([eE][+-]?[0-9]+|n|u|m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/

/** Decimal-SI suffix → multiplier (exponent forms are handled separately). */
const DECIMAL_SUFFIX: Record<string, number> = {
	n: 1e-9,
	u: 1e-6,
	m: 1e-3,
	k: 1e3,
	M: 1e6,
	G: 1e9,
	T: 1e12,
	P: 1e15,
	E: 1e18,
}

/** Binary-SI suffix → multiplier. */
const BINARY_SUFFIX: Record<string, number> = {
	Ki: 1024,
	Mi: 1024 ** 2,
	Gi: 1024 ** 3,
	Ti: 1024 ** 4,
	Pi: 1024 ** 5,
	Ei: 1024 ** 6,
}

/**
 * Parse a Kubernetes quantity into its base-unit value (cores for CPU,
 * bytes for storage). Returns undefined for absent, non-string, or invalid
 * values — callers degrade (render "-") instead of failing the listing.
 */
function parseQuantity(raw: unknown): number | undefined {
	if (typeof raw !== "string") return undefined
	const match = QUANTITY_RE.exec(raw.trim())
	if (!match) return undefined
	const mantissa = Number.parseFloat(match[1])
	if (!Number.isFinite(mantissa)) return undefined
	const suffix = match[2]
	if (suffix === undefined) return mantissa
	if (/^[eE][+-]?[0-9]+$/.test(suffix)) {
		return mantissa * 10 ** Number.parseInt(suffix.slice(1), 10)
	}
	return mantissa * (BINARY_SUFFIX[suffix] ?? DECIMAL_SUFFIX[suffix] ?? 1)
}

/**
 * Parse a Kubernetes CPU quantity into millicores ("200m" → 200, "1.5" →
 * 1500, "1e1" → 10000). Undefined for absent or invalid values.
 */
export function cpuQuantityToMillicores(raw: unknown): number | undefined {
	const cores = parseQuantity(raw)
	return cores === undefined ? undefined : Math.round(cores * 1000)
}

/**
 * Parse a Kubernetes byte quantity into bytes ("512Mi" → 536870912,
 * "1.5Gi" → 1610612736, "1G" → 1000000000). Undefined for absent or
 * invalid values.
 */
export function byteQuantityToBytes(raw: unknown): number | undefined {
	const bytes = parseQuantity(raw)
	return bytes === undefined ? undefined : Math.round(bytes)
}

/**
 * Validate and normalize resource requests from `kimchi_workspace.yaml`.
 *
 * The client owns syntax only — values pass through to the server verbatim
 * as quantity strings; no millicore/byte conversion here. Normalization is
 * outer-whitespace trimming only — internal whitespace makes the value
 * invalid (a typo like "2 0Gi" must never silently become "20Gi").
 * Positivity is enforced (zero and unparseable values rejected); a field
 * left unset is omitted (inherits org policy). Returns undefined when no
 * resources are set at all.
 */
export function resolveWorkspaceResources(
	config: WorkspaceResourcesConfig | undefined,
): WorkspaceResourcesConfig | undefined {
	if (!config) return undefined
	const out: WorkspaceResourcesConfig = {}
	for (const field of WORKSPACE_RESOURCE_FIELDS) {
		const raw = config[field]
		if (raw === undefined) continue
		const normalized = raw.trim()
		const match = QUANTITY_RE.exec(normalized)
		if (!match) {
			throw new WorkspaceResourcesError(
				`Invalid ${field} value "${raw}" in ${WORKSPACE_FILE_NAME} — expected a Kubernetes quantity (e.g. "500m", "1Gi", "20Gi").`,
			)
		}
		if (Number.parseFloat(match[1]) <= 0) {
			throw new WorkspaceResourcesError(
				`Invalid ${field} value "${raw}" in ${WORKSPACE_FILE_NAME} — must be positive; remove the field to inherit the org default.`,
			)
		}
		out[field] = normalized
	}
	return Object.keys(out).length > 0 ? out : undefined
}
