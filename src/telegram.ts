import { Bot, InlineKeyboard } from "grammy";
import { PAYMENT_CALLBACK_EXPIRY_MS } from "./constants";
import { pendingTelegramCallbacks } from "./pending";
import { addTelegramMessage, updateTelegramMessageReactions } from "./telegramStore";
import { updateUserContext } from "./userContext";

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
      const authorId = ctx.from?.id;
      const timestampMs = (msg.date ?? Math.floor(Date.now() / 1000)) * 1000;
      const authorUsername = ctx.from?.username ?? null;
      const authorDisplay = ctx.from?.first_name
        ? `${ctx.from.first_name}${ctx.from.last_name ? " " + ctx.from.last_name : ""}`
        : ctx.from?.username ?? null;

      addTelegramMessage(chatId, {
        messageId: msg.message_id,
        text,
        timestampMs,
        authorId,
        authorUsername,
        authorDisplay,
        replyToMessageId:
          msg.reply_to_message && "message_id" in msg.reply_to_message
            ? msg.reply_to_message.message_id
            : undefined,
      });

      // Update user context if we have an author ID (reaction count will be 0 initially)
      if (authorId) {
        updateUserContext("telegram", String(authorId), {
          text,
          username: authorUsername,
          displayName: authorDisplay,
          reactionCount: 0, // Will be updated when reactions come in
          timestampMs,
        });
      }
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
      "Hey! I'm BrookerBot. Use /rant <topic> to generate a blistering Charlie Brooker-style rant."
    );
  });

  bot.command("rant", async (ctx) => {
    const text = ctx.message?.text || "";
    const parts = text.trim().split(/\s+/);
    
    // Extract topic (everything after "/rant")
    const topic = parts.slice(1).join(" ").trim();

    if (!topic) {
      await ctx.reply(
        `❌ Please provide a topic or person to rant about.\n\nUsage: /rant <topic or person>`
      );
      return;
    }

    const chatId = ctx.chat?.id;

    if (!chatId) {
      await ctx.reply("❌ Could not determine chat id.");
      return;
    }

    const token = `${chatId}:${Date.now()}:${crypto.randomUUID()}`;

    const callbackParam = encodeURIComponent(token);
    const url = new URL("/pay", options.baseUrl);
    url.searchParams.set("source", "telegram");
    url.searchParams.set("telegram_callback", callbackParam);
    url.searchParams.set("chatId", String(chatId));
    url.searchParams.set("topic", encodeURIComponent(topic));
    url.searchParams.set("command", "rant");

    const price = process.env.ENTRYPOINT_PRICE || "0.05";
    const keyboard = new InlineKeyboard().url(
      `Pay $${price} via x402`,
      url.toString()
    );

    const paymentMessage = await ctx.reply(
      `🪙 *Payment Required*\n\n` +
        `BrookerBot will generate a blistering rant about: *${topic}*`,
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
      topic,
      command: "rant",
      paymentMessageId: paymentMessage.message_id,
      expiresAt: Date.now() + PAYMENT_CALLBACK_EXPIRY_MS,
    });
  });

  return bot;
}

