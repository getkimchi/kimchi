# debugpy (Python) Reference

Adapter: `debugpy` · launchType: `python` · transport: **stdio**
(`python3 -m debugpy.adapter`) · detection: `python3 -c "import debugpy"`,
project markers `pyproject.toml` / `setup.py` / `requirements.txt` / `Pipfile`.

## Launch config

```json
{ "type": "python", "request": "launch", "program": "<program>" }
```

No extra adapter config is injected. `program` is the script path; `args`,
`cwd`, `env` come through the launch args of the launch request.

## Source mapping

Trivial: breakpoints resolve directly against source paths. No compilation
step, no generated files, no source maps.

## Expression syntax (debugpy eval)

Full Python eval — any valid expression works:

- Method calls: `obj.method()`, `dict.keys()`, `list.append(x)`
- Comprehensions: `[x for x in items if x > 0]`
- Builtins: `len(x)`, `type(obj)`, `isinstance(x, Y)`, `dir(obj)`
- Formatting: `f"{var} = {value}"`

## Data-structure inspection

- Dicts: `d["key"]`, `d.get("key", default)`, `d.items()`
- Lists: `lst[0]`, `lst[-1]`, `lst[0:10]`, `len(lst)`
- Objects: `obj.__dict__` for all attributes, `type(obj).__name__`
- Exceptions: `str(e)`, `repr(e)`, `e.args`

## Gotchas

- Eval happens in the **current frame's scope** — select the frame via
  `debug_backtrace` + `frame_id` when the symbol is shadowed.
- Fully-global evaluation (no frame context) is unreliable across debugpy
  versions.
- Mutating globals needs `globals()['key'] = value`.
- Multi-line statements may not persist intermediate variables.
