import type { QuotaUsage, ResourceUsage } from "../../../sandbox/cloud/types.js"
import { formatK8sBytesPair, formatMillicores } from "./format-bytes.js"

/**
 * Quota footer input: a settled value, or an in-flight fetch. Panels accept
 * either — the two footer rows are reserved regardless, so a promise simply
 * fills them in (and requests a re-render) when it settles, never blocking
 * the picker from opening. Callers should attach `.catch(() => undefined)`
 * so failures degrade to "no summary"; panels also ignore rejections
 * defensively.
 */
export type QuotaInput = QuotaUsage | Promise<QuotaUsage | undefined>

/** Narrow a QuotaInput: true when the fetch is still in flight. */
export function isQuotaPending(input: QuotaInput | undefined): input is Promise<QuotaUsage | undefined> {
	return input !== undefined && typeof (input as Promise<QuotaUsage | undefined>).then === "function"
}

/**
 * Apply a QuotaInput to a panel footer. A settled value is assigned
 * immediately; an in-flight fetch assigns and re-renders when it settles —
 * unless the panel was disposed in the meantime — and rejections are
 * ignored (callers pre-catch; the footer simply stays empty). Shared by the
 * two picker panels so their footer behavior cannot drift apart.
 */
export function settleQuota(
	input: QuotaInput | undefined,
	hooks: {
		isDisposed: () => boolean
		set: (q: QuotaUsage | undefined) => void
		requestRender: () => void
	},
): void {
	if (!isQuotaPending(input)) {
		hooks.set(input)
		return
	}
	void input.then(
		(q) => {
			if (hooks.isDisposed()) return
			hooks.set(q)
			hooks.requestRender()
		},
		() => undefined,
	)
}

/**
 * Usage-vs-quota footer lines: the user scope on the first line, the org
 * scope on its own line below it — one line per scope keeps both fully
 * readable at common terminal widths instead of truncating the org tail.
 * Segments with missing fields are dropped; a scope with nothing to show
 * yields undefined, which callers replace with an empty row so the panel
 * always emits the same line count.
 *
 * Shared by the workspace picker (WorkspacesPanel) and the remote-sessions
 * panel so the two footers cannot drift apart.
 */
export function quotaLines(quota: QuotaUsage | undefined): [string | undefined, string | undefined] {
	const scope = (u: ResourceUsage): string | undefined => {
		const parts: string[] = []
		if (u.currentCpuMillicores !== undefined && u.maxCpuMillicores !== undefined) {
			parts.push(`${formatMillicores(u.currentCpuMillicores)}/${formatMillicores(u.maxCpuMillicores)} CPU`)
		}
		if (u.currentRamBytes !== undefined && u.maxRamBytes !== undefined) {
			parts.push(`${formatK8sBytesPair(u.currentRamBytes, u.maxRamBytes)} RAM`)
		}
		if (u.currentPvcSizeBytes !== undefined && u.maxPvcSizeBytes !== undefined) {
			parts.push(`${formatK8sBytesPair(u.currentPvcSizeBytes, u.maxPvcSizeBytes)} PVC`)
		}
		if (u.currentSandboxes !== undefined && u.maxSandboxes !== undefined) {
			parts.push(`${u.currentSandboxes}/${u.maxSandboxes} workspaces`)
		}
		return parts.length > 0 ? parts.join(" · ") : undefined
	}
	const user = quota?.userUsage ? scope(quota.userUsage) : undefined
	const org = quota?.orgUsage ? scope(quota.orgUsage) : undefined
	return [user ? `you: ${user}` : undefined, org ? `org: ${org}` : undefined]
}
