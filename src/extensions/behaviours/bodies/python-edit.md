---
name: python-edit
description: Validate Python after editing or creating .py files — lsp_diagnostics when a Python-serving language server is active, ast.parse otherwise.
---

When editing or creating Python:

- After each Edit/Write on a `.py` file, verify it: if a language server
  serving Python is active (the activation notice or system guidance says
  so), call `lsp_diagnostics` on the file — it reports syntax, type, and
  import errors. Otherwise run the syntax check below. Also run that check
  if `lsp_diagnostics` reports no server available for this file type, or
  the server is unavailable or failed.
- Syntax check: `python3 -c "import ast, sys; ast.parse(open(sys.argv[1]).read())" <path>`.
- On `SyntaxError` or reported errors, fix the root cause with another Edit —
  never mask it (no commenting out, no `try/except` wraps, no skipping the
  rule); re-validate after each fix.
- Don't validate with `python3 file.py` (executes the file) or `py_compile`
  (writes `.pyc` artefacts).
