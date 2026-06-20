import { deriveBaseUrl } from "../worker/client.js"
import type { WaitForWorkspaceReadyOptions } from "./types.js"
import { RemoteNetworkError } from "./types.js"

const DEFAULT_READY_TIMEOUT_MS = 90_000
const DEFAULT_POLL_INTERVAL_MS = 1_500
const DEFAULT_PROBE_TIMEOUT_MS = 5_000

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup()
			resolve()
		}, ms)
		const onAbort = () => {
			cleanup()
			clearTimeout(timer)
			reject(new RemoteNetworkError("Aborted while waiting for workspace to become ready"))
		}
		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort)
		}
		if (signal?.aborted) {
			cleanup()
			clearTimeout(timer)
			reject(new RemoteNetworkError("Aborted while waiting for workspace to become ready"))
			return
		}
		signal?.addEventListener("abort", onAbort, { once: true })
	})
}

/**
 * Poll the /startupcompletedz endpoint once via HTTP. Resolves with `{ ready: true }` if
 * the response is 2xx, `{ ready: false, error }` otherwise. Never throws.
 */
async function probeReadyOnce(opts: {
	connectToken: string
	wsUrl: string
	probeTimeoutMs: number
	signal?: AbortSignal
}): Promise<{ ready: boolean; error?: string }> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		const baseUrl = deriveBaseUrl(opts.wsUrl)
		const url = `${baseUrl}/startupcompletedz`

		const ctrl = new AbortController()
		timer = setTimeout(() => ctrl.abort(), opts.probeTimeoutMs)

		let signal: AbortSignal
		if (opts.signal) {
			if (typeof AbortSignal.any === "function") {
				signal = AbortSignal.any([ctrl.signal, opts.signal])
			} else {
				opts.signal.addEventListener("abort", () => ctrl.abort(), { once: true })
				if (opts.signal.aborted) ctrl.abort()
				signal = ctrl.signal
			}
		} else {
			signal = ctrl.signal
		}

		const resp = await fetch(url, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${opts.connectToken}`,
			},
			signal,
		})

		if (resp.ok) {
			return { ready: true }
		}
		return { ready: false, error: `HTTP ${resp.status}` }
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		return { ready: false, error: msg }
	} finally {
		if (timer) clearTimeout(timer)
	}
}

/**
 * Poll HTTP GET /startupcompletedz until it returns 2xx, which signals that the
 * agentgateway has attached the workspace policy and traffic is routable.
 */
export async function waitForWorkspaceReady(options: WaitForWorkspaceReadyOptions): Promise<void> {
	const signal = options.signal
	const timeoutMs = options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
	const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS

	const startedAt = Date.now()
	let lastError: string | undefined

	while (true) {
		if (signal?.aborted) {
			throw new RemoteNetworkError("Aborted while waiting for workspace to become ready")
		}
		const elapsedMs = Date.now() - startedAt
		if (elapsedMs > timeoutMs) {
			throw new RemoteNetworkError(
				`Workspace did not become ready within ${Math.round(timeoutMs / 1000)}s (last probe: ${lastError ?? "unknown"})`,
			)
		}

		const probe = await probeReadyOnce({
			connectToken: options.connectToken,
			wsUrl: options.wsUrl,
			probeTimeoutMs,
			signal,
		})

		options.onTick?.({ elapsedMs, lastError: probe.error })

		if (probe.ready) return
		lastError = probe.error

		await sleep(pollIntervalMs, signal)
	}
}
