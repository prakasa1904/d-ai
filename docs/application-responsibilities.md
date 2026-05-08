# Application Responsibilities

This document explains the responsibility boundary between Casdoor, Casibase, and D-AI in the local development stack.

## Component Map

```text
Browser
  -> D-AI React app and Vite middleware
    -> Casdoor for login, registration, profile, and storage provider metadata
    -> Casibase for stores, chats, messages, files, and model execution
    -> D-AI local token state for custom API token metadata
    -> OpenMeter for token usage metrics, request metrics, and quota checks
    -> OpenTelemetry Collector and ClickHouse for structured request audit logs
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

Casdoor OAuth tokens are still important, but they are not a good replacement for D-AI API tokens. A Casdoor access token proves that a user authenticated through a specific Casdoor application, and client-credential tokens belong to the application/client itself. They are not designed as user-managed product API keys with per-token names, revocation, quotas, and OpenMeter-backed usage analytics.

That is why D-AI does not use Casdoor tokens as public API tokens for `/api/v1/chat/completions`. Casdoor remains the identity provider, while D-AI owns the product API token layer.

Casdoor pricing and subscription data can be used to decide which commercial plan a user or organization owns. It should not be the live LLM token quota engine. For the recommended split between Casdoor pricing and OpenMeter entitlements, see [Casdoor Pricing vs OpenMeter Entitlements](casdoor-vs-openmeter-entitlements.md).

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
- OpenMeter customer mapping for quota-style entitlements.
- The deterministic routing rule from one D-AI token plus one history key to one stable Casibase chat.
- Delivery of usage and request events into OpenMeter.
- Delivery of structured request audit logs into the OpenTelemetry pipeline.

In this local stack, D-AI owns token lifecycle and metadata, OpenMeter is the source for token dashboard metrics, request metrics, customer entitlement values, and quota checks, and ClickHouse is the detailed audit log store. See [OpenMeter Integration](openmeter-integration.md) and [Logging Storage Options](logging-storage-options.md).

In local development, D-AI stores this state in:

```text
d-ai/.d-ai-state/tokens.json
```

That file contains sensitive local development data:

- Real `dai_...` bearer token values.
- Casibase session cookies.

It must stay local and git-ignored.

## Local State File

`d-ai/.d-ai-state/tokens.json` is a local persistence file used by the Vite middleware while simulating the production D-AI backend.

It exists because the current D-AI API layer is local middleware, not a deployed backend service yet. The file lets D-AI remember created tokens, token status, and session-cookie bindings after the browser refreshes or the Vite dev server restarts.

This file is not the source of truth for token dashboard metrics, quota counters, quota limit values, entitlement values, or request audit logs. OpenMeter is the source for usage totals, request totals, failure analytics, quota limit values, and customer entitlement values. ClickHouse is the request audit log store.

It is not a Casdoor table and not a Casibase table.

## Production Direction

For production, move the D-AI middleware state into a real backend database. Recommended tables:

```text
d_ai_tokens
d_ai_openmeter_customers
d_ai_metering_outbox
```

Recommended production ownership:

- Casdoor continues to authenticate users.
- Casibase continues to manage AI stores, chats, messages, files, and providers.
- D-AI backend owns product API tokens, token metadata, deterministic API history routing, OpenMeter customer/subject mapping, and a metering outbox for retrying OpenMeter delivery. It should store mappings to OpenMeter entitlements, not duplicate entitlement limit values.
- OpenMeter owns durable metered usage, request metrics, customer entitlement checks, quota values, and billing reporting.
- OpenTelemetry Collector ships request audit logs into ClickHouse or another dedicated logging backend.

If subscription plans are needed, use Casdoor for the user, organization, application access, and paid-plan relationship. Use OpenMeter for the metered entitlement, quota balance, and usage decision. D-AI remains the enforcement point before Casibase is called.

Do not store durable usage metrics or quota counters in the D-AI token table. If you need detailed request auditing beyond OpenMeter metrics, store it separately from token metadata. For the recommended logging storage split, see [Logging Storage Options](logging-storage-options.md).

Do not store production bearer tokens or session cookies in a local JSON file.

## Request Flow

Browser chat flow:

```text
User logs in with Casdoor
D-AI browser receives Casibase session
D-AI chat page sends messages to Casibase APIs
Casibase creates messages and streams model answers
D-AI emits selected-token success or failure events to OpenMeter
```

OpenAI-compatible API flow:

```text
Client sends Authorization: Bearer dai_...
D-AI validates the token from its token store
D-AI checks token status and quota, using OpenMeter customer entitlements and request counters
D-AI reads X-D-AI-History-Key or uses default
D-AI computes a stable Casibase chat name from token + history key
D-AI sends the prompt to Casibase
Casibase executes the model provider
D-AI streams the answer back in OpenAI-compatible format
D-AI sends success or failure request events to OpenMeter
```

## Security Notes

- Never put the raw `dai_...` token value in a URL.
- Use the internal token ID in routes, for example `/tokens/tok_...`.
- Treat `d-ai/.d-ai-state/tokens.json` as secret material.
- In production, replace local session-cookie reuse with a service account or backend-owned authorization model.
- Keep D-AI API token rotation and revocation in the D-AI backend, not in Casdoor.
