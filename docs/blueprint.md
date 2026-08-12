# Crypto Alert Bot — Bot specification

**Archetype:** custom

**Voice:** professional and concise — write every user-facing message, button label, error, and empty state in this voice.

A private Telegram bot for tracking crypto prices with customizable alerts (price threshold and percentage move), on-demand price checks, and optional daily summaries. Users manage watchlists via quick-add buttons or free-text tickers; owner receives usage stats and a leaderboard of most-fired alerts.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- individual crypto traders
- hobbyist investors

## Success criteria

- users can manage watchlists and receive alerts
- owner receives daily usage analytics with top 10 alert rules

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open main menu and onboard new users
- **Add Bitcoin** (button, actor: user, callback: add:BTC) — Quick-add Bitcoin to watchlist
- **Add Ethereum** (button, actor: user, callback: add:ETH) — Quick-add Ethereum to watchlist
- **Add Toncoin** (button, actor: user, callback: add:TON) — Quick-add Toncoin to watchlist
- **/price** (command, actor: user, command: /price) — Request current price for a specific ticker or full watchlist

## Flows

### onboarding
_Trigger:_ /start

1. display feature overview
2. create user profile with default timezone

_Data touched:_ user profile

### alert_creation
_Trigger:_ button: Add price alert

1. prompt for price threshold
2. validate ticker
3. confirm rule details

_Data touched:_ alert rule

### morning_summary
_Trigger:_ scheduled local time

1. compile current prices
2. send summary with threshold proximity warnings

_Data touched:_ user profile, watchlist item

## Owner-supplied settings

The OWNER provides these; they are collected in chat and injected into the environment at deploy. Read each one from the environment where it is used (`ctx.env.<KEY>` / `env.<KEY>` on Cloudflare Workers; `process.env.<KEY>` only as a Node/harness fallback — never the sole read). Do NOT invent your own way of learning the value, do NOT ask for it in a bot message, and do NOT hardcode a default.

- **ADMIN_CHAT_ID** — Receives daily usage stats and alert leaderboard
  - this is the OWNER's own chat id; the platform already knows it. Read `ADMIN_CHAT_ID` via `ctx.env` (prefer toolkit `adminChatId` / `requireOwner`) — never ask a user, never treat whoever writes first as the admin, never invent claim-admin or open manage for everyone.
  - may be UNSET at runtime: the bot must still start, and the feature needing ADMIN_CHAT_ID must say so plainly instead of failing.

Your behavioral specs run WITHOUT these values, so no spec may depend on one.

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

An entity that merely NAMES an owner-supplied setting above (an admin chat, an API account) is not something to store or discover — read it from the environment.

- **user profile** _(retention: persistent)_ — User preferences and settings
  - fields: telegram_id, timezone, quiet_hours, summary_time
- **alert rule** _(retention: persistent)_ — Price alert configuration
  - fields: user_id, ticker, alert_type, threshold
- **alert history** _(retention: persistent)_ — Triggered alerts log
  - fields: timestamp, user_id, rule_id, percent_change

## Integrations

- **Crypto Price API** (required) — Fetch real-time price data
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- ADMIN_CHAT_ID for daily analytics
- configure leaderboard refresh interval

## Notifications

- Price threshold alert messages
- Post-quiet hours summary
- Hourly percent change alerts

## Permissions & privacy

- All user data is private and never shared
- Quiet hours suppress notifications but retain alert history

## Edge cases

- Unknown tickers suggest 5 matches
- Price API failures trigger silent retries
- Quiet hours overlapping with alert triggers

## Required tests

- Add/remove watchlist items with quick buttons
- Verify quiet hours suppression and post-quiet summary
- Confirm alert cooldown prevents duplicate notifications

## Assumptions

- Default cooldown is 30 minutes per rule
- Morning summary is off by default unless user sets time
