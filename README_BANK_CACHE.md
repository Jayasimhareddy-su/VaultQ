# VaultQ bank-rate cache upgrade

This version changes Bank Comparison so the browser never waits for RateScan.

## How it works
1. `/api/banks` returns the last cached bank dataset immediately.
2. If no cache exists, VaultQ returns its built-in directory immediately.
3. A background server job fetches the RateScan static dataset and saves it to `database/ratescan-bank-cache.json`.
4. The next page load gets the saved banks and rates instantly.
5. The background refresh runs every 30 minutes.
6. `POST /api/banks/refresh` can force a refresh.

RateScan is used only by the server, not directly by the browser.

## Install into the existing VaultQ project
Replace these two files in your existing project:
- `frontend/banks.html`
- `backend/server.js`

Then run:

```powershell
npm install
npm run dev
```

Open `http://localhost:3000/banks.html`.

The first run will immediately show the built-in directory. After the background RateScan sync succeeds, the cache file is created and subsequent loads show the full cached directory and rates immediately.
