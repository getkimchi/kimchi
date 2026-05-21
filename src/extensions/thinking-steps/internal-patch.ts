import type { AssistantMessage, ThinkingContent } from "@earendil-works/pi-ai"
import { AssistantMessageComponent as _AssistantMessageComponent } from "@earendil-works/pi-coding-agent"
import { Markdown, Spacer, Text } from "@earendil-works/pi-tui"
import type { Component, MarkdownTheme } from "@earendil-works/pi-tui"
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import { ThinkingStepsComponent } from "./render.js"
import {
	decrementPatchRefCount,
	getActiveThinkingState,
	getLastThinkingDuration,
	getPatchCleanup,
	incrementPatchRefCount,
	resolveThinkingMessageScope,
	setPatchCleanup,
} from "./state.js"
import type { ThinkingSourceBlock, ThinkingThemeLike } from "./types.js"

export const PI_CODING_AGENT_INTERNAL_MODULES = {
	assistantMessageComponent: "dist/modes/interactive/components/assistant-message.js",
	theme: "dist/modes/interactive/theme/theme.js",
} as const

interface AssistantMessageComponentPrototype {
	updateContent(message: AssistantMessage): void
	setHideThinkingBlock(hide: boolean): void
	setHiddenThinkingLabel(label: string): void
	contentContainer: {
		clear(): void
		addChild(component: unknown): void
	}
	lastMessage?: AssistantMessage
	hideThinkingBlock: boolean
	markdownTheme: unknown
	hiddenThinkingLabel: string
}

export function assertPatchableAssistantMessageComponent(value: unknown): {
	prototype: AssistantMessageComponentPrototype
} {
	if (!value || (typeof value !== "function" && typeof value !== "object")) {
		throw new Error("Thinking Steps patch failed: AssistantMessageComponent export is missing or invalid.")
	}

	const prototype = (value as { prototype?: unknown }).prototype
	if (!prototype || typeof prototype !== "object") {
		throw new Error("Thinking Steps patch failed: AssistantMessageComponent.prototype is missing.")
	}

	const candidate = prototype as Record<string, unknown>
	const missingMethods = ["updateContent", "setHideThinkingBlock", "setHiddenThinkingLabel"].filter(
		(name) => typeof candidate[name] !== "function",
	)
	if (missingMethods.length > 0) {
		throw new Error(
			`Thinking Steps patch failed: AssistantMessageComponent prototype is incompatible (missing ${missingMethods.join(", ")}).`,
		)
	}

	return value as { prototype: AssistantMessageComponentPrototype }
}

export function assertThinkingStepsTheme(value: unknown): ThinkingThemeLike {
	if (!value || typeof value !== "object") {
		throw new Error("Thinking Steps patch failed: interactive theme export is missing or invalid.")
	}

	try {
		const candidate = value as Record<string, unknown>
		if (typeof candidate.fg !== "function" || typeof candidate.bold !== "function") {
			throw new Error("Thinking Steps patch failed: interactive theme export is incompatible.")
		}
	} catch (error) {
		if (error instanceof Error && /Theme not initialized/.test(error.message)) {
			return value as ThinkingThemeLike
		}
		throw error
	}

	return value as ThinkingThemeLike
}

function hasPatchableContentContainer(value: AssistantMessageComponentPrototype): boolean {
	return Boolean(
		value.contentContainer &&
			typeof value.contentContainer.clear === "function" &&
			typeof value.contentContainer.addChild === "function",
	)
}

const LIVE_PREVIEW_LINES = 5

