import { useEffect, useRef, useState, type FormEvent } from "react";
import { streamChat, type ChatMessage } from "../api";

// The chat screen. Holds the conversation in memory, streams the assistant's
// reply token-by-token into a placeholder message, and auto-scrolls.
export function Chat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the latest message in view as content grows.
  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const content = input.trim();
    if (!content || streaming) return;

    setError(null);
    setInput("");

    const history: ChatMessage[] = [...messages, { role: "user", content }];
    // Append an empty assistant message we fill as tokens arrive.
    setMessages([...history, { role: "assistant", content: "" }]);
    setStreaming(true);

    try {
      await streamChat(history, (text) => {
        setMessages((current) => {
          const copy = current.slice();
          const last = copy[copy.length - 1];
          if (last && last.role === "assistant") {
            copy[copy.length - 1] = { ...last, content: last.content + text };
          }
          return copy;
        });
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "chat failed");
    } finally {
      setStreaming(false);
    }
  }

  return (
    <div className="chat">
      <div className="messages" ref={scrollRef}>
        {messages.length === 0 && (
          <p className="muted empty">Ask me anything to get started.</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="bubble">
              {m.content ||
                (m.role === "assistant" && streaming ? "…" : "")}
            </div>
          </div>
        ))}
      </div>
      {error && <p className="error composer-error">{error}</p>}
      <form className="composer" onSubmit={send}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message…"
          disabled={streaming}
          autoFocus
        />
        <button type="submit" disabled={streaming || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
