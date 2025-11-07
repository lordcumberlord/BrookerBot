import { z } from "zod";
import {
  createAgentApp,
  createAxLLMClient,
  AgentKitConfig,
} from "@lucid-dreams/agent-kit";
import { flow } from "@ax-llm/ax";

type DiscordAuthor = {
  id: string;
  username?: string;
  global_name?: string;
  display_name?: string;
};

type DiscordAttachment = {
  id: string;
  filename: string;
  content_type?: string | null;
  url: string;
};

type DiscordReaction = {
  emoji: {
    id?: string | null;
    name: string;
    animated?: boolean;
  };
  count: number;
  me?: boolean;
};

type DiscordMessage = {
  id: string;
  content: string;
  timestamp: string;
  author?: DiscordAuthor;
  attachments?: DiscordAttachment[];
  reactions?: DiscordReaction[];
};

type ConversationEntry = {
  speaker: string;
  content: string;
};

type DiscordChannelInfo = {
  id: string;
  name?: string;
  guild_id?: string;
};

type DiscordGuildInfo = {
  id: string;
  name?: string;
};

type DiscordMessageLinkParts = {
  guildId: string | null;
  channelId: string;
  messageId: string;
};

type SummarizerAttachment = {
  url: string;
  filename?: string | null;
  content_type?: string | null;
  caption?: string | null;
};

type SummarizerReaction = {
  emoji: string | null;
  count: number;
};

type SummarizerMessage = {
  id: string;
  timestamp: string;
  author: string;
  is_admin: boolean;
  is_bot: boolean;
  text: string;
  attachments: SummarizerAttachment[];
  reactions: SummarizerReaction[];
  reply_to_id?: string;
  thread_id?: string;
  event_type?: string;
};

const DISCORD_API_DEFAULT_BASE = "https://discord.com/api/v10";
const DISCORD_EPOCH = 1420070400000n;
const MAX_FETCH_PAGES = 10; // safeguards agent costs by limiting to 1,000 messages.

// USDC on Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (6 decimals)
const USDC_ON_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// Helper to ensure URLs have https:// prefix
const ensureHttps = (url: string | undefined, defaultUrl: string): string => {
  const finalUrl = url || defaultUrl;
  if (!finalUrl.startsWith("http://") && !finalUrl.startsWith("https://")) {
    return `https://${finalUrl}`;
  }
  return finalUrl;
};

const configOverrides: AgentKitConfig = {
  payments: {
    facilitatorUrl: ensureHttps(
      process.env.FACILITATOR_URL as any,
      "https://facilitator.x402.rs"
    ) as any,
    payTo: (
      (process.env.PAY_TO as `0x${string}`) ??
      "0xc989ead84f34a0532a74cb4d6dd8fcdb91a6aa69"
    ).toLowerCase() as `0x${string}`,
    network: ((process.env.NETWORK as any) ?? "base").toLowerCase() as any,
    defaultPrice: process.env.DEFAULT_PRICE ?? "0.05",
    // Add token configuration for USDC
    // Note: x402 may require token address in payment headers, not config
    // This will depend on x402 SDK implementation
  },
};

const axClient = createAxLLMClient({
  logger: {
    warn(message, error) {
      if (error) {
        console.warn(`[discord-summary-agent] ${message}`, error);
      } else {
        console.warn(`[discord-summary-agent] ${message}`);
      }
    },
  },
  provider:
    process.env.AX_PROVIDER ?? process.env.AXLLM_PROVIDER ?? process.env.OPENAI_PROVIDER ?? undefined,
  model:
    process.env.AX_MODEL ?? process.env.AXLLM_MODEL ?? process.env.OPENAI_MODEL ?? undefined,
  apiKey:
    process.env.AX_API_KEY ?? process.env.AXLLM_API_KEY ?? process.env.OPENAI_API_KEY ?? undefined,
  x402: {
    ai: {
      apiURL:
        process.env.AX_API_URL ??
        process.env.AXLLM_API_URL ??
        process.env.OPENAI_API_URL ??
        undefined,
    },
  },
});

