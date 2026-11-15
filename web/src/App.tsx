import { useEffect, useState } from "react";
import { fetchMe, logout, type User } from "./api";
import { LoginForm } from "./components/LoginForm";
import { Chat } from "./components/Chat";

// Top-level: hold the signed-in user. No user -> show login; user -> show chat.
export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // On first load, ask the server who the session cookie belongs to (if any).
  useEffect(() => {
    fetchMe().then((u) => {
      setUser(u);
      setLoading(false);
    });
  }, []);

  async function handleLogout() {
    await logout();
    setUser(null);
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
      <main>{user ? <Chat /> : <LoginForm onAuthed={setUser} />}</main>
    </div>
  );
}
