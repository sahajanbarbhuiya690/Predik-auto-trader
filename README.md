# Predik Auto Trader — production-ready starter

This project is a real server-side implementation, but it is deliberately shipped with `LIVE_TRADING=false`.

## What it does
- Phone + OTP login (Twilio Verify when configured; development OTP otherwise)
- Editable BTC trigger price
- Cross Above / Cross Below
- YES / NO
- Editable INR amount
- Start / Stop
- Authenticated TradingView webhook
- Server-side Predik API integration
- Live market-state check
- Predik quote lock + session refresh + trade
- Idempotency key to prevent duplicate trades
- Per-order INR safety cap
- SQLite execution log

## Important TradingView detail
TradingView sends webhook POSTs when an alert triggers. The webhook endpoint here expects:
`{"userId":1,"price":78500.12,"eventId":"unique-id"}`
with header `X-Webhook-Secret`.

A TradingView alert still has to be configured to send the webhook. If you change the trigger in this dashboard, make sure the TradingView alert is configured to generate the corresponding event; the server will reject events that do not meet the currently saved threshold.

## Setup
1. Install Node.js 20+.
2. Copy `.env.example` to `.env`.
3. Set a long random `JWT_SECRET`.
4. Set `TRADINGVIEW_WEBHOOK_SECRET` to a random secret.
5. Configure Twilio Verify for real SMS OTP.
6. Register a Predik Agent wallet and store the Predik API key in `PREDIK_API_KEY` only on the server.
7. Keep `LIVE_TRADING=false` and test webhooks first.
8. Only after testing, set `LIVE_TRADING=true`.
9. Deploy behind HTTPS on a server. TradingView requires an HTTPS webhook endpoint and cancels requests that take longer than 3 seconds; therefore production should queue the trade and return quickly rather than relying on a synchronous trade call.

## Predik amount
The dashboard accepts INR, converts using `USD_INR_RATE`, then sends a decimal USDC amount to Predik. Refresh `USD_INR_RATE` before live use. Predik's current docs state live trades have a $1 USDC minimum and a 1% buy fee.

## Security
Never put the Predik API key, wallet private key, OTP provider credentials, or JWT secret into TradingView alert messages or client-side JavaScript. Keep them server-side.
