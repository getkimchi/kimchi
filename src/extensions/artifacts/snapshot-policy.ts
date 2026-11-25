// Session-scoped gate for silent-build filesystem snapshots. The ACP server
// sets this from the client's `artifacts` capability; TUI/headless sessions
// have no such opt-in and retain their pre-snapshot behavior.
const snapshotArtifactScopes = new WeakSet<object>()

export function setSnapshotArtifactsOptIn(scope: object, enabled: boolean): void {
	if (enabled) snapshotArtifactScopes.add(scope)
	else snapshotArtifactScopes.delete(scope)
}

export function snapshotArtifactsOptedIn(scope: object): boolean {
	return snapshotArtifactScopes.has(scope)
}
