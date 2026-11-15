// The browser's view of the server. Every request goes through the Vite dev
// proxy to the Express server, so these are same-origin paths.
//
// Auth is cookie-based: the server sets an httpOnly session cookie on
// login/signup, and the browser sends it automatically. JS never sees the
// token — we just pass `credentials: "include"` so the cookie rides along.

export interface User {
  id: string;
  email: string;
}

export interface ChatMessage {
  // Client-minted UUID. The user message's id is the request's idempotency
  // key; the assistant message's id is the bubble we stream tokens into and
  // the row the server persists the reply under.
  id: string;
  role: "user" | "assistant";
  content: string;
}

// One chat turn, as the server expects it. We send only the new user message
// plus the ids — the server reloads prior history from the DB itself, so we no
// longer ship the whole conversation each time.
export interface ChatRequest {
  conversationId: string;
  message: { id: string; content: string };
  assistantMessageId: string;
}

// --- Auth ------------------------------------------------------------------

async function postAuth(
  path: string,
  email: string,
  password: string,
): Promise<User> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error ?? `request failed (${res.status})`);
  }
  return data.user as User;
}

export function signup(email: string, password: string): Promise<User> {
  return postAuth("/auth/signup", email, password);
}
export function login(email: string, password: string): Promise<User> {
  return postAuth("/auth/login", email, password);
}

// Who is the current session for? null if the cookie is missing/expired.
export async function fetchMe(): Promise<User | null> {
  const res = await fetch("/auth/me", { credentials: "include" });
  if (!res.ok) return null;
  const data = await res.json();
  return data.user as User;
}

export async function logout(): Promise<void> {
  await fetch("/auth/logout", { method: "POST", credentials: "include" });
}

// --- Chat streaming --------------------------------------------------------

// POST one turn and consume the Server-Sent Events reply. Because this is a
// POST (EventSource only does GET), we read the response body stream and parse
// the SSE framing ourselves — the mirror image of the server's parser: read
// bytes, buffer across reads, split on the blank line between events, pull out
// `event:` / `data:`. `onToken` fires for each text chunk.
export async function streamChat(
  request: ChatRequest,
  onToken: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(request),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`chat request failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split("\n\n");
    buffer = events.pop() ?? ""; // keep the last, possibly-incomplete event

    for (const chunk of events) {
      let event = "message";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;

      const payload = JSON.parse(data);
      if (event === "token") {
        // Guard on a string so stray empty tokens never append "undefined".
        if (typeof payload.text === "string") onToken(payload.text);
      } else if (event === "error") {
        throw new Error(payload.message ?? "stream error");
      }
      // event === "done" -> nothing to do; the loop ends when the stream closes.
    }
  }
}
