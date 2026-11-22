import type { Conversation } from "../api";

// Left panel: a "New chat" button and the list of past conversations. Clicking
// one selects it; the active one is highlighted. Purely presentational — all
// state lives in App.
export function ConversationList({
  conversations,
  activeId,
  onSelect,
  onNew,
}: {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <aside className="sidebar">
      <button className="new-chat" onClick={onNew}>
        + New chat
      </button>
      <nav className="conversations">
        {conversations.length === 0 && (
          <p className="muted empty-list">No conversations yet.</p>
        )}
        {conversations.map((c) => (
          <button
            key={c.id}
            className={`conversation${c.id === activeId ? " active" : ""}`}
            onClick={() => onSelect(c.id)}
            title={c.title ?? "New conversation"}
          >
            {c.title ?? "New conversation"}
          </button>
        ))}
      </nav>
    </aside>
  );
}
