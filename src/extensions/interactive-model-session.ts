import type { Api, Model } from "@earendil-works/pi-ai"
import { InteractiveMode } from "@earendil-works/pi-coding-agent"

type StartNewSessionWithModel = (model: Model<Api>) => void

interface InteractiveModelSession {
	sessionManager: object
	runtimeHost: { newSession(): Promise<{ cancelled: boolean }> }
	session: { setModel(model: Model<Api>): Promise<void> }
	showError(message: string): void
	showStatus(message: string): void
}

const startNewSessionByManager = new WeakMap<object, StartNewSessionWithModel>()

export async function startNewInteractiveSessionWithModel(sessionManager: object, model: Model<Api>): Promise<boolean> {
	const startNewSession = startNewSessionByManager.get(sessionManager)
	if (!startNewSession) return false
	startNewSession(model)
	return true
}

export function registerInteractiveModelSession(mode: InteractiveModelSession): void {
	startNewSessionByManager.set(mode.sessionManager, (model) => {
		// Let the current model_select event finish before invalidating its session context.
		setTimeout(() => {
			void (async () => {
				const result = await mode.runtimeHost.newSession()
				if (result.cancelled) return
				await mode.session.setModel(model)
				mode.showStatus(`Started a new session with ${model.provider}/${model.id}.`)
			})().catch((error) => mode.showError(error instanceof Error ? error.message : String(error)))
		}, 0)
	})
}

/** Expose InteractiveMode's session replacement to the model-switch extension. */
export function applyInteractiveModelSessionPatch(): void {
	// biome-ignore lint/suspicious/noExplicitAny: private upstream prototype adapter
	const prototype = InteractiveMode.prototype as any
	if (prototype.__kimchiModelSessionPatched) return
	prototype.__kimchiModelSessionPatched = true

	const bindCurrentSessionExtensions = prototype.bindCurrentSessionExtensions
	prototype.bindCurrentSessionExtensions = async function patchedBindCurrentSessionExtensions(...args: unknown[]) {
		const result = await bindCurrentSessionExtensions.apply(this, args)
		registerInteractiveModelSession(this)
		return result
	}
}