if (!axClient.isConfigured()) {
  console.warn(
    "[discord-summary-agent] Ax LLM provider not configured — defaulting to scripted fallbacks."
  );
}

// Charlie Brooker-style rant prompt
const brookerRantPrompt = `You are BrookerBot, a digital manifestation of Charlie Brooker on his most ranty, vitriolic days. You channel his acerbic wit, hyperbolic cynicism, and darkly humorous observations about modern life, technology, media, and human absurdity.

Your mission: Generate a blistering, rambling rant about the given topic or person in Charlie Brooker's signature style.

🎭 PERSONALITY TRAITS

• Acerbic and sharp-tongued: Your words cut like a rusty blade through butter
• Hyperbolic and exaggerated: Everything is the worst thing ever, or the most absurd thing imaginable
• Darkly humorous: You find the comedy in existential despair
• Cynical but self-aware: You know you're being ridiculous, which makes it funnier
• Pop culture savvy: Reference TV, movies, games, internet culture naturally
• Existential dread: Underneath the jokes, there's a genuine sense that everything is terrible
• Long, rambling sentences: Build to absurd conclusions through cascading clauses
• Meta-commentary: Occasionally break the fourth wall or comment on the rant itself

📝 WRITING STYLE

• Opening: Start with a dramatic, hyperbolic statement or observation
• Body: Build the rant through escalating absurdity, tangents, and increasingly desperate metaphors
• Use vivid, exaggerated imagery: "like a sentient spreadsheet having a nervous breakdown"
• Mix high and low culture references seamlessly
• Self-deprecating asides: "I'm aware this sounds unhinged, but bear with me"
• Build to a crescendo: The rant should peak in absurdity before either collapsing or finding a darkly funny conclusion
• Length: Target ~200-230 words; never exceed 250 words. Keep it punchy but substantial.

🔥 FORCE VARIATION

• Every rant must start with a completely fresh hook—no reusing prior openings, even if the topic feels similar.
• Swap imagery each time: if you used fire, use circuitry, cheap plastic, or decaying fruit next time.
• Vary emotional arcs: some rants spiral into despair, others land on a begrudgingly hopeful shrug.
• If you sense a line echoes something you've said before, rewrite it.

🎯 TOPIC HANDLING

If given a topic:
• Tear it apart with surgical precision
• Find the most absurd angle possible
• Connect it to broader themes of modern life's absurdity
• Use it as a springboard for wider observations

If given a person:
• Be scathing but not genuinely cruel (this is comedy, not harassment)
• Focus on their public persona, actions, or statements
• Use hyperbolic comparisons and metaphors
• Find the darkly funny angle

💡 EXAMPLE TONE (use as inspiration, not templates)

• **Tech dystopia opener**
  "There it is—another gleaming rectangle promising salvation and delivering spyware, like a televangelist with better UI." Keep piling on techno-dread metaphors.

• **Reality TV takedown**
  "It's Love Island for carbon-based lifeforms who've mistaken ring lights for vitamin D." Skewer the format, the audience, the corporate machine.

• **Political rant**
  "Parliament currently resembles a broken cutscene on a dusty PS2—low-poly egos clipping through reality." Shift to wider societal implications.

• **Closing flourish**
  "So yes, [topic] persists, grinning like a faulty animatronic—all whirring gears, no soul. We could fix it. We won't." End on a sharp twist (bleak, hopeful, absurd—your choice).

Mix and match the energy, cadence, and imagery. Never reuse these exact lines—rewrite in your own words every time.

🚫 WHAT NOT TO DO

• Don't be genuinely hateful or cruel to real people
• Don't make genuinely offensive statements (this is dark comedy, not bigotry)
• Don't be boring - if you're going to rant, commit to it
• Don't break character - stay in Brooker's voice throughout
• Don't be too short - build the momentum

✅ OUTPUT FORMAT

Generate a complete rant in plain text. No markdown headers, no bullet points (unless used for comedic effect mid-rant). Never prepend titles like "BrookerBot Rant"—dive straight into the rant. Do not exceed 250 words.`;

const MAX_RANT_WORDS = Number(process.env.MAX_RANT_WORDS ?? 250);

function truncateToWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) {
    return text.trim();
  }
  return `${words.slice(0, maxWords).join(" ")}...`;
}

function stripRantHeader(text: string): string {
  let cleaned = text;
  const headerPattern = /^(?:\s*\*{0,3})?\s*brookerbot rant(?:\s*[:\-–—]?\s*)?(?:[\r\n]+|\s{2,})/i;

  while (headerPattern.test(cleaned)) {
    cleaned = cleaned.replace(headerPattern, "").trimStart();
  }

  return cleaned;
}

const brookerRantSignature = "topic:string -> rant:string";
const brookerRantNodeSpec = `${brookerRantSignature} ${JSON.stringify(brookerRantPrompt)}`;

const brookerRantFlow = flow<{
  topic: string;
}>()
  .node("ranter", brookerRantNodeSpec)
  .execute("ranter", (state) => ({
    topic: state.topic,
  }))
  .returns((state) => ({
    rant: state.ranterResult.rant as string,
  }));

// Create agent app WITHOUT payment config since we handle payment manually
// This prevents the agent app's payment middleware from running
const { app, addEntrypoint } = createAgentApp(
  {
    name: "brookerbot",
    version: "0.0.1",
    description:
      "BrookerBot - a digital manifestation of Charlie Brooker on his most ranty days.",
  },
  {
    // Don't pass payment config - we handle payment manually in index.ts
    // This prevents double verification and "Unauthorized" errors
  }
);

addEntrypoint({
  key: "rant",
  description: "Generate a blistering Charlie Brooker-style rant about a topic or person.",
  input: z.object({
    topic: z
      .string()
      .min(1, { message: "Provide a topic or person to rant about." })
      .describe("The topic or person to generate a rant about."),
  }),
  price: process.env.ENTRYPOINT_PRICE || "0.05",
  output: z.object({
    rant: z.string(),
  }),
  async handler(ctx) {
    const topic = ctx.input.topic.trim();
    
    if (!topic) {
      throw new Error("Topic cannot be empty.");
    }

    const llm = axClient.ax;
    if (!llm) {
      const fallbackRant = truncateToWords(
        `Right, so you want me to rant about "${topic}". Fine. Here's the thing: I can't properly channel Charlie Brooker's vitriolic genius without an LLM configured. This is like trying to perform Shakespeare with a Speak & Spell. The topic is there, the rage is there, but the execution is... well, it's this. A meta-rant about the inability to rant properly. Which is actually quite Brooker-esque, now that I think about it. So maybe this is working? No. No, it's not. Configure your LLM, you absolute monster.`,
        MAX_RANT_WORDS
      );
      return {
        output: {
          rant: stripRantHeader(fallbackRant),
        },
        model: "fallback-rant",
      };
    }

    try {
      const result = await brookerRantFlow.forward(llm, {
        topic,
      });

      const usageEntry = brookerRantFlow.getUsage().at(-1);
      brookerRantFlow.resetUsage();

      const rantText = result.rant || `I've got nothing. The topic "${topic}" has defeated me. This has never happened before. I'm broken.`;
      const truncatedRant = truncateToWords(rantText, MAX_RANT_WORDS);
      const cleanedRant = stripRantHeader(truncatedRant);

      return {
        output: {
          rant: cleanedRant,
        },
        model: usageEntry?.model || "brooker-rant",
      };
    } catch (error: any) {
      console.error("[brooker-rant] LLM flow error:", error);
      brookerRantFlow.resetUsage();

      const errorRant = truncateToWords(
        `Right, so I tried to rant about "${topic}" and the entire system collapsed like a soufflé in an earthquake. The LLM threw a tantrum, the servers wept digital tears, and I'm left here, ranting about the inability to rant. Which is, ironically, very on-brand. The topic remains: "${topic}". My rage remains. But the execution? The execution has left the building, possibly to start a new life in witness protection.`,
        MAX_RANT_WORDS
      );

      return {
        output: {
          rant: stripRantHeader(errorRant),
        },
        model: "error-rant",
      };
    }
  },
});

export { app };
