// Entrypoint for the codemode sandbox worker in compiled binaries.
//
// pi's `getCodemodeWorkerSpecifier()` (dist/config.js) returns the
// source-relative "./src/extensions/codemode/worker.ts" when running inside a
// Bun-compiled executable — Bun resolves `new Worker(...)` against the
// compiled-in entrypoint keys, which preserve the ./src/... prefix only
// when the build passes the entrypoint with its ./ prefix (see
// scripts/build-binary.js). Without it every codemode call fails with
// "Cannot find module './src/extensions/codemode/worker.ts'" and the model
// falls back to direct tool calls.
//
// This file is only referenced as a build entrypoint; nothing imports it
// (kimchi extensions load through explicit imports), so it is inert in dev.
// It mirrors pi's compiled dist/extensions/codemode/worker.js: a bare
// re-export of pi-codemode's worker module. See
// src/extensions/codemode/worker-entrypoint.test.ts for the contract.
import "@earendil-works/pi-codemode/worker"
