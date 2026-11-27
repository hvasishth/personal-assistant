import type { ChatMessage, LLMProvider } from "../llm/types";
import type { Pool } from "../db";
import { getConversationTitle, setConversationTitleIfNull } from "./repo";
import { log } from "../logger";

// Auto-titling: generate a short conversation title from the first user message
// with a cheap, fast model (not the main chat model — titling doesn't need it).
// This is a one-shot completion, so we consume the provider's stream and
// accumulate the text rather than forwarding it anywhere.

const TITLE_MODEL = "claude-haiku-5-5";
const TITLE_MAX_TOKENS = 24;

export async function generateTitle(
  llmProvider: LLMProvider,
  firstUserMessage: string,
): Promise<string | null> {
  const prompt: ChatMessage[] = [
    {
      role: "user",
      content:
        "Write a short, descriptive title (3-6 words) for a conversation that " +
        "begins with the message below. Reply with ONLY the title — no quotes, " +
        "no surrounding punctuation, no trailing period.\n\n" +
        `Message: ${firstUserMessage}`,
    },
  ];

  let text = "";
  try {
    for await (const ev of llmProvider.streamChat(prompt, {
      model: TITLE_MODEL,
      maxTokens: TITLE_MAX_TOKENS,
    })) {
      if (ev.type === "text") text += ev.text;
      else if (ev.type === "error") {
        log.warn("title generation error:", ev.message);
        return null;
      }
    }
  } catch (err) {
    log.warn("title generation failed:", err);
    return null;
  }

  return cleanTitle(text);
}

// Generate and persist a title for a conversation IF it has none yet. Safe to
// call on every completed turn (and on replays): it no-ops once a title exists,
// so it also self-heals a conversation whose earlier titling was missed. Fully
// self-contained and best-effort — owns its errors and never rejects — so the
// chat route can invoke it fire-and-forget without blocking the response.
export async function autoTitleConversation(
  pool: Pool,
  llmProvider: LLMProvider,
  conversationId: string,
  firstUserMessage: string,
): Promise<void> {
  try {
    const existing = await getConversationTitle(pool, conversationId);
    if (existing) return; // already titled (or being titled by a prior call)
    const title = await generateTitle(llmProvider, firstUserMessage);
    if (title) await setConversationTitleIfNull(pool, conversationId, title);
  } catch (err) {
    log.warn("auto-title failed:", err);
  }
}

// Trim, strip wrapping quotes the model sometimes adds, drop a trailing period,
// collapse whitespace, and cap length. Returns null if nothing usable remains.
function cleanTitle(raw: string): string | null {
  let title = raw.trim().replace(/\s+/g, " ");
  title = title.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  title = title.replace(/\.$/, "").trim();
  if (!title) return null;
  return title.slice(0, 80);
}
