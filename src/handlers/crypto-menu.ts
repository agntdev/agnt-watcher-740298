import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { adminChatId, inlineButton, inlineKeyboard, registerMainMenuItem, requireOwner } from "../toolkit/index.js";
import { createRule, evaluateAlerts, formatPrice, quickAdd, removeTicker, searchTicker, setRefresh, setSetting, showAlerts, showSettings, showWatchlist, ownerStats, priceView } from "../crypto.js";

registerMainMenuItem({ label: "My watchlist", data: "watch:show", order: 20 });
registerMainMenuItem({ label: "Check prices", data: "price:show", order: 21 });
registerMainMenuItem({ label: "My alerts", data: "alerts:show", order: 22 });
registerMainMenuItem({ label: "Settings", data: "settings:show", order: 23 });
registerMainMenuItem({ label: "View analytics", data: "owner:stats", order: 90 });

const composer = new Composer<Ctx>();
const prompt = (placeholder: string) => ({ reply_markup: { force_reply: true as const, input_field_placeholder: placeholder } });

composer.callbackQuery("watch:show", async (ctx) => { await ctx.answerCallbackQuery(); await showWatchlist(ctx); });
composer.callbackQuery("alerts:show", async (ctx) => { await ctx.answerCallbackQuery(); await showAlerts(ctx); });
composer.callbackQuery("settings:show", async (ctx) => { await ctx.answerCallbackQuery(); await showSettings(ctx); });
composer.callbackQuery("price:show", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply("Send a ticker such as BTC, or use /price for your watchlist.", prompt("Type a ticker")); ctx.session.step = "ticker"; ctx.session.tickerMode = "price"; });
composer.callbackQuery("watch:add", async (ctx) => { await ctx.answerCallbackQuery(); ctx.session.step = "ticker"; ctx.session.tickerMode = "watch"; await ctx.reply("Send the ticker you want to add.", prompt("Type a ticker")); });
composer.callbackQuery("alert:new", async (ctx) => { await ctx.answerCallbackQuery(); ctx.session.step = "ticker"; ctx.session.tickerMode = "alert"; ctx.session.draftTicker = ""; await ctx.reply("Send the ticker for this alert.", prompt("Type a ticker")); });
composer.callbackQuery(/^rm:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await removeTicker(ctx, ctx.match[1]); });
composer.callbackQuery("alert:price", async (ctx) => { await ctx.answerCallbackQuery(); ctx.session.step = "threshold"; await ctx.reply("Send the USD price that should trigger the alert.", prompt("Example: 100000")); });
composer.callbackQuery("alert:percent", async (ctx) => { await ctx.answerCallbackQuery(); ctx.session.step = "percent"; await ctx.reply("Send the hourly percentage move that should trigger the alert.", prompt("Example: 5")); });
composer.callbackQuery("alert:confirm", async (ctx) => { await ctx.answerCallbackQuery(); if (!ctx.session.draftAlertKind || !ctx.session.draftThreshold) { await ctx.reply("That alert setup expired. Start a new alert from your watchlist."); return; } await createRule(ctx, ctx.session.draftAlertKind, ctx.session.draftThreshold); ctx.session.draftAlertKind = undefined; ctx.session.draftThreshold = undefined; });
composer.callbackQuery("alert:cancel", async (ctx) => { await ctx.answerCallbackQuery(); ctx.session.step = undefined; ctx.session.draftTicker = undefined; ctx.session.draftThreshold = undefined; ctx.session.draftAlertKind = undefined; await ctx.reply("Alert setup cancelled."); });
composer.callbackQuery("set:quiet", async (ctx) => { await ctx.answerCallbackQuery(); ctx.session.step = "quiet"; await ctx.reply("Send quiet hours as 0-7 in your timezone, or send off.", prompt("Example: 22-7")); });
composer.callbackQuery("set:summary", async (ctx) => { await ctx.answerCallbackQuery(); ctx.session.step = "summary"; await ctx.reply("Send a daily summary time in UTC as HH:MM, or send off.", prompt("Example: 08:00")); });
composer.callbackQuery("owner:stats", async (ctx) => { await ctx.answerCallbackQuery(); if (!(await requireOwner(ctx as never))) return; await ownerStats(ctx); });
composer.callbackQuery("owner:refresh", async (ctx) => { await ctx.answerCallbackQuery(); if (!(await requireOwner(ctx as never))) return; await setRefresh(ctx); });

composer.on("message:text", async (ctx, next) => {
  if (!ctx.session.step) return next();
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return next();
  if (ctx.session.step === "ticker") {
    let matches: string[];
    try { matches = await searchTicker(text); } catch { await ctx.reply("I couldn't check that ticker right now. Please try again shortly."); return; }
    if (!matches.length) { await ctx.reply("I couldn't find that ticker. Check the spelling and try again."); return; }
    const ticker = matches[0];
    if (ctx.session.tickerMode === "price") {
      ctx.session.step = undefined; ctx.session.tickerMode = undefined;
      await priceView(ctx, ticker); return;
    }
    if (ctx.session.tickerMode === "alert") {
      ctx.session.draftTicker = ticker;
      ctx.session.step = undefined;
      await ctx.reply(`Use ${ticker} for this alert. Choose the alert type.`, { reply_markup: inlineKeyboard([[inlineButton("Price threshold", "alert:price"), inlineButton("Percent move", "alert:percent")]]) });
      return;
    }
    ctx.session.step = undefined; ctx.session.tickerMode = undefined;
    await quickAdd(ctx, ticker);
    return;
  }
  if (ctx.session.step === "threshold" || ctx.session.step === "percent") {
    const amount = Number(text);
    if (!Number.isFinite(amount) || amount <= 0) { await ctx.reply("Send a positive number for the alert limit."); return; }
    const kind = ctx.session.step === "threshold" ? "price" : "percent";
    ctx.session.draftThreshold = amount; ctx.session.draftAlertKind = kind; ctx.session.step = "confirm";
    const ticker = ctx.session.draftTicker ?? "this coin";
    const detail = kind === "price" ? `${formatPrice(amount)} or above` : `${amount}% move in an hour`;
    await ctx.reply(`Set an alert for ${ticker}: ${detail}?`, { reply_markup: inlineKeyboard([[inlineButton("Confirm alert", "alert:confirm"), inlineButton("Cancel", "alert:cancel")]]) });
    return;
  }
  if (ctx.session.step === "quiet") {
    if (text.toLowerCase() === "off") { await setSetting(ctx, "quiet_hours", ""); return; }
    if (!/^([01]?\d|2[0-3])-([01]?\d|2[0-3])$/.test(text)) { await ctx.reply("Use two hours from 0 to 23, like 22-7, or send off."); return; }
    await setSetting(ctx, "quiet_hours", text); return;
  }
  if (ctx.session.step === "summary") {
    if (text.toLowerCase() === "off") { await setSetting(ctx, "summary_time", ""); return; }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) { await ctx.reply("Use a 24-hour UTC time like 08:00, or send off."); return; }
    await setSetting(ctx, "summary_time", text); return;
  }
});

// Every incoming feature action checks rules. This is deliberately best-effort:
// a price outage never blocks a menu interaction, and the 30-minute rule
// cooldown is stored with the alert before a notification is sent.
composer.use(async (ctx, next) => { await next(); if (ctx.from) await evaluateAlerts(ctx); });

export default composer;
