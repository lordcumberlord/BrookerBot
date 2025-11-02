export type DiscordCallbackData = {
  applicationId: string;
  channelId: string;
  guildId: string | null;
  query: string;
  lookbackMinutes: number;
  paymentMessageId?: string;
  expiresAt: number;
};

export type TelegramCallbackData = {
  chatId: number;
  threadId?: number | null;
  messageId?: number | null;
  paymentMessageId?: number;
  username?: string | null;
  query: string;
  lookbackMinutes: number;
  expiresAt: number;
};

export const pendingDiscordCallbacks = new Map<string, DiscordCallbackData>();
export const pendingTelegramCallbacks = new Map<string, TelegramCallbackData>();

