// Stub for the deep-import path used in clipboard-read.ts.
// The package's exports map does not expose this sub-path, so Vite resolves it
// as missing during test setup. This stub is aliased in vitest.config.ts so
// vi.mock() can target it without a "missing specifier" error.
// Tests override the export via vi.mock() in the normal way.
export const readClipboardImage = () => Promise.resolve(null)
