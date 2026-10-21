# VaultQ Final Edition 4.0

VaultQ is a professional full-stack financial management prototype built with Node.js, Express, SQLite, HTML, CSS and JavaScript.

## Final modules
- Secure registration, login, sessions and password management
- Professional responsive dashboard with clickable sections and financial-health insights
- Portfolio, investments and transaction tracking
- Expense tracking and financial goals
- India bank directory with manual selection, search, filters, sorting and side-by-side comparison
- RateScan-backed bank-rate cache with instant local response and background refresh
- Secure PDF/CSV bank-statement import with temporary-file cleanup and automatic transaction categorization
- Market intelligence for NIFTY 50, Sensex, gold, silver and Bitcoin
- Automatic market refresh with visible source/freshness messaging
- VaultQ AI account-aware assistant with explainable portfolio, spending, goal and diversification answers
- English, Hindi and Telugu UI switching
- Dark/light theme
- SIP, EMI and FD calculators
- Mobile responsive navigation and polished rounded-card UI

## Run
```bash
npm install
npm run dev
```
Open `http://localhost:3000`.

## Demo data
```bash
node database/seed.js
```
Demo login:
- Email: `demo@vaultq.com`
- Password: `Demo@123`

## Environment
Copy `.env.example` to `.env` and set a strong `SESSION_SECRET` for deployment.

## Data-source notes
- Bank rates use RateScan.in's public dataset and are refreshed in the background. The bank should remain the final authority for current product terms.
- Market data uses public Yahoo Finance chart data for NIFTY 50, Sensex and metal futures, CoinGecko for Bitcoin, and Frankfurter for USD/INR. Public feeds can be delayed.
- Gold and silver are reference conversions, not IBJA jewellery-retail quotes.
- VaultQ AI is an explainable in-app assistant based on the user's stored VaultQ data. It is educational and not a licensed financial adviser.
- For production deployment, use HTTPS, a strong session secret, a production session store, upload validation/malware scanning, rate limiting and a licensed real-time market-data provider if guaranteed exchange-direct data is required.

## Latest final-upgrade changes

### Expenses
- Bank statement import has been moved out of Bank Comparison and into Expenses.
- PDF/CSV statement import, password handling, automatic categorization, imported transaction analytics, and delete controls now live on `expenses.html`.
- Statement files and passwords are not stored by the application.

### Bank Comparison
- Removed the fixed “34 banks” presentation from the UI.
- Bank selection remains manual with search/filter/sort controls.
- Selecting two or more banks now automatically builds the side-by-side comparison at the bottom.
- The Compare button can still be used to jump to the comparison.
- Selected banks remain selected while filtering/sorting.

### VaultQ AI
- Added an OpenAI Responses API integration for a substantially more capable conversational assistant.
- The OpenAI API key is kept server-side and is never placed in browser JavaScript.
- Conversation history is sent with each request so follow-up questions work naturally.
- The AI receives the user's VaultQ portfolio, expenses, goals, cash and bank-flow context.
- If `OPENAI_API_KEY` is not configured, VaultQ automatically falls back to its local account-aware AI instead of breaking.

### Enable OpenAI-powered VaultQ AI
1. Copy `.env.example` to `.env`.
2. Put your OpenAI API key in `OPENAI_API_KEY`.
3. Optionally change `OPENAI_MODEL`.
4. Run `npm install` and then `npm run dev`.

Never commit `.env` or expose `OPENAI_API_KEY` in frontend code.

## VaultQ AI without an API key
VaultQ AI works without a cloud API key. It uses this priority:
1. OpenAI, when `OPENAI_API_KEY` is configured.
2. Ollama on the local machine, when available at `OLLAMA_HOST` with `OLLAMA_MODEL` (default `mistral`).
3. VaultQ's built-in account-aware reasoning engine as the final fallback.

For Ollama, install Ollama separately and pull a model such as `mistral`. Keep the Ollama service running while using VaultQ AI. No OpenAI key is needed in this mode.
