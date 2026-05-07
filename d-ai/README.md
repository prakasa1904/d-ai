# D-AI

Small React frontend for the local Casdoor and Casibase stack.

## Run

```bash
npm install
npm run dev
```

Open `http://casibase.local:5173`.

The Vite dev server proxies:

- `/casdoor` to `http://casdoor.local:8000`
- `/casibase` to `http://casibase.local:14000`

Default local Casdoor values are configured in `src/config.js`.
