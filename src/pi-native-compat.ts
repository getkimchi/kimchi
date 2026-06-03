import { DefaultResourceLoader, type LoadExtensionsResult } from "@earendil-works/pi-coding-agent"
import { getConfiguredPackageResourceRecords, isPathInsidePackage } from "./resources/package-resources.js"
import { isResourceEnabled } from "./resources/store.js"

const INSTALLED = Symbol.for("kimchi.piNativeCompat.installed")
const NORMALIZED = Symbol.for("kimchi.piNativeCompat.normalized")
const WRAPPED = Symbol.for("kimchi.piNativeCompat.wrapped")
const ORIGINAL_GET_EXTENSIONS = Symbol.for("kimchi.piNativeCompat.originalGetExtensions")
const ORIGINAL_GET_SKILLS = Symbol.for("kimchi.piNativeCompat.originalGetSkills")
const ORIGINAL_GET_PROMPTS = Symbol.for("kimchi.piNativeCompat.originalGetPrompts")
const ORIGINAL_GET_THEMES = Symbol.for("kimchi.piNativeCompat.originalGetThemes")

type HandlerFn = (event: unknown, ctx: unknown) => unknown
type ExtensionWithMarker = LoadExtensionsResult["extensions"][number] & { [NORMALIZED]?: boolean }
type ResourceLoaderWithOriginal = DefaultResourceLoader & {
	[ORIGINAL_GET_EXTENSIONS]?: DefaultResourceLoader["getExtensions"]
	[ORIGINAL_GET_SKILLS]?: DefaultResourceLoader["getSkills"]
	[ORIGINAL_GET_PROMPTS]?: DefaultResourceLoader["getPrompts"]
	[ORIGINAL_GET_THEMES]?: DefaultResourceLoader["getThemes"]
}

export function installPiNativeCompatibilityShim(): void {
	const proto = DefaultResourceLoader.prototype as ResourceLoaderWithOriginal & { [INSTALLED]?: boolean }
	if (proto[INSTALLED]) return

	const originalGetExtensions = proto.getExtensions
	const originalGetSkills = proto.getSkills
	const originalGetPrompts = proto.getPrompts
	const originalGetThemes = proto.getThemes
	proto[ORIGINAL_GET_EXTENSIONS] = originalGetExtensions
	proto[ORIGINAL_GET_SKILLS] = originalGetSkills
	proto[ORIGINAL_GET_PROMPTS] = originalGetPrompts
	proto[ORIGINAL_GET_THEMES] = originalGetThemes
	proto.getExtensions = function patchedGetExtensions(this: DefaultResourceLoader): LoadExtensionsResult {
		return filterDisabledPackageExtensions(normalizePiNativeExtensions(originalGetExtensions.call(this)))
	}
	proto.getSkills = function patchedGetSkills(
		this: DefaultResourceLoader,
	): ReturnType<DefaultResourceLoader["getSkills"]> {
		const result = originalGetSkills.call(this)
		return { ...result, skills: filterDisabledPackageItems(result.skills) }
	}
	proto.getPrompts = function patchedGetPrompts(
		this: DefaultResourceLoader,
	): ReturnType<DefaultResourceLoader["getPrompts"]> {
		const result = originalGetPrompts.call(this)
		return { ...result, prompts: filterDisabledPackageItems(result.prompts) }
	}
	proto.getThemes = function patchedGetThemes(
		this: DefaultResourceLoader,
	): ReturnType<DefaultResourceLoader["getThemes"]> {
		const result = originalGetThemes.call(this)
		return { ...result, themes: filterDisabledPackageItems(result.themes) }
	}
	proto[INSTALLED] = true
}

export function normalizePiNativeExtensions(result: LoadExtensionsResult): LoadExtensionsResult {
	for (const extension of result.extensions as ExtensionWithMarker[]) {
		if (extension[NORMALIZED]) continue
		normalizeToolResultHandlers(extension.handlers)
		aliasBeforeProviderResponse(extension.handlers)
		extension[NORMALIZED] = true
	}
	return result
}

