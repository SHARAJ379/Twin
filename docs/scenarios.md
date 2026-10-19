# Writing scenarios

A scenario is a YAML file, usually `scenario.yaml`, listing the HTTP requests Twin sends
to your app. Twin sends the same list twice: once to a single copy of your app, then to
two copies (A and B). Where the two runs disagree, you have a bug.

- [A first scenario](#a-first-scenario)
- [The four built-in checks](#the-four-built-in-checks)
- [Step reference](#step-reference)
- [Saving values and using them later](#saving-values-and-using-them-later)
- [Which copy a step goes to](#which-copy-a-step-goes-to)
- [Testing more than one user](#testing-more-than-one-user)
- [Retrying a step that needs a moment](#retrying-a-step-that-needs-a-moment)
- [When the session is the real problem](#when-the-session-is-the-real-problem)
- [Steps without a check](#steps-without-a-check)
- [Editor support](#editor-support)

## A first scenario

The pattern that finds bugs: **change something through one copy, then read it back
through the other.**

```yaml
name: login-flow
version: 1
steps:
  - id: login
    kind: request
    via: A
    request: { method: POST, path: /login, json: { email: "a@test.com", password: "pw" } }
    expect: { status: 200 }
  - id: me-check
    kind: request
    via: B
    request: { method: GET, path: /me }
    expect: { status: 200 }
    check: session-survives-switch
```

This logs in on copy A, then asks copy B "who am I?". If your app keeps logins in one
process's memory, B has never heard of you and answers `401`. That fails
`session-survives-switch`.

`twin init` writes a starter `scenario.yaml` that only calls `GET /health`. Replace it
with steps like these.

## The four built-in checks

Put `check: <name>` on the step that reads something back. Twin then judges that step:

| Check                     | What it proves                                                     | Typical bug it catches                          |
| ------------------------- | ------------------------------------------------------------------ | ----------------------------------------------- |
| `session-survives-switch` | a login made on one copy still works on the other                  | sessions kept in memory, a random secret key    |
| `data-consistency`        | a record created through one copy can be read through the other    | data in a variable, a local SQLite or JSON file |
| `file-consistency`        | a file uploaded through one copy can be downloaded from the other  | uploads saved to the server's own disk          |
| `restart-persistence`     | a record survives a restart of the copy that created it            | data that only lives in memory                  |

For `restart-persistence`, put a `restart` step between the write and the read:

```yaml
  - id: restart-a
    kind: restart
    instance: A
  - id: read-after-restart
    kind: request
    via: A
    request: { method: GET, path: "/items/{{itemId}}" }
    expect: { status: 200 }
    check: restart-persistence
```

A check fails only if the **same step passed on a single copy** (the CONTROL run). So a
scenario mistake, like a wrong path, is reported as a scenario error, never as a bug in
your app.

A check also compares the whole response, not just your `expect:`. If a single copy
answered `{"user": "alice"}` and two copies answered `{"user": null}`, that fails even
though both returned status `200`.

## Step reference

There are three kinds of step. The full machine-readable reference is the JSON Schema in
[scenario.schema.json](scenario.schema.json).

### `kind: request`

| Field      | Required | What it does                                                                                       |
| ---------- | -------- | -------------------------------------------------------------------------------------------------- |
| `id`       | yes      | A unique name for the step                                                                         |
| `request`  | yes      | `method` and `path`, plus at most one body: `json`, `form` (fields), `body` (raw text) or `multipart` |
| `expect`   | no       | `status` (a number, or a list like `[200, 201]`), `bodyContains` (text), `jsonPath` (`{"$.name": "x"}`) |
| `save`     | no       | Values to keep for later steps: `{ itemId: "$.id" }` or `{ csrf: "header:X-CSRF-Token" }`         |
| `check`    | no       | One of the four checks above                                                                       |
| `via`      | no       | `A`, `B` or `any`. See [Which copy a step goes to](#which-copy-a-step-goes-to)                    |
| `as`       | no       | Which user's cookies to use. See [Testing more than one user](#testing-more-than-one-user)       |
| `after`    | no       | Ids of earlier steps this check depends on. Defaults to the nearest earlier non-`GET` step         |
| `retries`  | no       | How many more times to try while `expect:` fails. Default `0`                                      |
| `settleMs` | no       | Milliseconds to wait between tries. Default `0`                                                    |

`request.headers` sets request headers. Cookies are handled for you: each user's cookies
are kept and sent automatically.

`multipart` uploads a small generated file, so you don't need a file on disk:

```yaml
    request:
      method: POST
      path: /upload
      multipart: { generate: { name: "twin-test.txt", content: "hello {{unique}}" } }
```

### `kind: restart`

Restarts one copy during the run with two copies (it's skipped in the single-copy run).

| Field      | Required | What it does                                                                          |
| ---------- | -------- | ------------------------------------------------------------------------------------- |
| `instance` | yes      | `A` or `B`                                                                            |
| `disk`     | no       | `fresh` (default): the restarted copy gets a clean copy of your project, as a real redeploy would. `keep`: it keeps its files |
| `mode`     | no       | `graceful` (default) or `crash`. On Windows every stop is immediate, so both act the same |

### `kind: wait`

Pauses for `ms` milliseconds.

## Saving values and using them later

`save` keeps a value from a response. Write `{{name}}` to use it in a later step's
`request` (its path, headers or body):

```yaml
  - id: create-item
    kind: request
    request: { method: POST, path: /items, json: { name: "test-item" } }
    expect: { status: 201 }
    save: { itemId: "$.id" }
  - id: read-item
    kind: request
    request: { method: GET, path: "/items/{{itemId}}" }
    expect: { status: 200, bodyContains: "test-item" }
    check: data-consistency
```

- `$.id`, `$.user.email` and `$.items[0].id` read from a JSON response.
- `header:Location` reads a response header.

Three values are always available:

| Template     | Value                                                                 |
| ------------ | --------------------------------------------------------------------- |
| `{{unique}}` | a short value that's different every time, for unique emails and names |
| `{{uuid}}`   | a random UUID                                                         |
| `{{now}}`    | the current time, as an ISO 8601 timestamp                            |

> [!NOTE]
> Templates work in `request`, not in `expect`. `bodyContains: "{{email}}"` looks for the
> literal text `{{email}}`.

> [!IMPORTANT]
> Quote anything that contains `{{ }}`. Unquoted, YAML reads `{{` as the start of a
> mapping. Write `path: "/items/{{itemId}}"`, not `path: /items/{{itemId}}`. Twin tells
> you if you forget.

## Which copy a step goes to

`via:` is optional. When you leave it out:

- **A step with a `check:` crosses over.** It goes to the copy that *didn't* do the
  related write (the login, the create, the upload). For `restart-persistence` it goes to
  the copy that was just restarted.
- **Any other step stays put.** It goes to the copy where that user's last successful
  request went, which is where their session lives. Only a user's very first request
  alternates.

So a scenario with no `via:` at all still tests every switch, and one session bug stays
one bug. `via: A` or `via: B` pins a step to one copy, and `via: any` alternates.

If you pin a check to the same copy that did the write, Twin reports that the check
wasn't really tested, rather than calling it a pass.

## Testing more than one user

Each user gets their own cookies, picked with `as:`. Declare every user in `clients:`.
That way a typo in `as:` is an error, instead of quietly sending a request with no
cookies.

```yaml
name: tenant-isolation
version: 1
clients: [alice, bob]
steps:
  - id: alice-login
    kind: request
    as: alice
    request: { method: POST, path: /login, json: { email: "alice@test.com", password: "pw" } }
    expect: { status: 200 }
  - id: bob-cannot-read-alices-note
    kind: request
    as: bob
    request: { method: GET, path: "/notes/{{noteId}}" }
    expect: { status: 404 }
```

A step with no `as:` uses the `default` user, which never needs declaring.

## Retrying a step that needs a moment

Some writes aren't readable the instant they return: a queue, a cache that writes later.
Let the read-back step try again instead of failing:

```yaml
- id: read-back
  kind: request
  via: B
  request: { method: GET, path: "/notes/{{noteId}}" }
  expect: { status: 200 }
  check: data-consistency
  retries: 3 # try up to 3 more times while expect: keeps failing
  settleMs: 250 # wait this long between tries
```

A step stops at the first try that passes, so a passing step costs nothing. A request can
take at most `--request-timeout-ms` per try.

> [!WARNING]
> Every try re-renders the step, so `{{unique}}`, `{{uuid}}` and `{{now}}` get new values
> each time. Put `retries` on the read, never on a step that creates something, or each
> try creates another record.

## When the session is the real problem

`data-consistency`, `file-consistency` and `restart-persistence` usually sit behind a
login. When the session breaks, their requests come back `401` or `403`: refused at the
door, before anything was read. Twin reports that honestly:

- these checks show as **BLOCKED**, and their summary says the session is what broke;
- only one fix prompt is printed, for the session bug;
- the verdict counts one bug: *"1 bug found (session-survives-switch); 3 checks couldn't
  be tested because of it"*;
- `report.json` marks them `blockedBy: "auth"`, and `verdict.blocked` counts them.

The exit code is still `1`. Fix the session, run again, and the other checks get tested.

A check whose request was never sent, because an earlier step failed and never saved the
`{{value}}` it needed, is also BLOCKED, naming that earlier step.

## Steps without a check

A step with no `check:` (a login, a create) is still held to its own `expect:`:

- If it fails on a **single copy** too, the scenario itself doesn't work yet. Twin
  reports `scenario-ran-as-written` as an error (exit `2`) and names the step.
- If it passes on a single copy but **fails on two**, that's a real bug: an
  `instance-divergence` failure (exit `1`), named after the first step that broke.
- If it fails only after a check already caught a bug, it's counted as that bug's
  consequence, not reported again.

## Editor support

Add this first line to `scenario.yaml` to get autocomplete and error checking in VS Code
(with the YAML extension) and other editors that support it:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/SHARAJ379/Twin/master/docs/scenario.schema.json
```
