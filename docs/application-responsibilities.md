# Application Responsibilities

This document explains the responsibility boundary between Casdoor, Casibase, and D-AI in the local development stack.

## Component Map

```text
Browser
  -> D-AI React app and Vite middleware
    -> Casdoor for login, registration, profile, and storage provider metadata
    -> Casibase for stores, chats, messages, files, and model execution
    -> D-AI local token state for custom API tokens, quotas, and logs
```

## Casdoor

Casdoor is the identity and application configuration system.

Casdoor owns:

- Organizations, such as `ifm`.
- Users and passwords.
- Login and registration.
- OAuth application config for `casibase`.
- User profile data used by the D-AI profile page.
- Storage provider records for distributed storage, such as `provider-storage-ifm-minio-v1`.
- Application-provider binding, which lets Casibase use a Casdoor storage provider.

Casdoor does not own D-AI `dai_...` API tokens. Those tokens are application-level API credentials created by D-AI.

## Casibase

Casibase is the AI workspace and model execution system.

Casibase owns:

- Stores, such as `admin/ifm-v0`.
- Store provider bindings, such as model provider, embedding provider, and storage provider name.
- Chats and messages.
- Model provider usage inside chat/message records.
- Uploaded file records and file tree data.
- Calls to the configured model provider.

Casibase does not own D-AI `dai_...` API tokens. D-AI uses those tokens to authorize calls into its own OpenAI-compatible API, then proxies the request into Casibase using the signed-in user's Casibase session.

## D-AI

D-AI is the product frontend and local API middleware.

D-AI owns:

- Browser UI for login, chat, dashboard, tokens, and profile.
- The custom OpenAI-compatible API under `/api/v1/*`.
- D-AI `dai_...` bearer tokens.
- Token active/inactive status.
- Token quota and rate limit configuration.
- Per-token usage records.
- Per-token request logs.
- API history keys for CLI/API clients.
- The mapping from one D-AI token plus one history key to one stable Casibase chat.

In local development, D-AI stores this state in:

```text
d-ai/.d-ai-state/tokens.json
```

That file contains sensitive local development data:

- Real `dai_...` bearer token values.
- Casibase session cookies.
- Token quota configuration.
- Token usage records.
- Token request logs.

It must stay local and git-ignored.

## Local State File

`d-ai/.d-ai-state/tokens.json` is a development-only persistence file used by the Vite middleware.

It exists because the current D-AI API layer is local middleware, not a production backend service yet. The file lets D-AI remember created tokens and their usage after the browser refreshes or the Vite dev server restarts.

It is not a Casdoor table and not a Casibase table.

## Production Direction

For production, move the D-AI middleware state into a real backend database. Recommended tables:

```text
d_ai_tokens
d_ai_token_usage
d_ai_token_request_logs
d_ai_api_histories
```

Recommended production ownership:

- Casdoor continues to authenticate users.
- Casibase continues to manage AI stores, chats, messages, files, and providers.
- D-AI backend owns product API tokens, quota enforcement, usage logs, and API history mapping.

Do not store production bearer tokens or session cookies in a local JSON file.

## Request Flow

Browser chat flow:

```text
User logs in with Casdoor
D-AI browser receives Casibase session
D-AI chat page sends messages to Casibase APIs
Casibase creates messages and streams model answers
D-AI records token usage when a D-AI token is selected in the chat UI
```

OpenAI-compatible API flow:

```text
Client sends Authorization: Bearer dai_...
D-AI validates the token from its token store
D-AI checks token status and quota
D-AI reads X-D-AI-History-Key or uses default
D-AI maps token + history key to a stable Casibase chat
D-AI sends the prompt to Casibase
Casibase executes the model provider
D-AI streams the answer back in OpenAI-compatible format
D-AI records usage and request logs
```

## Security Notes

- Never put the raw `dai_...` token value in a URL.
- Use the internal token ID in routes, for example `/tokens/tok_...`.
- Treat `d-ai/.d-ai-state/tokens.json` as secret material.
- In production, replace local session-cookie reuse with a service account or backend-owned authorization model.
- Keep D-AI API token rotation and revocation in the D-AI backend, not in Casdoor.

