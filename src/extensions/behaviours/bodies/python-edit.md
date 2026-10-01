---
name: python-edit
description: Validate Python syntax with `ast.parse` after editing or creating .py files.
---

When editing or creating Python:

- After each Edit/Write on a `.py` file, verify it parses: `python3 -c "import ast, sys; ast.parse(open(sys.argv[1]).read())" <path>`.
- On `SyntaxError`, fix the root cause with another Edit — never mask it (no commenting out, no `try/except` wraps, no skipping the rule); re-validate after each fix.
- Don't validate with `python3 file.py` (executes the file) or `py_compile` (writes `.pyc` artefacts) — use `ast.parse`.
