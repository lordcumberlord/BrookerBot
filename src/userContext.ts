import { Database } from "bun:sqlite";
import path from "path";

type UserContext = {
  userId: string;
  platform: "discord" | "telegram";
  username?: string | null;
  displayName?: string | null;
  messageCount: number;
  notableMessages: string[]; // Array of notable message texts (max 20)
  lastSeenMs: number;
  avgMessageLength: number;
  maxMessageLength: number;
  minMessageLength: number;
  totalLength: number;
  keywords: string; // JSON string of word frequencies
  updatedAt: number;
};

const DB_PATH = path.join(process.cwd(), "user_context.db");
const db = new Database(DB_PATH);

// Initialize database
db.exec(`
  CREATE TABLE IF NOT EXISTS user_context (
    user_key TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    username TEXT,
    display_name TEXT,
    message_count INTEGER DEFAULT 0,
    notable_messages TEXT, -- JSON array, max 20 items
    last_seen_ms INTEGER NOT NULL,
    avg_message_length REAL DEFAULT 0,
    max_message_length INTEGER DEFAULT 0,
    min_message_length INTEGER DEFAULT 0,
    total_length INTEGER DEFAULT 0,
    keywords TEXT, -- JSON object of word frequencies
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_user_key ON user_context(user_key);
  CREATE INDEX IF NOT EXISTS idx_platform_user ON user_context(platform, username);
  CREATE INDEX IF NOT EXISTS idx_last_seen ON user_context(last_seen_ms);
`);

const MAX_NOTABLE_MESSAGES = 20;
const MIN_MESSAGE_LENGTH_FOR_NOTABLE = 50; // Messages longer than this are notable
const MIN_REACTIONS_FOR_NOTABLE = 3; // Messages with 3+ reactions are notable

// Helper to create user key (platform:userId)
function getUserKey(platform: "discord" | "telegram", userId: string): string {
  return `${platform}:${userId}`;
}

// Extract simple keywords from text (common words, no stop words)
function extractKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3) // Only words longer than 3 chars
    .filter((w) => !/^(the|and|for|are|but|not|you|all|can|her|was|one|our|out|day|get|has|him|his|how|its|may|new|now|old|see|two|who|way|use|her|she|him|his|how|man|new|now|old|see|two|way|who|boy|did|its|let|put|say|she|too|use)$/i.test(w)); // Basic stop words
  
  // Count frequencies
  const wordCount: Record<string, number> = {};
  words.forEach((word) => {
    wordCount[word] = (wordCount[word] || 0) + 1;
  });
  
  // Return top 10 most frequent words
  return Object.entries(wordCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);
}

// Update user context when a message is received
export function updateUserContext(
  platform: "discord" | "telegram",
  userId: string,
  message: {
    text: string;
    username?: string | null;
    displayName?: string | null;
    reactionCount?: number;
    timestampMs: number;
  }
): void {
  try {
    const userKey = getUserKey(platform, userId);
    const messageLength = message.text.length;
    const isNotable =
      messageLength >= MIN_MESSAGE_LENGTH_FOR_NOTABLE ||
      (message.reactionCount && message.reactionCount >= MIN_REACTIONS_FOR_NOTABLE);

    // Get existing context
    const existing = db
      .query<{
        message_count: number;
        notable_messages: string | null;
        avg_message_length: number;
        max_message_length: number;
        min_message_length: number;
        total_length: number;
        keywords: string | null;
      }>(
        "SELECT message_count, notable_messages, avg_message_length, max_message_length, min_message_length, total_length, keywords FROM user_context WHERE user_key = ?"
      )
      .get(userKey);

    const messageCount = (existing?.message_count || 0) + 1;
    const totalLength = (existing?.total_length || 0) + messageLength;
    const avgMessageLength = totalLength / messageCount;
    const maxMessageLength = Math.max(
      existing?.max_message_length || 0,
      messageLength
    );
    const minMessageLength =
      messageCount === 1
        ? messageLength
        : Math.min(existing?.min_message_length || messageLength, messageLength);

    // Update notable messages
    let notableMessages: string[] = [];
    if (existing?.notable_messages) {
      try {
        notableMessages = JSON.parse(existing.notable_messages);
      } catch {
        notableMessages = [];
      }
    }

    if (isNotable) {
      // Add this message (truncate to 200 chars for storage)
      const messageSnippet = message.text.slice(0, 200);
      notableMessages.unshift(messageSnippet);
      // Keep only the most recent MAX_NOTABLE_MESSAGES
      notableMessages = notableMessages.slice(0, MAX_NOTABLE_MESSAGES);
    }

    // Update keywords (merge with existing)
    const newKeywords = extractKeywords(message.text);
    let existingKeywords: Record<string, number> = {};
    if (existing?.keywords) {
      try {
        existingKeywords = JSON.parse(existing.keywords);
      } catch {
        existingKeywords = {};
      }
    }

    // Merge keyword frequencies
    newKeywords.forEach((word) => {
      existingKeywords[word] = (existingKeywords[word] || 0) + 1;
    });

    // Keep top 20 keywords
    const topKeywords = Object.entries(existingKeywords)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .reduce((acc, [word, count]) => {
        acc[word] = count;
        return acc;
      }, {} as Record<string, number>);

    // Insert or update
    db.run(
      `INSERT INTO user_context (
        user_key, platform, username, display_name, message_count,
        notable_messages, last_seen_ms, avg_message_length,
        max_message_length, min_message_length, total_length,
        keywords, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_key) DO UPDATE SET
        username = COALESCE(?, username),
        display_name = COALESCE(?, display_name),
        message_count = ?,
        notable_messages = ?,
        last_seen_ms = ?,
        avg_message_length = ?,
        max_message_length = ?,
        min_message_length = ?,
        total_length = ?,
        keywords = ?,
        updated_at = ?`,
      [
        userKey,
        platform,
        message.username || null,
        message.displayName || null,
        messageCount,
        JSON.stringify(notableMessages),
        message.timestampMs,
        avgMessageLength,
        maxMessageLength,
        minMessageLength,
        totalLength,
        JSON.stringify(topKeywords),
        Date.now(),
        // Update values
        message.username || null,
        message.displayName || null,
        messageCount,
        JSON.stringify(notableMessages),
        message.timestampMs,
        avgMessageLength,
        maxMessageLength,
        minMessageLength,
        totalLength,
        JSON.stringify(topKeywords),
        Date.now(),
      ]
    );
  } catch (error) {
    // Silently fail - don't break message handling if context update fails
    console.warn(`[userContext] Failed to update context for ${platform}:${userId}:`, error);
  }
}

