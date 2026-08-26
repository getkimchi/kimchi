# lldb-dap (C / C++ / Rust / Swift) Reference

Adapter: `lldb-dap` · launchType: `lldb` · transport: **stdio** ·
detection: `which lldb-dap`, project markers `Cargo.toml` / `CMakeLists.txt` /
`Makefile` / `Package.swift`. Swift reuses lldb-dap (LLDB is Apple's Swift
debugger); no separate adapter.

## Launch config

```json
{ "type": "lldb", "request": "launch", "program": "<program>" }
```

Unlike dlv (which builds for you), lldb-dap launches an **already-built
binary**:

- **C/C++**: `program` is the executable produced by your build
  (e.g. `./build/app`).
- **Rust**: `program` is the compiled binary (e.g. `./target/debug/myapp`).
  Cargo-named binaries live under `target/debug/<crate>`.
- **Swift**: the binary under `.build/debug/` or the Xcode build products
  path.

Debug info is required: `-g` for clang/gcc, Rust's default debug profile is
fine, and `RUSTFLAGS="-C force-frame-pointers=yes"` helps on release profiles.

## Source mapping

The binary's debug info (DWARF) maps machine addresses back to source paths
**as they appear in the build**. Breakpoint `source` should match:

- the build-system relative path when compiled with `-g` on POSIX paths, or
- the absolute source path.

If a breakpoint resolves `verified: false`, the binary was likely stripped,
built without `-g`, or the path in DWARF differs from what you passed
(symlinked build trees are a common cause).

## Expression syntax (lldb eval)

LLDB's expression evaluator parses the source language:

- C/C++/Rust-style syntax depending on the current frame's language:
  field access (`obj.field`), pointer deref (`*ptr`), address-of (`&x`),
  casts (`(MyType*)p`), subscript (`arr[i]`).
- Rust specifics work in recent LLDB but are less reliable than C/C++ —
  prefer `debug_locals` for enum/struct field expansions.

## Gotchas

- Optimized builds (`-O2`/release) inline and reorder aggressively —
  variables report `<optimized out>` and breakpoints can land on surprising
  addresses. Debug with the debug build.
- `variables_reference` expiry is adapter-specific; expand structures at the
  current stop only.
