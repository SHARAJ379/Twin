# Examples

The same small app in five languages, twice:

- **`broken-<stack>`** keeps sessions in memory, items in memory, and
  uploads on the instance's own disk. That's fine on one server and wrong on
  two. `twin run` inside it exits `1`, with one bug (the session) and three
  checks blocked by it.
- **`fixed-<stack>`** signs its sessions with a secret every instance is given,
  and keeps items and uploads at paths every instance is pointed at. `twin run`
  inside it exits `0` with no extra flags.

```bash
cd examples/fixed-express && npm ci && twin run    # exit 0
cd examples/broken-express && npm ci && twin run   # exit 1
```

## Where the fixed apps' shared storage comes from

Each `fixed-*` app has a `twin.config.json` that gives every instance the same
`SESSION_SECRET` and points `DATA_FILE` and `UPLOAD_DIR` at `{{shared}}`.

`{{shared}}` is a directory Twin creates for the run and shares between all its
instances, **standing in for the shared volume or bucket a real deployment
would mount on every server.** It's an explicit declaration that this storage
is shared in production too, which is why the checks count it.

Point the same apps at an ordinary absolute path instead (`--env
DATA_FILE=/tmp/data.json`) and Twin reports every check as NOT PROVEN, exit `2`:
two instances on one machine share that file, and two servers wouldn't. See
"What Twin can't see" in the main README.

The `SESSION_SECRET` value is a placeholder for the example only. Never commit
a real one.