// Get user context for enriching chat context
export function getUserContext(
  platform: "discord" | "telegram",
  userId: string
): UserContext | null {
  try {
    const userKey = getUserKey(platform, userId);
    const row = db
      .query<{
        user_key: string;
        platform: string;
        username: string | null;
        display_name: string | null;
        message_count: number;
        notable_messages: string | null;
        last_seen_ms: number;
        avg_message_length: number;
        max_message_length: number;
        min_message_length: number;
        total_length: number;
        keywords: string | null;
        updated_at: number;
      }>(
        "SELECT * FROM user_context WHERE user_key = ?"
      )
      .get(userKey);

    if (!row) {
      return null;
    }

    let notableMessages: string[] = [];
    if (row.notable_messages) {
      try {
        notableMessages = JSON.parse(row.notable_messages);
      } catch {
        notableMessages = [];
      }
    }

    let keywords: Record<string, number> = {};
    if (row.keywords) {
      try {
        keywords = JSON.parse(row.keywords);
      } catch {
        keywords = {};
      }
    }

    return {
      userId,
      platform: row.platform as "discord" | "telegram",
      username: row.username,
      displayName: row.display_name,
      messageCount: row.message_count,
      notableMessages,
      lastSeenMs: row.last_seen_ms,
      avgMessageLength: row.avg_message_length,
      maxMessageLength: row.max_message_length,
      minMessageLength: row.min_message_length,
      totalLength: row.total_length,
      keywords: JSON.stringify(keywords),
      updatedAt: row.updated_at,
    };
  } catch (error) {
    console.warn(`[userContext] Failed to get context for ${platform}:${userId}:`, error);
    return null;
  }
}

// Format user context for LLM consumption (condensed summary)
export function formatUserContextForLLM(context: UserContext): string {
  const daysSinceLastSeen = Math.floor(
    (Date.now() - context.lastSeenMs) / (1000 * 60 * 60 * 24)
  );
  const lastSeenText =
    daysSinceLastSeen === 0
      ? "today"
      : daysSinceLastSeen === 1
        ? "yesterday"
        : `${daysSinceLastSeen} days ago`;

  const parts: string[] = [];
  
  parts.push(
    `[historical context: ${context.messageCount} messages, last active ${lastSeenText}]`
  );

  if (context.notableMessages.length > 0) {
    parts.push(
      `[notable messages: ${context.notableMessages.slice(0, 5).join(" | ")}]`
    );
  }

  if (context.keywords) {
    try {
      const keywords = JSON.parse(context.keywords);
      const topKeywords = Object.keys(keywords)
        .slice(0, 5)
        .join(", ");
      if (topKeywords) {
        parts.push(`[common topics: ${topKeywords}]`);
      }
    } catch {
      // Ignore keyword parsing errors
    }
  }

  parts.push(
    `[message style: avg ${Math.round(context.avgMessageLength)} chars, range ${context.minMessageLength}-${context.maxMessageLength}]`
  );

  return parts.join(" ");
}

