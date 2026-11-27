import type { ExtensionAPI, SettingsManager } from "@earendil-works/pi-coding-agent"
import type { RequiredReviewLens, ReviewLensId } from "../review-panel/lenses.js"
import { assertReviewLensId } from "../review-panel/lenses.js"
import type { ReviewEnvironmentGap, ReviewEnvironmentSettings } from "../review-runner/environment.js"
import { emptyReviewEnvironmentSettings, parseTrustedReviewEnvironment } from "../review-runner/environment.js"
import type { ReviewCheckDefinition } from "../review-runner/index.js"
import { ReviewTargetError } from "../review-targets/types.js"

export interface TrustedReviewSettings {
	requiredLenses: RequiredReviewLens[]
	checkDefinitions: ReviewCheckDefinition[]
	environment: ReviewEnvironmentSettings
	environmentGaps: ReviewEnvironmentGap[]
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function invalid(message: string): ReviewTargetError {
	return new ReviewTargetError("invalid_review_settings", message)
}

function stringField(value: Record<string, unknown>, field: string, fallback?: string): string {
	const configured = value[field] ?? fallback
	if (typeof configured !== "string" || !configured.trim() || configured.includes("\0")) {
		throw invalid(`review.checks.${field} must be a non-empty string without NUL.`)
	}
	return configured.trim()
}

function parseDependencies(value: unknown, id: string): string[] {
	if (!Array.isArray(value)) throw invalid(`Review check "${id}" dependencies must be an array of paths.`)
	return value.map((dependency) => {
		if (typeof dependency !== "string" || !dependency.trim() || dependency.includes("\0")) {
			throw invalid(`Review check "${id}" dependency paths must be trimmed, non-empty, and NUL-free.`)
		}
		return dependency.trim()
	})
}

function parseChecks(value: unknown): ReviewCheckDefinition[] {
	if (value === undefined) return []
	if (!Array.isArray(value)) throw invalid("review.checks must be an array.")
	const ids = new Set<string>()
	return value.map((entry) => {
		if (!object(entry)) throw invalid("Every review.checks entry must be an object.")
		const id = stringField(entry, "id")
		if (!/^[A-Za-z0-9_-]+$/.test(id) || ids.has(id)) {
			throw invalid(`Review check ID "${id}" is invalid or duplicated.`)
		}
		ids.add(id)
		const kind = entry.kind
		if (kind !== "build" && kind !== "test" && kind !== "other") {
			throw invalid(`Review check "${id}" kind must be build, test, or other.`)
		}
		if (entry.builds !== undefined && typeof entry.builds !== "boolean") {
			throw invalid(`Review check "${id}" builds must be a boolean.`)
		}
		const dependencies = entry.dependencies === undefined ? [] : parseDependencies(entry.dependencies, id)
		return {
			id,
			kind,
			command: stringField(entry, "command"),
			cwd: stringField(entry, "cwd", "."),
			builds: entry.builds === true,
			toolchain: stringField(entry, "toolchain", "unspecified"),
			dependencies,
		}
	})
}

function parseRequiredLenses(value: unknown): RequiredReviewLens[] {
	if (value === undefined) return []
	if (!Array.isArray(value)) throw invalid("review.requiredLenses must be an array.")
	return value.map((entry) => {
		if (!object(entry) || typeof entry.id !== "string" || typeof entry.reason !== "string") {
			throw invalid("Every review.requiredLenses entry needs an id and reason.")
		}
		const reason = entry.reason.trim()
		if (!reason || reason.includes("\0")) {
			throw invalid("Review required-lens reasons must be non-empty and NUL-free.")
		}
		return { id: assertReviewLensId(entry.id.trim()) as ReviewLensId, reason }
	})
}

/** Check/required-lens compatibility stays on Pi's effective settings. Environment
 * preparation is different: only the real manager's global scope may grant host
 * paths and offline setup commands; reviewed-project environment is ignored. */
export type ReviewSettingsManager = Pick<SettingsManager, "getGlobalSettings" | "getProjectSettings">

function environmentFromGlobal(
	review: unknown,
	projectReview: unknown,
): { settings: ReviewEnvironmentSettings; gaps: ReviewEnvironmentGap[] } {
	const gaps: ReviewEnvironmentGap[] = []
	if (object(projectReview) && projectReview.environment !== undefined) {
		gaps.push({
			kind: "project_environment_ignored",
			name: "review.environment",
			note: "Project-level review.environment was ignored; host caches and preparation must be configured in user-level settings.",
		})
	}
	if (review === undefined) return { settings: emptyReviewEnvironmentSettings(), gaps }
	if (!object(review)) {
		gaps.push({
			kind: "invalid_environment_settings",
			name: "review.environment",
			note: "Global review settings are not an object; using isolated review environments.",
		})
		return { settings: emptyReviewEnvironmentSettings(), gaps }
	}
	const environment = parseTrustedReviewEnvironment(review.environment)
	return { settings: environment.settings, gaps: [...gaps, ...environment.gaps] }
}

export function readTrustedReviewSettings(
	pi: ExtensionAPI,
	settingsManager: ReviewSettingsManager,
): TrustedReviewSettings {
	const settings = pi.getSettings() as unknown as Record<string, unknown>
	const review = settings.review
	const environment = environmentFromGlobal(
		(settingsManager.getGlobalSettings() as unknown as Record<string, unknown>).review,
		(settingsManager.getProjectSettings() as unknown as Record<string, unknown>).review,
	)
	if (review === undefined) {
		return {
			requiredLenses: [],
			checkDefinitions: [],
			environment: environment.settings,
			environmentGaps: environment.gaps,
		}
	}
	if (!object(review)) throw invalid("review settings must be an object.")
	return {
		requiredLenses: parseRequiredLenses(review.requiredLenses),
		checkDefinitions: parseChecks(review.checks),
		environment: environment.settings,
		environmentGaps: environment.gaps,
	}
}
