import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import type { CheckpointRecord } from "./git-store.js"
import type { CheckpointStore } from "./store.js"

const PARAMETERS = Type.Object({
	action: Type.Union([Type.Literal("save"), Type.Literal("list"), Type.Literal("restore")]),
	label: Type.Optional(Type.String({ description: "Human-readable candidate description." })),
	id: Type.Optional(Type.String({ description: "Checkpoint ID to restore. Required for restore." })),
	validated: Type.Optional(
		Type.Boolean({ description: "Records the caller's verification claim only; not an independent proof." }),
	),
})

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }] }
}

function preview(record: CheckpointRecord) {
	return {
		id: record.id,
		createdAt: record.createdAt,
		trigger: record.trigger,
		label: record.label,
		validated: record.validated,
		includedPathCount: record.includedPathCount,
		skippedPaths: record.skippedPaths,
		includedPathPreview: record.includedPathPreview.slice(0, 3),
	}
}

function saveText(record: CheckpointRecord): string {
	return [
		`Checkpoint: ${record.id}`,
		`Tree: ${record.treeSha}`,
		`Validated claim: ${record.validated}`,
		`Captured files: ${record.includedPathCount}`,
		...(record.skippedPaths.length > 0 ? [`Skipped: ${JSON.stringify(record.skippedPaths)}`] : []),
	].join("\n")
}

export function workspaceCheckpointTool(
	resolveStore: (ctx: ExtensionToolContext) => Promise<CheckpointStore>,
): ToolDefinition {
	return {
		name: "workspace_checkpoint",
		label: "Checkpoint workspace",
		description:
			"Save, list, or deliberately restore workspace checkpoints in private Kimchi storage outside the project Git state. save returns a checkpoint ID. restore requires an explicit ID, captures current state first, and never rolls back automatically.",
		parameters: PARAMETERS,
		execute: async (
			_callId,
			params: { action: "save" | "list" | "restore"; label?: string; id?: string; validated?: boolean },
			signal,
			_update,
			ctx,
		) => {
			const store = await resolveStore(ctx)
			switch (params.action) {
				case "save": {
					const checkpoint = await store.capture({
						trigger: "manual",
						label: params.label ?? "Manual checkpoint",
						validated: params.validated ?? false,
						deduplicate: false,
					})
					return { ...text(saveText(checkpoint)), details: { checkpoint: preview(checkpoint) } }
				}
				case "list":
					return {
						...text(JSON.stringify(store.list().map(preview), null, 2)),
						details: { checkpoints: store.list().map(preview) },
					}
				case "restore": {
					if (!params.id) throw new Error("checkpoint id is required for restore")
					const result = await store.restore(params.id, signal)
					return {
						...text(
							[
								`Restored checkpoint: ${result.checkpoint.id}`,
								`Safety checkpoint before restore: ${result.safetyCheckpoint.id}`,
								`Restored paths: ${result.restoredPaths}`,
								`Preserved untracked paths: ${JSON.stringify(result.preservedPaths)}`,
								`Skipped paths: ${JSON.stringify(result.skippedPaths)}`,
							].join("\n"),
						),
						details: {
							checkpoint: preview(result.checkpoint),
							safetyCheckpoint: preview(result.safetyCheckpoint),
							restoredPaths: result.restoredPaths,
							preservedPaths: result.preservedPaths,
							skippedPaths: result.skippedPaths,
						},
					}
				}
			}
		},
	}
}

export function registerWorkspaceCheckpointTool(
	pi: ExtensionAPI,
	resolveStore: (ctx: ExtensionToolContext) => Promise<CheckpointStore>,
): void {
	pi.registerTool(workspaceCheckpointTool(resolveStore))
}
