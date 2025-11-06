export type TelegramCallbackData = {
  chatId: number;
  threadId?: number | null;
  messageId?: number | null;
  paymentMessageId?: number;
  username?: string | null;
  topic: string;
  command: "rant";
  expiresAt: number;
};

export const pendingTelegramCallbacks = new Map<string, TelegramCallbackData>();

