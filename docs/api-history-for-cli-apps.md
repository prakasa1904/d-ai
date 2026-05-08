# API History For CLI Apps

This document describes how CLI applications such as `openclaw` should use the D-AI OpenAI-compatible API when they need persistent conversation context.

## Core Concept

For API clients, authentication and chat history are separate concerns:

```text
Token = authentication and ownership boundary
OpenMeter subject = quota, usage, and request metrics owner
History key = conversation, task, or session context
```

One D-AI token can safely have many history keys. The token should not imply one global chat history.

## Recommended CLI Behavior

Do not send every CLI request into one shared history. A CLI usually handles many independent tasks, so each task or terminal session should get its own history key.

Recommended behavior:

- Create a new history key for a new task, project, support ticket, customer session, or terminal session.
- Reuse the same history key while the user continues the same task with prompts such as `continue`, `fix that`, `run again`, or `explain the previous result`.
- Store the latest history key locally so a command such as `openclaw continue` can resume the latest session.
- Let users list and resume previous histories with commands such as `openclaw sessions` and `openclaw resume debug-login`.
- Use a different history key when the user starts a separate task, even if the same API token is used.

Example history keys:

```text
openclaw:casibase:debug-login
openclaw:casibase:session-20260508-001
openclaw:customer-acme:ticket-4821
```

## API Request

Send the history key with the `X-D-AI-History-Key` header when calling the OpenAI-compatible chat endpoint:

```bash
curl 'http://localhost:5174/api/v1/chat/completions' \
  -H 'Authorization: Bearer dai_xxx' \
  -H 'Content-Type: application/json' \
  -H 'X-D-AI-History-Key: openclaw:casibase:debug-login' \
  --data '{
    "model": "d-ai-casibase",
    "messages": [
      {"role": "user", "content": "Why does login fail?"}
    ],
    "stream": true
  }'
```

If `X-D-AI-History-Key` is omitted, D-AI uses `default`. That is useful for quick tests, but it is not a good default design for a real CLI because unrelated work can be mixed into the same model context.

## Supporting Endpoints

The API also exposes small helper endpoints for CLI session management.

List the custom model ID:

```bash
curl 'http://localhost:5174/api/v1/models' \
  -H 'Authorization: Bearer dai_xxx'
```

List histories for the bearer token:

```bash
curl 'http://localhost:5174/api/v1/histories' \
  -H 'Authorization: Bearer dai_xxx'
```

Get one history by key, including messages when the Casibase session is still available:

```bash
curl 'http://localhost:5174/api/v1/history?key=openclaw%3Acasibase%3Adebug-login' \
  -H 'Authorization: Bearer dai_xxx'
```

The histories response is token-scoped. A token can list only histories created by that token value.

## Product Design

The D-AI chat sidebar is for browser-created chat histories. API histories created by CLI tools are separate operational histories. This is intentional:

- Browser users should not see every background API or CLI session mixed into their normal chat sidebar.
- API token owners still need observability for usage, failures, limits, and quota through the token pages.
- Token pages use OpenMeter-backed metrics and ClickHouse-backed request logs so CLI traffic is observable without mixing API histories into the main chat sidebar.

Useful fields for a future API history view:

- History key
- Token name
- Created time
- Last used time
- OpenMeter request count
- OpenMeter success rate
- OpenMeter failed request count
- OpenMeter input and output tokens
- ClickHouse recent request log entries
- Last model/store used
- Open read-only history action

## Practical CLI UX

A good CLI can map user commands to history behavior like this:

```text
openclaw ask "debug this error"        -> create a new history key
openclaw continue "try another fix"    -> reuse the latest history key
openclaw sessions                      -> list local history keys
openclaw resume debug-login            -> reuse a selected history key
openclaw ask --new "new task"          -> force a new history key
```

This keeps context useful without accidentally leaking one task into another.
