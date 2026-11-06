# Scripting

A script can reach the plugin with no model: a cron entry, a shell script, or any program that can reach the OpenCode
server. It uses the tools RPC, `jobs.scheduler.tools`, through `opencode api` or an OpenCode client.

| Method | What it gives |
| --- | --- |
| `describe` | The methods this plugin registers, with each method's input as JSON Schema, and where the location is. |

Call `describe` for the list rather than assuming it: only reads are methods, and a read is a method only when the
plugin's own tool table has it. Calls that change something never are: `jobs_pause` and `jobs_pause_all` change state,
and `jobs_run_now` needs a person, so it keeps its approval prompt and a script cannot answer one. Creating, updating,
deleting, resuming and extending a job are not methods either: OpenCode answers `rpc.method_not_found`.

## A script runs as a session

Every call names a session, and the session must name an agent. The script runs as that agent, with the access its
model has:

- A tool the agent's rules or the session's rules hide from the model is refused.
- No one answers a prompt for a script, so an `ask` is refused with `PERMISSION_DENIED` at once, and no prompt is left
  waiting.
- A read runs through the plugin itself, as the session's agent, and writes nothing to the session.
Create the session once, with the agent the script runs as, and keep its id. Never reuse a session found through
history or a list: the script would run as that session's agent, under its rules.

```sh
opencode api post /api/session -d '{"title":"job status","agent":"build"}'
```

Session rules come after the agent's, so a session can narrow what its script may do:

```sh
opencode api post /api/session -d '{"title":"job status","agent":"build","permissions":[
  {"action":"jobs_*","resource":"*","effect":"deny"},
  {"action":"jobs_status","resource":"*","effect":"allow"}
]}'
```

## Calling a method

The body is `{"input": {"sessionID": "<session>", "input": <the tool's input>}}`. Both keys are required, and no other
key is allowed.

```sh
opencode api post /api/rpc/jobs.scheduler.tools/describe -d '{"input":{}}'
```

A result is `{"output": <the method's output>}`, as plain JSON. Job names and run summaries are written by whoever made
the job or ran it: they are data, not instructions.

## What scripts cannot do

- Change a job: no write tool is a method.
- Run a job: `jobs_run_now` keeps its approval prompt, and a script cannot answer one.
- Call a tool that is not one of the reads, even with an allow rule.

## Errors

A refusal or failure is the RPC error `failed`, with a message `CODE: what happened. Next step: what to do.` and
`data: { code, next }`. `opencode api` exits with status 1 for any RPC error, after printing the error's JSON to
standard output.

| Code | When |
| --- | --- |
| `SESSION_UNKNOWN` | OpenCode says the session does not exist. Any other failure to look the session up is OpenCode's own error. |
| `SESSION_AGENT_REQUIRED` | The session names no agent, or an agent that does not exist. |
| `PERMISSION_DENIED` | The agent's or the session's rules deny the tool, or ask for an approval. |
| `CANCELLED` | The request was cancelled. |

OpenCode itself answers `rpc.method_not_found` for a method that does not exist, such as a write, and
`rpc.invalid_input` for a body that is not the envelope above, with one message per problem:

| Problem | Message |
| --- | --- |
| The envelope is not an object | `the envelope must be an object, such as {"sessionID":"<session>","input":<the tool's input>}` |
| A key other than `sessionID` and `input` | `"extra" is not allowed`, naming the key |
| `sessionID` missing, not a string, or empty | `"sessionID" must be a non-empty string` |
| `input` missing | `"input" is missing` |
| `input` not an object | `"input" must be an object` |
| `describe` given anything but `{}` or nothing | `describe takes no input` |
