import type { ChatMessage, LLMProvider } from "../llm/types";
import type { TurnRow } from "./types";

// Stage 5: the grounded answer. The model gets ONLY the retrieved turns and is
// required to cite the turn id behind each claim and to say "not found" rather
// than invent. This is the honesty contract the spec asks for.

const ANSWER_SYSTEM =
  "You answer questions about the user's own conversation history using ONLY " +
  "the numbered turns provided below. Rules:\n" +
  "- Put the id of the turn supporting each claim in square brackets right " +
  "after it, e.g. [a1b2c3d4].\n" +
  "- Only cite ids that appear in the list. Never invent an id or a fact.\n" +
  '- If the turns do not contain the answer, reply exactly: "Not found in the ' +
  'retrieved turns." and nothing else.\n' +
  "- Be concise: answer the question, cite, stop.";

export interface AnswerDeps {
  llmProvider: LLMProvider;
  model?: string;
}

function renderTurns(turns: TurnRow[]): string {
  return turns
    .map((t) => {
      const title = t.conversationTitle ?? "untitled";
      const date = t.ts.slice(0, 10);
      return `[${t.id}] (${date} · ${title} · ${t.speaker}) ${t.text}`;
    })
    .join("\n\n");
}

// Streams the answer, invoking onToken per chunk (for the CLI). Returns the
// full text and the time to the first token (ms), which the latency budget
// measures against.
export async function streamAnswer(
  deps: AnswerDeps,
  args: { question: string; turns: TurnRow[] },
  onToken?: (t: string) => void,
): Promise<{ text: string; firstTokenMs: number | null }> {
  const messages: ChatMessage[] = [
    { role: "system", content: ANSWER_SYSTEM },
    {
      role: "user",
      content: `Turns:\n${renderTurns(args.turns)}\n\nQuestion: ${args.question}`,
    },
  ];

  const started = Date.now();
  let firstTokenMs: number | null = null;
  let text = "";
  for await (const ev of deps.llmProvider.streamChat(messages, {
    model: deps.model,
    maxTokens: 1024,
  })) {
    if (ev.type === "text") {
      if (firstTokenMs === null) firstTokenMs = Date.now() - started;
      text += ev.text;
      onToken?.(ev.text);
    } else if (ev.type === "error") {
      throw new Error(ev.message);
    }
  }
  return { text, firstTokenMs };
}