class LiveThinkingPreview implements Component {
	constructor(
		private readonly theme: ThinkingThemeLike,
		private readonly blocks: ThinkingSourceBlock[],
	) {}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 1)
		const nowMs = Date.now()
		const pulseFrames = [
			this.theme.fg("dim", "·"),
			this.theme.fg("muted", "•"),
			this.theme.fg("accent", "•"),
			this.theme.fg("muted", "•"),
		]
		const pulse = pulseFrames[Math.floor(nowMs / 180) % pulseFrames.length] ?? pulseFrames[0]!
		const header = ` ${truncateToWidth(
			`${this.theme.fg("muted", "▍")} ${this.theme.fg("dim", "Thinking")} ${pulse}`,
			innerWidth,
			"",
		)}`

		const prefix = `${this.theme.fg("muted", "▍")} `
		const bodyInnerWidth = Math.max(1, innerWidth - 2)
		const fullText = this.blocks
			.map((b) => b.text)
			.join("\n")
			.trim()
		const separator = ` ${truncateToWidth(prefix, innerWidth, "")}`
		if (!fullText) return [header, separator]
		const allLines: string[] = []
		for (const rawLine of fullText.replace(/\t/g, "    ").split("\n")) {
			if (rawLine.trim().length === 0) {
				allLines.push(` ${truncateToWidth(prefix, innerWidth, "")}`)
				continue
			}
			for (const wrapped of wrapTextWithAnsi(this.theme.fg("dim", rawLine), bodyInnerWidth)) {
				allLines.push(` ${truncateToWidth(`${prefix}${wrapped}`, innerWidth, "")}`)
			}
		}
		return [header, separator, ...allLines.slice(-LIVE_PREVIEW_LINES)]
	}

	invalidate(): void {}
}

function hasVisibleThinking(content: ThinkingContent): boolean {
	return content.redacted === true || content.thinking.trim().length > 0
}

function collectThinkingBlocks(message: AssistantMessage): ThinkingSourceBlock[] {
	const blocks: ThinkingSourceBlock[] = []
	message.content.forEach((content, index) => {
		if (content.type !== "thinking") return
		if (!hasVisibleThinking(content)) return
		blocks.push({
			contentIndex: index,
			text: content.thinking,
			redacted: content.redacted,
		})
	})
	return blocks
}

function hasVisibleTextContent(message: AssistantMessage): boolean {
	return message.content.some((content) => content.type === "text" && content.text.trim().length > 0)
}

