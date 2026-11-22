import { useEffect, useRef, useState, type FormEvent } from "react";
import { streamChat, loadConversation, type ChatMessage } from "../api";

// The chat screen for ONE conversation. `conversationId` is owned by App (so the
// sidebar can switch conversations); App remounts this component via key when it
// changes, so local state resets cleanly. On mount we load the conversation's
// prior messages; `onTurnComplete` lets App refresh the sidebar after a turn
// (so a brand-new conversation's title appears and ordering updates).
export function Chat({
  conversationId,
  onTurnComplete,
}: {
  conversationId: string;
  onTurnComplete?: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load this conversation's history on mount. Returns [] for a brand-new
  // conversation (not yet persisted) or one that isn't ours (server 404s).
  useEffect(() => {
    let cancelled = false;
    loadConversation(conversationId).then((msgs) => {
      if (!cancelled) setMessages(msgs);
    });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

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

    // Mint ids up front. The user-message id doubles as the request's
    // idempotency key; the assistant id is captured in the closure below so
    // tokens route to THIS bubble by id, not by position.
    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();

    // Append the user turn and an empty assistant bubble we fill as tokens arrive.
    setMessages((current) => [
      ...current,
      { id: userMessageId, role: "user", content },
      { id: assistantMessageId, role: "assistant", content: "" },
    ]);
    setStreaming(true);

    try {
      await streamChat(
        { conversationId, message: { id: userMessageId, content }, assistantMessageId },
        (text) => {
          // Find this request's bubble by id wherever it is in the list, so the
          // append stays correct even if other turns arrive meanwhile.
          setMessages((current) =>
            current.map((m) =>
              m.id === assistantMessageId
                ? { ...m, content: m.content + text }
                : m,
            ),
          );
        },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "chat failed");
    } finally {
      setStreaming(false);
      // Surface a new conversation in the sidebar / update its order & title.
      onTurnComplete?.();
    }
  }

  return (
    <div className="chat">
      <div className="messages" ref={scrollRef}>
        {messages.length === 0 && (
          <p className="muted empty">Ask me anything to get started.</p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
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
