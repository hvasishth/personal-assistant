import { useEffect, useState } from "react";
import {
  fetchMe,
  logout,
  listConversations,
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
    listConversations().then((cs) => {
      setConversations(cs);
      setActiveId(cs[0]?.id ?? crypto.randomUUID());
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

  // After a turn, refresh the list so a new conversation's title shows up and
  // most-recent ordering updates. Selection is unchanged.
  function refreshConversations() {
    listConversations().then(setConversations);
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
                onTurnComplete={refreshConversations}
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