export function filterDisabledPackageExtensions(
	result: LoadExtensionsResult,
	records = getConfiguredPackageResourceRecords(),
	isEnabled: (id: string) => boolean = isResourceEnabled,
): LoadExtensionsResult {
	const disabledRecords = records.filter((record) => !isEnabled(record.id))
	if (disabledRecords.length === 0) return result

	const isDisabledPackagePath = (path: string | undefined) =>
		disabledRecords.some((record) => isPathInsidePackage(path, record))
	const isDisabledPackageSource = (source: string | undefined) =>
		typeof source === "string" && disabledRecords.some((record) => record.source === source)
	const isDisabledPackageExtension = (extension: LoadExtensionsResult["extensions"][number]) =>
		isDisabledPackageSource(extension.sourceInfo?.source) ||
		isDisabledPackagePath(extension.resolvedPath) ||
		isDisabledPackagePath(extension.path)
	const disabledExtensionPaths = new Set(
		result.extensions
			.filter(isDisabledPackageExtension)
			.flatMap((extension) => [extension.path, extension.resolvedPath].filter((path) => typeof path === "string")),
	)

	result.runtime.pendingProviderRegistrations = result.runtime.pendingProviderRegistrations.filter(
		(registration) =>
			!disabledExtensionPaths.has(registration.extensionPath) && !isDisabledPackagePath(registration.extensionPath),
	)

	return {
		...result,
		extensions: result.extensions.filter((extension) => !isDisabledPackageExtension(extension)),
		errors: result.errors.filter((error) => !isDisabledPackagePath(error.path)),
	}
}

function filterDisabledPackageItems<T>(items: T[]): T[] {
	const disabledRecords = getConfiguredPackageResourceRecords().filter((record) => !isResourceEnabled(record.id))
	if (disabledRecords.length === 0) return items
	return items.filter((item) => !isDisabledPackageItem(item, disabledRecords))
}

function isDisabledPackageItem(
	item: unknown,
	disabledRecords: ReturnType<typeof getConfiguredPackageResourceRecords>,
): boolean {
	if (!isRecord(item)) return false
	const sourceInfo = isRecord(item.sourceInfo) ? item.sourceInfo : undefined
	const source = typeof sourceInfo?.source === "string" ? sourceInfo.source : undefined
	const paths = [sourceInfo?.path, item.filePath, item.sourcePath, item.path].filter((path) => typeof path === "string")

	return disabledRecords.some(
		(record) => record.source === source || paths.some((path) => isPathInsidePackage(path, record)),
	)
}

function normalizeToolResultHandlers(handlers: Map<string, HandlerFn[]>): void {
	const current = handlers.get("tool_result")
	if (!current?.length) return
	handlers.set("tool_result", current.map(wrapToolResultHandler))
}

function aliasBeforeProviderResponse(handlers: Map<string, HandlerFn[]>): void {
	const legacy = handlers.get("before_provider_response")
	if (!legacy?.length) return
	const after = handlers.get("after_provider_response") ?? []
	handlers.set("after_provider_response", [...after, ...legacy.map(wrapBeforeProviderResponseHandler)])
}

function wrapToolResultHandler(handler: HandlerFn): HandlerFn {
	if (isWrapped(handler)) return handler
	const wrapped: HandlerFn = (event, ctx) => handler(normalizeToolResultEvent(event), ctx)
	markWrapped(wrapped)
	return wrapped
}

function wrapBeforeProviderResponseHandler(handler: HandlerFn): HandlerFn {
	if (isWrapped(handler)) return handler
	const wrapped: HandlerFn = (event, ctx) => handler(normalizeBeforeProviderResponseEvent(event), ctx)
	markWrapped(wrapped)
	return wrapped
}

function normalizeToolResultEvent(event: unknown): unknown {
	if (!isRecord(event)) return event
	if (event.type !== "tool_result") return event
	const normalized = event as Record<string, unknown>
	if (normalized.params === undefined && isRecord(normalized.input)) normalized.params = normalized.input
	if (normalized.output === undefined) normalized.output = contentToText(normalized.content)
	if (normalized.result === undefined) normalized.result = normalized.output
	if (normalized.error === undefined && normalized.isError === true) normalized.error = normalized.output || true
	return normalized
}

function normalizeBeforeProviderResponseEvent(event: unknown): unknown {
	if (!isRecord(event)) return event
	return {
		...event,
		type: "before_provider_response",
	}
}

function contentToText(value: unknown): string | undefined {
	if (!Array.isArray(value)) return undefined
	const text = value
		.map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join("")
	return text || undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function markWrapped(handler: HandlerFn): void {
	;(handler as HandlerFn & { [WRAPPED]?: boolean })[WRAPPED] = true
}

function isWrapped(handler: HandlerFn): boolean {
	return (handler as HandlerFn & { [WRAPPED]?: boolean })[WRAPPED] === true
}
