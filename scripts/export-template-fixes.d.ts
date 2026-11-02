// Ambient declarations for scripts/export-template-fixes.js — a plain ESM
// module post-processed into the staged export template by
// scripts/copy-resources.js. Tests import the .js; TypeScript resolves this
// sibling .d.ts for types.

/** Minimal shape of a tree node as built by the export template's buildTree(). */
export interface ExportTemplateNode {
	entry: {
		id: string
		timestamp: string
	}
	children: ExportTemplateNode[]
	label?: string
}

/** One anchored template fix: the recursive `from` snippet, replaced by `to`. */
export interface TemplateFix {
	id: string
	from: string
	to: string
}

/** Result of applyTemplateFixes. */
export interface TemplateFixResult {
	/** Patched template source. */
	js: string
	/** Number of anchors replaced (0..TEMPLATE_FIX_ANCHORS.length). */
	applied: number
	/** Per-anchor skip reasons (missing/duplicated anchor); empty on full success. */
	warnings: string[]
}

export const TEMPLATE_FIX_ANCHORS: TemplateFix[]

export function applyTemplateFixes(templateJs: string): TemplateFixResult

/**
 * Iterative sortChildren, materialized from the exact source string injected
 * into the staged template. Sorts every node's children by entry timestamp,
 * depth-unbounded (explicit stack).
 */
export const sortChildrenIterative: (root: ExportTemplateNode) => void

/**
 * Iterative mapNodes, materialized from the exact source string injected
 * into the staged template. Visits every node exactly once, pre-order.
 */
export const mapNodesIterative: (root: ExportTemplateNode, visit: (node: ExportTemplateNode) => void) => void

/**
 * Iterative markActive, materialized from the exact source string injected
 * into the staged template. Post-order: stores whether each node's subtree
 * contains an active entry (node itself or any descendant).
 */
export const markActiveIterative: (
	root: ExportTemplateNode,
	isActive: (id: string) => boolean,
	store: Map<ExportTemplateNode, boolean>,
) => void
