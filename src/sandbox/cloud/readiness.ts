import { WebSocket } from "ws"
import type { WaitForWorkspaceReadyOptions } from "./types.js"
import { RemoteNetworkError } from "./types.js"

const DEFAULT_READY_TIMEOUT_MS = 90_000
const DEFAULT_POLL_INTERVAL_MS = 1_500
const DEFAULT_PROBE_TIMEOUT_MS = 5_000
const DEFAULT_WS_PATH = "/connect"

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
 * Probe the WS endpoint once. Resolves with `{ ready: true }` if the upgrade
 * completes, `{ ready: false, error }` otherwise. Never throws.
 */
function probeWorkspaceWsOnce(opts: {
	connectToken: string
	wsURL: string
	wsPath: string
	probeTimeoutMs: number
	signal?: AbortSignal
	// biome-ignore lint/suspicious/noExplicitAny: injectable WebSocket constructor
	WS: any
}): Promise<{ ready: boolean; error?: string }> {
	return new Promise((resolve) => {
		let settled = false
		const settle = (result: { ready: boolean; error?: string }) => {
			if (settled) return
			settled = true
			cleanup()
			try {
				ws.close()
			} catch {
				// ignore
			}
			resolve(result)
		}

		const url = `${opts.wsURL}${opts.wsPath}`
		const headers = { Authorization: `Bearer ${opts.connectToken}` }
		let ws: { close(): void; addEventListener: (t: string, cb: (e: unknown) => void) => void }
		try {
			ws = new opts.WS(url, { headers })
		} catch (err) {
			resolve({ ready: false, error: err instanceof Error ? err.message : String(err) })
			return
		}

		const timer = setTimeout(() => settle({ ready: false, error: "probe timeout" }), opts.probeTimeoutMs)
		const onAbort = () => settle({ ready: false, error: "aborted" })
		const cleanup = () => {
			clearTimeout(timer)
			opts.signal?.removeEventListener("abort", onAbort)
		}

		if (opts.signal?.aborted) {
			settle({ ready: false, error: "aborted" })
			return
		}
		opts.signal?.addEventListener("abort", onAbort, { once: true })

		ws.addEventListener("open", () => settle({ ready: true }))
		ws.addEventListener("error", (e: unknown) => {
			const msg = (e as { message?: string })?.message ?? "websocket error"
			settle({ ready: false, error: msg })
		})
		ws.addEventListener("close", (e: unknown) => {
			const code = (e as { code?: number })?.code
			const reason = (e as { reason?: string })?.reason
			settle({ ready: false, error: code ? `closed code=${code}${reason ? ` reason=${reason}` : ""}` : "closed" })
		})
	})
}

/**
 * Poll a WebSocket probe to `wss://<host>:<port>/connect` until the upgrade
 * succeeds, which signals that the agentgateway has attached the workspace
 * policy and traffic is routable.
 */
export async function waitForWorkspaceReady(options: WaitForWorkspaceReadyOptions): Promise<void> {
	const signal = options.signal
	const timeoutMs = options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
	const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
	const wsPath = options.wsPath ?? DEFAULT_WS_PATH
	const WS = "_WebSocket" in options ? options._WebSocket : WebSocket
	if (!WS) {
		throw new RemoteNetworkError("WebSocket is not available in this environment")
	}

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

		const probe = await probeWorkspaceWsOnce({
			connectToken: options.connectToken,
			wsURL: options.wsUrl,
			wsPath,
			probeTimeoutMs,
			signal,
			WS,
		})

		options.onTick?.({ elapsedMs, lastError: probe.error })

		if (probe.ready) return
		lastError = probe.error

		await sleep(pollIntervalMs, signal)
	}
}
