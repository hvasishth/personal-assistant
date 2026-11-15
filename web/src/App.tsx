import { useEffect, useState } from "react";
import { clearToken, fetchMe, getToken, type User } from "./api";
import { LoginForm } from "./components/LoginForm";
import { Chat } from "./components/Chat";

// Top-level: hold the signed-in user. No user -> show login; user -> show chat.
export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // On first load, if we have a stored token, confirm it with the server.
  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    fetchMe().then((u) => {
      if (!u) clearToken();
      setUser(u);
      setLoading(false);
    });
  }, []);

  function handleLogout() {
    clearToken();
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
