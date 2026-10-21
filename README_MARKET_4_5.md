# VaultQ 4.5 Market Feed Upgrade

The Market API now uses a layered feed strategy:

1. Primary public quote feed: Yahoo Finance chart endpoint.
2. No-key daily fallback: TigZig Tremor market series for NIFTY 50, Sensex, Gold and Silver.
3. FX fallback: TigZig daily USD/INR if Frankfurter is unavailable.
4. Process-local last-successful cache during temporary upstream outages.
5. Bitcoin remains CoinGecko, with a last-successful cache during temporary throttling.

The UI labels the quality of the quote instead of pretending a daily fallback is real-time. The backend returns `status` values such as `LIVE`, `LIVE + FALLBACK`, and `CACHED`.

TigZig documents its Tremor API as open/no-auth and says its market series are daily Yahoo Finance data. Therefore fallback values are clearly labeled as daily references, not exchange-direct real-time quotes.
