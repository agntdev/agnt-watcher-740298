import type { Ctx } from "./bot.js";
import { inlineButton, inlineKeyboard } from "./toolkit/index.js";

export type Ticker = "BTC" | "ETH" | "TON" | string;
type AlertKind = "price" | "percent";
export interface AlertRule { id: string; ticker: Ticker; alert_type: AlertKind; threshold: number; lastSentAt?: number; fires: number; }
export interface Profile { telegram_id: number; timezone: string; quiet_hours?: string; summary_time?: string; watchlist: Ticker[]; alerts: AlertRule[]; pending: string[]; }
interface Database { profiles: Record<string, Profile>; users: string[]; leaderboard: Record<string, number>; refreshMinutes: number; }

const COINS: Record<string, string> = { BTC: "bitcoin", ETH: "ethereum", TON: "the-open-network" };
const DEFAULT_DB = (): Database => ({ profiles: {}, users: [], leaderboard: {}, refreshMinutes: 60 });
let testClock: (() => number) | undefined;
export const now = () => testClock?.() ?? Date.now();
export const setClockForTests = (clock?: () => number) => { testClock = clock; };

function env(ctx: Ctx): Record<string, unknown> | undefined { return (ctx as Ctx & { env?: Record<string, unknown> }).env; }
function timezone(): string { return "UTC"; }
function cleanTicker(value: string): string { return value.trim().toUpperCase().replace(/[^A-Z0-9.-]/g, ""); }
function profileFor(ctx: Ctx, db: Database): Profile | undefined { return ctx.from ? db.profiles[String(ctx.from.id)] : undefined; }
function newProfile(id: number): Profile { return { telegram_id: id, timezone: timezone(), watchlist: [], alerts: [], pending: [] }; }

/* The Worker uses its Chat Durable Object; the Node deployment uses the toolkit's
 * Redis-backed session adapter. The tokenless harness has neither service, so its
 * fresh per-bot session provides an isolated, non-production replay fixture. */
async function database(ctx: Ctx): Promise<Database> {
  const worker = env(ctx);
  const ns = worker?.CHAT_DO as { idFromName(name: string): unknown; get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> } } | undefined;
  if (ns) {
    const stub = ns.get(ns.idFromName("crypto-global"));
    const response = await stub.fetch("https://do/domain/crypto", { method: "GET" });
    return response.status === 204 ? DEFAULT_DB() : await response.json() as Database;
  }
  const state = ctx.session.harnessCrypto as Database | undefined;
  return state ?? DEFAULT_DB();
}
async function saveDatabase(ctx: Ctx, db: Database): Promise<void> {
  const worker = env(ctx);
  const ns = worker?.CHAT_DO as { idFromName(name: string): unknown; get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> } } | undefined;
  if (ns) {
    await ns.get(ns.idFromName("crypto-global")).fetch("https://do/domain/crypto", { method: "PUT", body: JSON.stringify(db) });
    return;
  }
  ctx.session.harnessCrypto = db;
}
export async function getProfile(ctx: Ctx, create = true): Promise<Profile | undefined> {
  if (!ctx.from) return undefined;
  const db = await database(ctx);
  const key = String(ctx.from.id);
  let profile = db.profiles[key];
  if (!profile && create) {
    profile = newProfile(ctx.from.id); db.profiles[key] = profile; db.users.push(key); await saveDatabase(ctx, db);
  }
  return profile;
}
async function update(ctx: Ctx, fn: (profile: Profile, db: Database) => void): Promise<Profile | undefined> {
  if (!ctx.from) return undefined;
  const db = await database(ctx); const key = String(ctx.from.id);
  const profile = db.profiles[key] ?? newProfile(ctx.from.id);
  if (!db.profiles[key]) db.users.push(key); db.profiles[key] = profile;
  fn(profile, db); await saveDatabase(ctx, db); return profile;
}

