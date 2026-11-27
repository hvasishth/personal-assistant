import { useEffect, useRef, useState } from "react";
import {
  fetchMe,
  logout,
  listConversations,
  getConversation,
  type Conversation,
  type User,
} from "./api";
import { LoginForm } from "./components/LoginForm";
import { Chat } from "./components/Chat";
import { ConversationList } from "./components/ConversationList";

// Top-level: holds the signed-in user, the conversation list, and which
// conversation is open. No user -> login. With a user -> sidebar + chat.
export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  // The open conversation. For a fresh "New chat" this is a client-minted UUID
  // that has no row yet — the server creates it on the first message.
  const [activeId, setActiveId] = useState<string | null>(null);
  // Conversation ids currently being polled for an async title, so we never run
  // two poll loops for the same one.
  const titlePolls = useRef<Set<string>>(new Set());

  // On first load, ask the server who the session cookie belongs to (if any).
  useEffect(() => {
    fetchMe().then((u) => {
      setUser(u);
      setLoading(false);
    });
  }, []);

  // Once we have a user, load their conversations and open one: resume the most
  // recent, or start a fresh chat if they have none.
  useEffect(() => {
    if (!user) return;
    listConversations().then((latest) => {
      setConversations(latest);
      setActiveId(latest[0]?.id ?? crypto.randomUUID());
    });
  }, [user]);

  async function handleLogout() {
    await logout();
    setUser(null);
    setConversations([]);
    setActiveId(null);
  }

  function handleNewChat() {
    setActiveId(crypto.randomUUID());
  }

  // After a turn: refresh the list (ordering, and any title already set), then —
  // since titling now runs in the background on the server — poll for the active
  // conversation's title if it doesn't have one yet.
  async function handleTurnComplete() {
    const latest = await listConversations();
    setConversations(latest);
    const active = latest.find((c) => c.id === activeId);
    if (active && !active.title) pollForTitle(active.id);
  }

  // Poll GET /api/conversations/:id a few times until the title appears, then
  // patch it into the list. Gives up quietly after a few tries (it'll still
  // show on the next load). The per-id guard prevents overlapping loops.
  function pollForTitle(id: string) {
    if (titlePolls.current.has(id)) return;
    titlePolls.current.add(id);
    let tries = 0;
    const tick = async () => {
      tries += 1;
      const conv = await getConversation(id);
      if (conv?.title) {
        setConversations((current) =>
          current.map((c) => (c.id === id ? { ...c, title: conv.title } : c)),
        );
        titlePolls.current.delete(id);
        return;
      }
      if (tries >= 6) {
        titlePolls.current.delete(id);
        return;
      }
      setTimeout(tick, 1000);
    };
    setTimeout(tick, 800);
  }

  if (loading) {
    return <div className="center muted">Loading…</div>;
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Personal Assistant</span>
        {user && (
          <span className="user">
            {user.email}
            <button className="link" onClick={handleLogout}>
              Log out
            </button>
          </span>
        )}
      </header>
      <main>
        {user ? (
          <>
            <ConversationList
              conversations={conversations}
              activeId={activeId}
              onSelect={setActiveId}
              onNew={handleNewChat}
            />
            {activeId && (
              <Chat
                key={activeId}
                conversationId={activeId}
                onTurnComplete={handleTurnComplete}
              />
            )}
          </>
        ) : (
          <LoginForm onAuthed={setUser} />
        )}
      </main>
    </div>
  );
}
