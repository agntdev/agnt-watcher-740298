import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { priceView } from "../crypto.js";

// SCAFFOLD — generated from the bot blueprint BEFORE the agent runs.
// Keep a LIVE registration (.command / .callbackQuery / …) so this feature is
// never an empty stub. Replace the reply body with real logic + copy; if you
// change the user-facing text, update tests/specs to match EXACTLY.
// Do NOT rewrite src/bot.ts — buildBot() already auto-loads this module.

const composer = new Composer<Ctx>();

composer.command("price", async (ctx) => {
  const ticker = ctx.match?.trim();
  await priceView(ctx, ticker || undefined);
});

export default composer;