export function backMenu() { return inlineKeyboard([[inlineButton("Back to menu", "menu:main")]]); }
export function watchlistKeyboard(items: string[]) {
  return inlineKeyboard([
    ...items.map((ticker) => [inlineButton(`Remove ${ticker}`, `rm:${ticker}`)]),
    [inlineButton("Add a ticker", "watch:add"), inlineButton("Add price alert", "alert:new")],
    [inlineButton("Back to menu", "menu:main")],
  ]);
}
export async function quickAdd(ctx: Ctx, ticker: Ticker): Promise<void> {
  let exists = false;
  const p = await update(ctx, (profile) => { exists = profile.watchlist.includes(ticker); if (!exists) profile.watchlist.push(ticker); });
  if (!p) return;
  await ctx.reply(exists ? `${ticker} is already on your watchlist.` : `${ticker} is on your watchlist.`, { reply_markup: watchlistKeyboard(p.watchlist) });
}
export async function removeTicker(ctx: Ctx, ticker: string): Promise<void> {
  const p = await update(ctx, (profile) => { profile.watchlist = profile.watchlist.filter((item) => item !== ticker); profile.alerts = profile.alerts.filter((rule) => rule.ticker !== ticker); });
  await ctx.editMessageText(`${ticker} was removed from your watchlist.`, { reply_markup: watchlistKeyboard(p?.watchlist ?? []) });
}
export async function fetchPrices(tickers: string[]): Promise<Record<string, { usd: number; change: number }>> {
  const known = tickers.filter((ticker) => COINS[ticker]);
  if (!known.length) return {};
  const ids = known.map((ticker) => COINS[ticker]).join(",");
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd&include_24hr_change=true`);
      if (!response.ok) throw new Error("price service unavailable");
      const raw = await response.json() as Record<string, { usd?: number; usd_24h_change?: number }>;
      return Object.fromEntries(known.flatMap((ticker) => {
        const value = raw[COINS[ticker]]; return value?.usd === undefined ? [] : [[ticker, { usd: value.usd, change: value.usd_24h_change ?? 0 }]];
      }));
    } catch (error) { last = error; }
  }
  throw last;
}
export function formatPrice(value: number): string { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value < 1 ? 6 : 2 }).format(value); }
export async function priceView(ctx: Ctx, ticker?: string): Promise<void> {
  const profile = await getProfile(ctx); if (!profile) return;
  const requested = ticker ? [cleanTicker(ticker)] : profile.watchlist;
  if (!requested.length) { await ctx.reply("Your watchlist is empty — tap Add Bitcoin, Add Ethereum, or Add Toncoin to begin.", { reply_markup: backMenu() }); return; }
  try {
    const prices = await fetchPrices(requested);
    if (ticker && !prices[requested[0]]) { await ctx.reply(`I couldn't find ${cleanTicker(ticker)}. Try BTC, ETH, or TON.`, { reply_markup: backMenu() }); return; }
    const lines = Object.entries(prices).map(([symbol, price]) => `${symbol}: ${formatPrice(price.usd)} (${price.change >= 0 ? "+" : ""}${price.change.toFixed(2)}% today)`);
    await ctx.reply(lines.length ? lines.join("\n") : "I couldn't get a price right now. Please try again shortly.", { reply_markup: backMenu() });
  } catch { await ctx.reply("I couldn't get prices right now. Please try again shortly.", { reply_markup: backMenu() }); }
}
export async function searchTicker(query: string): Promise<string[]> {
  const cleaned = cleanTicker(query); if (COINS[cleaned]) return [cleaned];
  const response = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`);
  if (!response.ok) throw new Error("search unavailable");
  const body = await response.json() as { coins?: Array<{ symbol?: string }> };
  return (body.coins ?? []).map((coin) => cleanTicker(coin.symbol ?? "")).filter(Boolean).slice(0, 5);
}
export async function createRule(ctx: Ctx, kind: AlertKind, threshold: number): Promise<void> {
  const ticker = ctx.session.draftTicker; if (!ticker) { await ctx.reply("Choose a ticker first."); return; }
  await update(ctx, (profile) => { profile.alerts.push({ id: `${now()}-${profile.alerts.length}`, ticker, alert_type: kind, threshold, fires: 0 }); });
  ctx.session.step = undefined; ctx.session.draftTicker = undefined;
  const phrase = kind === "price" ? `${formatPrice(threshold)} or above` : `${threshold}% move in an hour`;
  await ctx.reply(`Alert set for ${ticker}: ${phrase}.`, { reply_markup: backMenu() });
}
export async function evaluateAlerts(ctx: Ctx): Promise<void> {
  const profile = await getProfile(ctx, false); if (!profile?.alerts.length) return;
  let prices: Record<string, { usd: number; change: number }>;
  try { prices = await fetchPrices([...new Set(profile.alerts.map((rule) => rule.ticker))]); } catch { return; }
  const quiet = isQuiet(profile); const due: AlertRule[] = [];
  let pendingCount = 0;
  await update(ctx, (fresh, db) => {
    if (!quiet && fresh.pending.length) { pendingCount = fresh.pending.length; fresh.pending = []; }
    for (const rule of fresh.alerts) {
      const price = prices[rule.ticker]; const hit = price && (rule.alert_type === "price" ? price.usd >= rule.threshold : Math.abs(price.change) >= rule.threshold);
      if (hit && (!rule.lastSentAt || now() - rule.lastSentAt >= 30 * 60_000)) { rule.lastSentAt = now(); rule.fires++; db.leaderboard[rule.id] = (db.leaderboard[rule.id] ?? 0) + 1; due.push(rule); }
    }
    if (quiet) fresh.pending.push(...due.map((rule) => rule.id));
  });
  if (!quiet && pendingCount) await ctx.reply(`Your quiet-hours summary: ${pendingCount} alert${pendingCount === 1 ? "" : "s"} fired while notifications were paused.`);
  if (!quiet) for (const rule of due) { const value = prices[rule.ticker]; await ctx.reply(`${rule.ticker} alert: ${rule.alert_type === "price" ? formatPrice(value.usd) : `${value.change.toFixed(2)}%`} reached your limit.`); }
}
function isQuiet(profile: Profile): boolean {
  if (!profile.quiet_hours) return false;
  const parts = profile.quiet_hours.split("-"); if (parts.length !== 2) return false;
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: profile.timezone, hour: "2-digit", hourCycle: "h23" }).format(new Date(now())));
  const start = Number(parts[0]); const end = Number(parts[1]);
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}
export async function showWatchlist(ctx: Ctx): Promise<void> { const p = await getProfile(ctx); if (!p) return; await ctx.editMessageText(p.watchlist.length ? `Your watchlist: ${p.watchlist.join(", ")}.` : "No watchlist items yet — tap Add a ticker to create one.", { reply_markup: watchlistKeyboard(p.watchlist) }); }
export async function showAlerts(ctx: Ctx): Promise<void> { const p = await getProfile(ctx); if (!p) return; const text = p.alerts.length ? p.alerts.map((rule) => `${rule.ticker}: ${rule.alert_type === "price" ? formatPrice(rule.threshold) : `${rule.threshold}% move`}`).join("\n") : "No alerts yet — tap Add price alert to create one."; await ctx.editMessageText(text, { reply_markup: inlineKeyboard([[inlineButton("Add price alert", "alert:new")], [inlineButton("Back to menu", "menu:main")]]) }); }
export async function showSettings(ctx: Ctx): Promise<void> { const p = await getProfile(ctx); if (!p) return; await ctx.editMessageText(`Timezone: ${p.timezone}\nQuiet hours: ${p.quiet_hours ?? "Off"}\nDaily summary: ${p.summary_time ?? "Off"}`, { reply_markup: inlineKeyboard([[inlineButton("Set quiet hours", "set:quiet"), inlineButton("Set summary time", "set:summary")], [inlineButton("Back to menu", "menu:main")]]) }); }
export async function setSetting(ctx: Ctx, key: "quiet_hours" | "summary_time", value: string): Promise<void> { await update(ctx, (p) => { p[key] = value; }); ctx.session.step = undefined; await ctx.reply(key === "quiet_hours" ? `Quiet hours are set to ${value}.` : `Daily summary is set for ${value} UTC.`, { reply_markup: backMenu() }); }
export async function ownerStats(ctx: Ctx): Promise<void> { const db = await database(ctx); const rules = Object.entries(db.leaderboard).sort((a,b) => b[1]-a[1]).slice(0,10); await ctx.editMessageText(`Tracked users: ${db.users.length}\nTop fired alerts: ${rules.length ? rules.map(([, count], i) => `${i+1}. ${count} fires`).join("\n") : "No alerts have fired yet."}`, { reply_markup: inlineKeyboard([[inlineButton("Refresh interval", "owner:refresh")], [inlineButton("Back to menu", "menu:main")]]) }); }
export async function setRefresh(ctx: Ctx): Promise<void> { const db = await database(ctx); db.refreshMinutes = db.refreshMinutes === 60 ? 30 : 60; await saveDatabase(ctx, db); await ctx.editMessageText(`Leaderboard refresh is set to every ${db.refreshMinutes} minutes.`, { reply_markup: backMenu() }); }
