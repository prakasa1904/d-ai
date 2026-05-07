# D-AI

Custom React frontend for a local Casdoor + Casibase stack. It includes Casdoor login and registration, Casibase chat, editable chat history, streaming steer/stop controls, usage dashboard, token management, optional token limits, user profile management, and a local OpenAI-compatible chat endpoint.

## Prerequisites

- Docker and Docker Compose.
- Node.js 20 or newer.
- npm.
- Local hostnames:

```text
127.0.0.1 casdoor.local
127.0.0.1 casibase.local
```

## Bootstrap

Start Casdoor first, seed the required Casdoor data, then start Casibase:

```bash
cd /Users/nedya.prakasa/Projects/casibase
docker compose up -d casdoor-db casdoor
./scripts/seed-casdoor.sh
docker compose up -d casibase-db casibase
```

If Casibase was already running before the seed:

```bash
docker compose restart casibase
```

Start the D-AI frontend:

```bash
cd /Users/nedya.prakasa/Projects/casibase/d-ai
npm install
npm run dev
```

Open the URL printed by Vite. The usual local URL is:

```text
http://localhost:5174/
```

Vite may use `5173` if that port is available.

## Seeded Casdoor Data

The seed is idempotent and can be re-run safely while `casdoor-db` is running.

Seed files:

```text
scripts/seed-casdoor.sh
scripts/seed-casdoor.sql
```

The seed creates or updates:

```text
Organization: ifm
Application: built-in/casibase
Default user: ifm/user
Default password: user
```

D-AI hardcodes normal user login to Casdoor organization `ifm`, so the login page only asks for username and password.
The same hidden organization is used by the register form, so new users are created under `ifm`.
Registration only asks for display name, username, and password. Email can be added later from `Profile`; sending email during Casdoor signup requires a verification-code flow.

Default D-AI login:

```text
Username: user
Password: user
```

The seeded Casdoor application matches Casibase config:

```text
Application name: casibase
Application owner: built-in
Client ID: ba3a96dbc430c5c6a22b
Client secret: 9228f4ce27971ca5c188cac7489dc0f304a122b6
Redirect URL: http://casibase.local:14000/callback
```

These values are also configured in:

```text
conf/casibase/app.conf
docker-compose.yml
```

## D-AI Configuration

Default local targets:

```text
Casdoor target:  http://casdoor.local:8000
Casibase target: http://casibase.local:14000
Shared store:    admin/store-built-in
```

The Vite dev server proxies browser calls:

```text
/casdoor  -> http://casdoor.local:8000
/casibase -> http://casibase.local:14000
```

D-AI also adds local Vite middleware routes:

```text
/api/d-ai/casdoor-token       Exchanges a Casdoor OAuth code for a profile access token
/api/d-ai/token-state         Syncs browser-created D-AI tokens into the local API layer
/api/v1/chat/completions      OpenAI-compatible chat endpoint
```

Optional `.env.local` overrides:

```bash
VITE_PORT=5173
VITE_CASDOOR_TARGET=http://casdoor.local:8000
VITE_CASIBASE_TARGET=http://casibase.local:14000
VITE_CASDOOR_BASE=/casdoor
VITE_CASIBASE_BASE=/casibase
VITE_CASDOOR_CLIENT_ID=ba3a96dbc430c5c6a22b
VITE_CASDOOR_CLIENT_SECRET=9228f4ce27971ca5c188cac7489dc0f304a122b6
VITE_CASDOOR_APPLICATION=casibase
VITE_CASDOOR_REDIRECT_URI=http://casibase.local:14000/callback
VITE_CASDOOR_SCOPE=profile
VITE_CASIBASE_SHARED_STORE_ID=admin/store-built-in
```

`VITE_CASDOOR_CLIENT_SECRET` is used by the local Vite middleware for development profile updates. Do not expose this dev middleware directly to untrusted clients.

## Useful Commands

```bash
cd /Users/nedya.prakasa/Projects/casibase/d-ai
npm install
npm run dev
npm run build
npm run preview
```

Restart `npm run dev` after changing `vite.config.js`, server middleware, or `.env.local`.

## App Features

- Login page: sign in with a Casdoor user or register a new `ifm` user without exposing the organization field.
- Chat page: create new chats, open history, rename chats, delete chats, and stop or steer an active streaming response.
- Dashboard page: view signed-in user chat and message usage.
- Tokens page: create/copy/delete/activate/deactivate D-AI tokens, view token usage, inspect time-series usage, and configure optional rate limits.
- Profile page: update Casdoor profile fields such as display name, avatar, contact info, work info, preferences, and bio.

Profile updates require a Casdoor access token. New logins obtain it automatically. If you were already signed in before this feature was added, open `Profile`, enter your current password in `Confirm Access`, and save again.

Casibase can still generate its own chat titles, such as `New Chat - 1`, after a conversation is created. Use the sidebar rename or delete actions to manage those chat history entries.

## Model Provider Versioning

Treat Casibase provider names as stable IDs after users start chatting. Casibase persists the provider name on chat and message rows, so renaming or deleting a provider that already has history can break old conversations with errors such as:

```text
The model provider: dummy-model-provider is not found
```

For model changes, create a new provider record, for example `ifm-v2`, and point the shared store to that new provider. Keep the old provider record available while old chats still exist, or migrate old chat/message rows intentionally. D-AI repairs stale chat history to the current store provider before sending, but the safest operational pattern is provider versioning instead of renaming an in-use provider.

## Token Limits

Token quotas are optional when creating a token. Leave the quota blank, or set any limit to `0`, when you do not want that cap:

- Requests per minute.
- Requests per hour.
- Requests per day.
- Tokens per day.
- Total token quota.

## Chat Completions API

The local Vite server exposes an OpenAI-compatible endpoint:

```text
POST http://localhost:5174/api/v1/chat/completions
```

Example:

```bash
curl 'http://localhost:5174/api/v1/chat/completions' \
  -H 'Authorization: Bearer <D_AI_TOKEN>' \
  -H 'Content-Type: application/json' \
  --data '{
    "model": "d-ai-casibase",
    "messages": [{"role": "user", "content": "Hello from D-AI"}],
    "stream": true
  }'
```

Tokens are synced from the browser into the local Vite API layer after sign-in. If a new token is rejected by curl, refresh D-AI once while signed in and try again.

Local API state is stored in:

```text
d-ai/.d-ai-state/tokens.json
```

That folder is git-ignored because it contains bearer tokens and browser session cookies.

## Production Note

The local `/api/d-ai/*` and `/api/v1/chat/completions` routes are implemented as Vite middleware for development. Before exposing this API to real clients, move Casdoor token exchange, token validation, quota enforcement, and Casibase proxy logic into a production backend.

## Troubleshooting

If login fails, re-run the seed and restart Casibase:

```bash
./scripts/seed-casdoor.sh
docker compose restart casibase
```

If curl returns `404` for `/api/v1/chat/completions`, restart the Vite dev server because `vite.config.js` defines that local route.

If registration returns `The verification code has not been sent yet!`, refresh D-AI and restart `npm run dev`. The D-AI register form should not ask for email during initial signup; add email later from `Profile`.

If profile save returns `Unauthorized operation`, refresh `/profile`. If the `Confirm Access` panel appears, enter the current Casdoor password once and save again. If the route still fails, restart the Vite dev server so `/api/d-ai/casdoor-token` is available.
