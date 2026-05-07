# D-AI

Custom React frontend for a local Casdoor + Casibase stack. It includes Casdoor login, Casibase chat, chat history, usage dashboard, token management, token limits, and a local OpenAI-compatible chat endpoint.

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
```

The Vite dev server proxies browser calls:

```text
/casdoor  -> http://casdoor.local:8000
/casibase -> http://casibase.local:14000
```

Optional `.env.local` overrides:

```bash
VITE_PORT=5173
VITE_CASDOOR_TARGET=http://casdoor.local:8000
VITE_CASIBASE_TARGET=http://casibase.local:14000
VITE_CASDOOR_BASE=/casdoor
VITE_CASIBASE_BASE=/casibase
VITE_CASDOOR_CLIENT_ID=ba3a96dbc430c5c6a22b
VITE_CASDOOR_APPLICATION=casibase
VITE_CASDOOR_REDIRECT_URI=http://casibase.local:14000/callback
VITE_CASDOOR_SCOPE=profile
```

## Useful Commands

```bash
cd /Users/nedya.prakasa/Projects/casibase/d-ai
npm install
npm run dev
npm run build
npm run preview
```

## Token Limits

New tokens must be created with a lifetime token quota. Existing tokens without a quota are invalid until edited in the rate-limit tracker.

Rolling limits can stay `0` when you do not want those specific caps:

- Requests per minute.
- Requests per hour.
- Requests per day.
- Tokens per day.

The lifetime `Total token quota` cannot be unlimited.

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

The `/api/v1/chat/completions` route is implemented as Vite local middleware for development. Before exposing this API to real clients, move token validation, quota enforcement, and Casibase proxy logic into a production backend.

## Troubleshooting

If login fails, re-run the seed and restart Casibase:

```bash
./scripts/seed-casdoor.sh
docker compose restart casibase
```

If curl returns `404` for `/api/v1/chat/completions`, restart the Vite dev server because `vite.config.js` defines that local route.

