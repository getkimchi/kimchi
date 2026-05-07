---
name: python-edit
description: Validate Python syntax with `ast.parse` after editing or creating .py files.
---

When editing or creating Python:

- After every Edit/Write on a `.py` file, validate the result parses with `python3 -c "import ast, sys; ast.parse(open(sys.argv[1]).read())" <path>`.
- On `SyntaxError`, fix the root cause with another Edit — never paper over by commenting out, wrapping in `try/except`, or skipping the rule. Re-validate after each fix.
- Don't use `python3 file.py` to validate — that runs the file. Don't use `py_compile` — that writes `.pyc` artefacts. Stick to `ast.parse`.