function installPatch(theme: ThinkingThemeLike): () => void {
	const AssistantMessageComponent = assertPatchableAssistantMessageComponent(_AssistantMessageComponent)
	const prototype = AssistantMessageComponent.prototype
	const originalUpdateContent = prototype.updateContent
	const originalSetHideThinkingBlock = prototype.setHideThinkingBlock
	const originalSetHiddenThinkingLabel = prototype.setHiddenThinkingLabel

	const normalizeHiddenThinkingLabel = (label: string): string => label.replace(/\u2060+$/gu, "")

	const restoreOriginalMethods = (): void => {
		if (prototype.updateContent !== originalUpdateContent) {
			prototype.updateContent = originalUpdateContent
		}
		if (prototype.setHideThinkingBlock !== originalSetHideThinkingBlock) {
			prototype.setHideThinkingBlock = originalSetHideThinkingBlock
		}
		if (prototype.setHiddenThinkingLabel !== originalSetHiddenThinkingLabel) {
			prototype.setHiddenThinkingLabel = originalSetHiddenThinkingLabel
		}
	}

	const withOriginalInstanceMethods = <T>(instance: AssistantMessageComponentPrototype, callback: () => T): T => {
		const ownUpdateContent = Object.prototype.hasOwnProperty.call(instance, "updateContent")
		const ownSetHideThinkingBlock = Object.prototype.hasOwnProperty.call(instance, "setHideThinkingBlock")
		const ownSetHiddenThinkingLabel = Object.prototype.hasOwnProperty.call(instance, "setHiddenThinkingLabel")
		const previousUpdateContent = instance.updateContent
		const previousSetHideThinkingBlock = instance.setHideThinkingBlock
		const previousSetHiddenThinkingLabel = instance.setHiddenThinkingLabel

		instance.updateContent = originalUpdateContent
		instance.setHideThinkingBlock = originalSetHideThinkingBlock
		instance.setHiddenThinkingLabel = originalSetHiddenThinkingLabel

		try {
			return callback()
		} finally {
			if (ownUpdateContent) {
				instance.updateContent = previousUpdateContent
			} else {
				Reflect.deleteProperty(instance as unknown as Record<string, unknown>, "updateContent")
			}

			if (ownSetHideThinkingBlock) {
				instance.setHideThinkingBlock = previousSetHideThinkingBlock
			} else {
				Reflect.deleteProperty(instance as unknown as Record<string, unknown>, "setHideThinkingBlock")
			}

			if (ownSetHiddenThinkingLabel) {
				instance.setHiddenThinkingLabel = previousSetHiddenThinkingLabel
			} else {
				Reflect.deleteProperty(instance as unknown as Record<string, unknown>, "setHiddenThinkingLabel")
			}
		}
	}

	const reportFallback = (stage: string, error: unknown): void => {
		console.warn(`Thinking Steps patch warning: falling back to Pi renderer during ${stage}.`, error)
	}

	const fallbackErrorMessage =
		"Thinking Steps patch failed: Pi internals are incompatible and fallback rendering also failed."

	const fallbackToOriginalUpdateContent = (
		instance: AssistantMessageComponentPrototype,
		message: AssistantMessage,
		stage: string,
		originalError?: unknown,
	): void => {
		try {
			withOriginalInstanceMethods(instance, () => {
				originalUpdateContent.call(instance, message)
			})
		} catch (fallbackError) {
			throw new Error(fallbackErrorMessage, {
				cause: originalError ? { patchError: originalError, fallbackError } : fallbackError,
			})
		}

		if (originalError) {
			reportFallback(stage, originalError)
		}
	}

	const fallbackToOriginalSetHideThinkingBlock = (
		instance: AssistantMessageComponentPrototype,
		hide: boolean,
		originalError?: unknown,
	): void => {
		try {
			withOriginalInstanceMethods(instance, () => {
				originalSetHideThinkingBlock.call(instance, hide)
			})
		} catch (fallbackError) {
			throw new Error(fallbackErrorMessage, {
				cause: originalError ? { patchError: originalError, fallbackError } : fallbackError,
			})
		}

		if (originalError) {
			reportFallback("setHideThinkingBlock", originalError)
		}
	}

	const fallbackToOriginalSetHiddenThinkingLabel = (
		instance: AssistantMessageComponentPrototype,
		label: string,
		originalError?: unknown,
	): void => {
		const normalizedLabel = normalizeHiddenThinkingLabel(label)
		try {
			withOriginalInstanceMethods(instance, () => {
				originalSetHiddenThinkingLabel.call(instance, normalizedLabel)
			})
		} catch (fallbackError) {
			throw new Error(fallbackErrorMessage, {
				cause: originalError ? { patchError: originalError, fallbackError } : fallbackError,
			})
		}

		if (originalError) {
			reportFallback("setHiddenThinkingLabel", originalError)
		}
	}

	const patchedUpdateContent = function patchedUpdateContent(
		this: AssistantMessageComponentPrototype,
		message: AssistantMessage,
	): void {
		this.lastMessage = message
		if (!hasPatchableContentContainer(this)) {
			fallbackToOriginalUpdateContent(this, message, "updateContent")
			return
		}

		try {
			this.contentContainer.clear()

			const thinkingBlocks = collectThinkingBlocks(message)
			const hasVisibleContent = hasVisibleTextContent(message) || thinkingBlocks.length > 0
			if (hasVisibleContent) {
				this.contentContainer.addChild(new Spacer(1))
			}

			let renderedThinking = false
			const hasVisibleTextAfterThinking = (() => {
				const firstThinkingIndex = thinkingBlocks[0]?.contentIndex
				if (firstThinkingIndex === undefined) return false
				return message.content
					.slice(firstThinkingIndex + 1)
					.some((content) => content.type === "text" && content.text.trim().length > 0)
			})()

			for (const content of message.content) {
				if (content.type === "text" && content.text.trim()) {
					this.contentContainer.addChild(new Markdown(content.text.trim(), 1, 0, this.markdownTheme as MarkdownTheme))
					continue
				}

				if (content.type === "thinking" && thinkingBlocks.length > 0 && !renderedThinking) {
					if (this.hideThinkingBlock) {
						const scopeKey = resolveThinkingMessageScope(message)
						const activeState = getActiveThinkingState(message.timestamp, scopeKey)
						if (activeState.active) {
							this.contentContainer.addChild(new LiveThinkingPreview(theme, thinkingBlocks))
						} else {
							const lastDuration = getLastThinkingDuration()
							const usesDuration = lastDuration !== undefined && message.timestamp === lastDuration.messageTimestamp
							const rawLabel = usesDuration
								? lastDuration.durationMs < 1000
									? "Thought for <1s"
									: `Thought for ${Math.round(lastDuration.durationMs / 1000)}s`
								: this.hiddenThinkingLabel
							const styledLabel = theme.bold ? theme.bold(rawLabel) : rawLabel
							this.contentContainer.addChild(
								new Text(` ${theme.fg("muted", "▍")} ${theme.fg("dim", styledLabel)}`, 0, 0),
							)
						}
					} else {
						this.contentContainer.addChild(
							new ThinkingStepsComponent(
								theme,
								message.timestamp,
								thinkingBlocks,
								resolveThinkingMessageScope(message),
							),
						)
					}
					renderedThinking = true
					if (hasVisibleTextAfterThinking) {
						this.contentContainer.addChild(new Spacer(1))
					}
				}
			}

			const hasToolCalls = message.content.some((content) => content.type === "toolCall")
			if (!hasToolCalls) {
				if (message.stopReason === "aborted") {
					const abortMessage =
						message.errorMessage && message.errorMessage !== "Request was aborted"
							? message.errorMessage
							: "Operation aborted"
					this.contentContainer.addChild(new Spacer(1))
					this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), 1, 0))
				} else if (message.stopReason === "error") {
					const errorMessage = message.errorMessage || "Unknown error"
					this.contentContainer.addChild(new Spacer(1))
					this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0))
				}
			}
		} catch (error) {
			fallbackToOriginalUpdateContent(this, message, "updateContent", error)
		}
	}

	const patchedSetHideThinkingBlock = function patchedSetHideThinkingBlock(
		this: AssistantMessageComponentPrototype,
		hide: boolean,
	): void {
		if (!hasPatchableContentContainer(this)) {
			fallbackToOriginalSetHideThinkingBlock(this, hide)
			return
		}

		this.hideThinkingBlock = hide
		if (!this.lastMessage) return
		try {
			this.updateContent(this.lastMessage)
		} catch (error) {
			fallbackToOriginalSetHideThinkingBlock(this, hide, error)
		}
	}

	const patchedSetHiddenThinkingLabel = function patchedSetHiddenThinkingLabel(
		this: AssistantMessageComponentPrototype,
		label: string,
	): void {
		const normalizedLabel = normalizeHiddenThinkingLabel(label)
		if (!hasPatchableContentContainer(this)) {
			fallbackToOriginalSetHiddenThinkingLabel(this, normalizedLabel)
			return
		}

		this.hiddenThinkingLabel = normalizedLabel
		if (!this.lastMessage) return
		try {
			this.updateContent(this.lastMessage)
		} catch (error) {
			fallbackToOriginalSetHiddenThinkingLabel(this, normalizedLabel, error)
		}
	}

	try {
		prototype.updateContent = patchedUpdateContent
		prototype.setHideThinkingBlock = patchedSetHideThinkingBlock
		prototype.setHiddenThinkingLabel = patchedSetHiddenThinkingLabel
	} catch (error) {
		try {
			restoreOriginalMethods()
		} catch (rollbackError) {
			throw new Error(
				"Thinking Steps patch failed: AssistantMessageComponent prototype patching failed and rollback was incomplete.",
				{
					cause: { installError: error, rollbackError },
				},
			)
		}

		throw new Error(
			"Thinking Steps patch failed: AssistantMessageComponent prototype is incompatible with thinking-steps patching.",
			{ cause: error },
		)
	}

	return () => {
		restoreOriginalMethods()
	}
}

export async function retainThinkingStepsPatch(theme: ThinkingThemeLike): Promise<() => Promise<void>> {
	incrementPatchRefCount()
	let cleanup = getPatchCleanup()
	if (!cleanup) {
		try {
			cleanup = installPatch(theme)
			setPatchCleanup(cleanup)
		} catch (error) {
			decrementPatchRefCount()
			throw error
		}
	}

	let released = false
	return async () => {
		if (released) return

		const refCount = decrementPatchRefCount()
		if (refCount > 0) {
			released = true
			return
		}

		const currentCleanup = getPatchCleanup()
		if (!currentCleanup) {
			released = true
			return
		}

		if (getPatchCleanup() === currentCleanup) {
			setPatchCleanup(undefined)
		}

		try {
			await currentCleanup()
			released = true
		} catch (error) {
			incrementPatchRefCount()
			if (!getPatchCleanup()) {
				setPatchCleanup(currentCleanup)
			}
			throw error
		}
	}
}
