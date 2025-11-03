import { Bot, InlineKeyboard } from "grammy";
import { validateLookback } from "./lookback";
import { PAYMENT_CALLBACK_EXPIRY_MS } from "./constants";
import { pendingTelegramCallbacks } from "./pending";
import { addTelegramMessage, updateTelegramMessageReactions } from "./telegramStore";

const DEFAULT_LOOKBACK_MINUTES = 60;

function parseCumCommand(text: string | undefined): { query: string; lookbackMinutes: number } | { error: string } {
  if (!text) {
    return { error: "Usage: /Cum for <topic> or /Cum for @username" };
  }
  
  // Parse: /Cum for <query> [minutes]
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3 || parts[0].toLowerCase() !== "/cum" || parts[1].toLowerCase() !== "for") {
    return { error: "Usage: /Cum for <topic> or /Cum for @username" };
  }
  
  // Extract query (everything after "for")
  const queryStart = text.indexOf("for") + 3;
  let rest = text.substring(queryStart).trim();
  
  // Check if there's a number at the end (lookback minutes)
  const lastWord = rest.split(/\s+/).pop();
  const lookbackResult = validateLookback(lastWord || "");
  
  let query: string;
  let lookbackMinutes: number;
  
  if (!("error" in lookbackResult)) {
    // Last word is a number, use it as lookback
    lookbackMinutes = lookbackResult.minutes;
    query = rest.substring(0, rest.lastIndexOf(lastWord!)).trim();
  } else {
    // No lookback specified, use default
    lookbackMinutes = DEFAULT_LOOKBACK_MINUTES;
    query = rest.trim();
  }
  
  if (!query) {
    return { error: "Please specify a topic or @username" };
  }
  
  return { query, lookbackMinutes };
}

export function createTelegramBot(options: {
  token: string;
  baseUrl: string;
}) {
  const bot = new Bot(options.token);

  bot.catch((err) => {
    console.error("[telegram] polling error", err.error ?? err);
  });

  bot.on("message", async (ctx, next) => {
    const msg = ctx.message;
    if (!msg) {
      return next();
    }
    const chatId = msg.chat?.id;
    const text = "text" in msg ? msg.text ?? "" : "";
    // Don't store command messages - they shouldn't be included in summaries
    const trimmed = text.trim();
    if (chatId && trimmed.length > 0 && !trimmed.startsWith("/")) {
      addTelegramMessage(chatId, {
        messageId: msg.message_id,
        text,
        timestampMs: (msg.date ?? Math.floor(Date.now() / 1000)) * 1000,
        authorId: ctx.from?.id,
        authorUsername: ctx.from?.username ?? null,
        authorDisplay: ctx.from?.first_name
          ? `${ctx.from.first_name}${ctx.from.last_name ? " " + ctx.from.last_name : ""}`
          : ctx.from?.username ?? null,
        replyToMessageId:
          msg.reply_to_message && "message_id" in msg.reply_to_message
            ? msg.reply_to_message.message_id
            : undefined,
      });
    }
    return next();
  });

  // Handle message reactions - track reaction counts for messages
  bot.on("message_reaction", async (ctx) => {
    try {
      const update = ctx.update.message_reaction;
      if (!update) return;
      
      const chatId = update.chat.id;
      const messageId = update.message_id;
      
      // Get current reactions count from the update
      // Telegram provides reaction_counts in the message_reaction update
      const reactionCounts = update.reaction_counts || [];
      const totalReactions = reactionCounts.reduce((sum, rc) => sum + (rc.count || 0), 0);
      
      if (totalReactions > 0) {
        updateTelegramMessageReactions(chatId, messageId, totalReactions);
      } else {
        // No reactions - set to 0
        updateTelegramMessageReactions(chatId, messageId, 0);
      }
    } catch (error) {
      console.warn("[telegram] Error handling message reaction:", error);
    }
  });

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "hey. i'm CumBot. use /Cum for <topic> or /Cum for @username to summon me."
    );
  });

  bot.command("cum", async (ctx) => {
    const parseResult = parseCumCommand(ctx.message?.text);

    if ("error" in parseResult) {
      await ctx.reply(parseResult.error);
      return;
    }

    const { query, lookbackMinutes } = parseResult;
    const chatId = ctx.chat?.id;

    if (!chatId) {
      await ctx.reply("could not determine chat id");
      return;
    }

    const token = `${chatId}:${Date.now()}:${crypto.randomUUID()}`;

    const callbackParam = encodeURIComponent(token);
    const url = new URL("/pay", options.baseUrl);
    url.searchParams.set("source", "telegram");
    url.searchParams.set("telegram_callback", callbackParam);
    url.searchParams.set("chatId", String(chatId));
    url.searchParams.set("query", query);
    url.searchParams.set("lookbackMinutes", String(lookbackMinutes));

    const keyboard = new InlineKeyboard().url(
      "Pay $1.00 via x402",
      url.toString()
    );

    const paymentMessage = await ctx.reply(
      `💳 *Payment Required*\n\n` +
        `/Cum for "${query}" (${lookbackMinutes} min context)`,
      {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      }
    );

    pendingTelegramCallbacks.set(token, {
      chatId,
      threadId: "message_thread_id" in ctx.message ? ctx.message.message_thread_id : undefined,
      messageId: ctx.message?.message_id,
      username: ctx.from?.username,
      query,
      lookbackMinutes,
      paymentMessageId: paymentMessage.message_id,
      expiresAt: Date.now() + PAYMENT_CALLBACK_EXPIRY_MS,
    });
  });

  return bot;
}

