/**
 * Browser pool — manages a single Playwright browser instance.
 *
 * - Lazy initialization: browser is created on first use.
 * - Reuse: subsequent fetches reuse the same browser instance.
 * - Idle timeout: browser auto-closes after 60 seconds of inactivity.
 * - Crash recovery: if the browser dies, the next call lazily creates a new one.
 */

import type { Browser } from "playwright"

/** Default idle timeout (ms). */
const DEFAULT_IDLE_TIMEOUT_MS = 60_000

export interface BrowserPoolOptions {
	idleTimeoutMs?: number
}

/**
 * Returns true when the error indicates Chromium is permanently unavailable
 * (not installed). Returns false for transient failures that should be retried.
 */
function isPermanentLaunchError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err)
	return message.includes("Executable doesn't exist") || message.includes("Cannot find module")
}

export class BrowserPool {
	private readonly idleTimeoutMs: number
	private browser: Browser | null = null
	private launchPromise: Promise<Browser | null> | null = null
	private idleTimer: ReturnType<typeof setTimeout> | null = null
	private playwrightAvailable: boolean | null = null

	constructor(options?: BrowserPoolOptions) {
		this.idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
	}

	/**
	 * Get a Playwright browser instance. Returns null if Playwright is not
	 * installed (the caller should fall back to native fetch).
	 *
	 * The browser is created lazily on first call, reused across calls, and
	 * automatically closed after the configured idle timeout.
	 */
	async getBrowser(): Promise<Browser | null> {
		const pw = await this.loadPlaywright()
		if (!pw) return null

		// If we have a live browser, reuse it.
		if (this.browser?.isConnected()) {
			this.resetIdleTimer()
			return this.browser
		}

		// Previous browser crashed or was closed — clean up.
		this.browser = null

		// Concurrent callers share one launch: awaiting launch() twice would
		// start two Chromium processes, and the second assignment would orphan
		// the first for the process lifetime.
		const launching = (this.launchPromise ??= this.launch(pw).finally(() => {
			this.launchPromise = null
		}))
		this.browser = await launching
		return this.browser
	}

	private async launch(pw: typeof import("playwright")): Promise<Browser | null> {
		try {
			const b = await pw.chromium.launch({ headless: true })

			// Auto-cleanup if the browser crashes or disconnects unexpectedly —
			// but only when this very instance is still the pooled one: an
			// orphaned browser disconnecting must not null its replacement.
			b.on("disconnected", () => {
				if (this.browser === b) {
					this.browser = null
					if (this.idleTimer) {
						clearTimeout(this.idleTimer)
						this.idleTimer = null
					}
				}
			})

			this.resetIdleTimer()
			return b
		} catch (err) {
			// Only permanently disable Playwright when Chromium is genuinely
			// not installed. Transient errors (resource exhaustion, file locks)
			// should allow retry on the next call.
			if (isPermanentLaunchError(err)) {
				this.playwrightAvailable = false
			}
			return null
		}
	}

	/** Shut down the browser pool. Closes any live browser, and waits for
	 *  (then closes) any browser still being launched. */
	async shutdown(): Promise<void> {
		const launching = this.launchPromise
		if (launching) {
			const b = await launching
			try {
				await b?.close()
			} catch {
				// Already closed or crashed — ignore.
			}
		}
		await this.closeBrowser()
	}

	/** Check whether Playwright was detected as available. */
	isPlaywrightAvailable(): boolean {
		return this.playwrightAvailable === true
	}

	private async loadPlaywright(): Promise<typeof import("playwright") | null> {
		if (this.playwrightAvailable === false) return null
		try {
			const pw = await import("playwright")
			this.playwrightAvailable = true
			return pw
		} catch {
			this.playwrightAvailable = false
			return null
		}
	}

	private resetIdleTimer(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer)
		this.idleTimer = setTimeout(() => {
			void this.closeBrowser()
		}, this.idleTimeoutMs)
	}

	private async closeBrowser(): Promise<void> {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer)
			this.idleTimer = null
		}
		if (this.browser) {
			const b = this.browser
			this.browser = null
			try {
				await b.close()
			} catch {
				// Already closed or crashed — ignore.
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Default singleton — keeps the same module-level API for consumers.
// ---------------------------------------------------------------------------

const defaultPool = new BrowserPool()

export async function getBrowser(): Promise<Browser | null> {
	return defaultPool.getBrowser()
}

export async function shutdownBrowserPool(): Promise<void> {
	return defaultPool.shutdown()
}

export function isPlaywrightAvailable(): boolean {
	return defaultPool.isPlaywrightAvailable()
}
