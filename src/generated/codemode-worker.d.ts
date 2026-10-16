// Bundled at build time by scripts/build-binary.js from pi's codemode worker
// entry (dist/extensions/codemode/worker.js) into one self-contained file;
// binary-entry.ts embeds it via a Bun file import so the compiled executable
// can spawn the codemode sandbox worker. Only this declaration is committed —
// the .js next to it is generated during build:binary.
declare const codemodeWorkerPath: string
export default codemodeWorkerPath
