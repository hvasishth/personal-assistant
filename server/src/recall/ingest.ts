// The write path (spec): offline ingest of your own history into the turn
// corpus. Everything expensive (chunking, embedding) happens here so a query
// pays none of it. Two sources are supported — a Claude chat export (JSON) and
// a folder of meeting notes — normalised to the same shape and stored the same
// way. Re-ingest is idempotent (content-hash dedup + ON CONFLICT DO NOTHING).

import { readFile, readdir, stat } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { createHash } from "node:crypto";
import type { Pool } from "../db";
import type { EmbeddingProvider } from "../embeddings/types";
import { insertTurn, upsertIngestConversation } from "./repo";
import { log } from "../logger";

const MAX_TURN_CHARS = 3200; // ~800 tokens at ~4 chars/token — the split threshold
const EMBED_BATCH = 64;

export interface IngestDeps {
  pool: Pool;
  embeddings: EmbeddingProvider;
  embeddingModel: string;
}

export interface IngestResult {
  conversations: number;
  inserted: number;
  skipped: number;
}

// Normalised shapes the two parsers produce; storage doesn't care which source.
interface ParsedTurn {
  role: string; // 'user' | 'assistant' | 'notes'
  content: string;
  surface: string; // 'text' | 'notes'
  ts: string; // ISO timestamp
}
interface ParsedConversation {
  externalId: string; // stable id from the source, for deterministic uuids
  title: string | null;
  startedAt: string | null;
  turns: ParsedTurn[];
}

// -------------------------------------------------------------------------
// Public entry points
// -------------------------------------------------------------------------

export async function ingestClaudeExport(
  deps: IngestDeps,
  userId: string,
  filePath: string,
): Promise<IngestResult> {
  const raw = await readFile(filePath, "utf8");
  const parsed = parseClaudeExport(raw);
  return store(deps, userId, parsed, "claude_export");
}

export async function ingestNotesFolder(
  deps: IngestDeps,
  userId: string,
  dirPath: string,
): Promise<IngestResult> {
  const convs = await parseNotesFolder(dirPath);
  return store(deps, userId, convs, "meeting_notes");
}

// -------------------------------------------------------------------------
// Storage: deterministic ids, chunking, dedup, batch embed, insert
// -------------------------------------------------------------------------

async function store(
  deps: IngestDeps,
  userId: string,
  convs: ParsedConversation[],
  source: string,
): Promise<IngestResult> {
  // Flatten into turn records first (so embedding batches across conversations),
  // assigning a deterministic uuid and a content hash to each.
  interface Record {
    id: string;
    conversationId: string;
    role: string;
    content: string;
    seq: number;
    surface: string;
    ts: string;
    contentHash: string;
  }
  const records: Record[] = [];
  let conversationCount = 0;

  for (const conv of convs) {
    const conversationId = uuidFrom(`${source}:${conv.externalId}`);
    await upsertIngestConversation(deps.pool, {
      id: conversationId,
      userId,
      title: conv.title,
      source,
      startedAt: conv.startedAt,
    });
    conversationCount += 1;

    let seq = 0;
    for (const turn of conv.turns) {
      for (const piece of splitLongTurn(turn.content)) {
        const content = piece.trim();
        if (content.length === 0) continue;
        const contentHash = hashContent(userId, content);
        records.push({
          id: uuidFrom(`${source}:${conv.externalId}:${seq}:${contentHash}`),
          conversationId,
          role: turn.role,
          content,
          seq,
          surface: turn.surface,
          ts: turn.ts,
          contentHash,
        });
        seq += 1;
      }
    }
  }

  // Embed in batches, then insert. A failed embed batch degrades to inserting
  // those turns with a null embedding (still lexically searchable).
  let inserted = 0;
  let skipped = 0;
  for (let i = 0; i < records.length; i += EMBED_BATCH) {
    const batch = records.slice(i, i + EMBED_BATCH);
    let vectors: (number[] | null)[];
    try {
      vectors = await deps.embeddings.embed(batch.map((r) => r.content));
    } catch (err) {
      log.warn("embed batch failed; inserting without vectors:", err);
      vectors = batch.map(() => null);
    }
    for (let j = 0; j < batch.length; j++) {
      const r = batch[j]!;
      const embedding = vectors[j] ?? null;
      const didInsert = await insertTurn(deps.pool, {
        id: r.id,
        conversationId: r.conversationId,
        role: r.role,
        content: r.content,
        seq: r.seq,
        surface: r.surface,
        ts: r.ts,
        contentHash: r.contentHash,
        embedding,
        embeddingModel: embedding ? deps.embeddingModel : null,
      });
      if (didInsert) inserted += 1;
      else skipped += 1;
    }
  }

  return { conversations: conversationCount, inserted, skipped };
}

// -------------------------------------------------------------------------
// Parsers
// -------------------------------------------------------------------------

// Claude's export is an array of conversations; message/field names have varied
// across versions, so we read defensively and skip anything unrecognisable.
function parseClaudeExport(raw: string): ParsedConversation[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("claude export is not valid JSON");
  }
  const conversations = Array.isArray(data)
    ? data
    : isObj(data) && Array.isArray(data.conversations)
      ? data.conversations
      : [];
  const out: ParsedConversation[] = [];
  for (const c of conversations) {
    if (!isObj(c)) continue;
    const externalId =
      str(c.uuid) ?? str(c.id) ?? str(c.conversation_id) ?? cryptoRandom();
    const title = str(c.name) ?? str(c.title) ?? null;
    const startedAt = isoOrNull(c.created_at) ?? isoOrNull(c.created);
    const rawMessages = Array.isArray(c.chat_messages)
      ? c.chat_messages
      : Array.isArray(c.messages)
        ? c.messages
        : [];
    const turns: ParsedTurn[] = [];
    for (const m of rawMessages) {
      if (!isObj(m)) continue;
      const text = messageText(m);
      if (!text) continue;
      const sender = str(m.sender) ?? str(m.role) ?? "user";
      const role = sender === "assistant" ? "assistant" : "user";
      turns.push({
        role,
        content: text,
        surface: "text",
        ts: isoOrNull(m.created_at) ?? startedAt ?? new Date().toISOString(),
      });
    }
    if (turns.length > 0) out.push({ externalId, title, startedAt, turns });
  }
  return out;
}

// A message's text may be a `text` field or an array of content blocks.
function messageText(m: Record<string, unknown>): string | null {
  if (typeof m.text === "string" && m.text.trim()) return m.text.trim();
  if (Array.isArray(m.content)) {
    const parts = m.content
      .map((p) => (isObj(p) && typeof p.text === "string" ? p.text : ""))
      .filter((s) => s.length > 0);
    if (parts.length > 0) return parts.join("\n").trim();
  }
  if (typeof m.content === "string" && m.content.trim()) return m.content.trim();
  return null;
}

// Notes: each .md/.txt file is a conversation; each top-level heading section
// (# or ##) is one turn with speaker=notes. The file's date comes from a
// YYYY-MM-DD in its name, else its mtime.
async function parseNotesFolder(dirPath: string): Promise<ParsedConversation[]> {
  const entries = await readdir(dirPath);
  const out: ParsedConversation[] = [];
  for (const name of entries) {
    const ext = extname(name).toLowerCase();
    if (ext !== ".md" && ext !== ".txt") continue;
    const full = join(dirPath, name);
    const text = await readFile(full, "utf8");
    const ts = await fileDate(full, name);
    const sections = splitNoteSections(text);
    const turns: ParsedTurn[] = sections.map((content) => ({
      role: "notes",
      content,
      surface: "notes",
      ts,
    }));
    if (turns.length > 0) {
      out.push({
        externalId: name,
        title: basename(name, ext),
        startedAt: ts,
        turns,
      });
    }
  }
  return out;
}

function splitNoteSections(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const sections: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    const body = current.join("\n").trim();
    if (body) sections.push(body);
    current = [];
  };
  for (const line of lines) {
    if (/^#{1,2}\s/.test(line)) flush();
    current.push(line);
  }
  flush();
  // No headings at all -> the whole file is one section.
  return sections.length > 0 ? sections : [text.trim()].filter((s) => s.length > 0);
}

async function fileDate(fullPath: string, name: string): Promise<string> {
  const m = name.match(/(\d{4}-\d{2}-\d{2})/);
  if (m) return `${m[1]}T00:00:00Z`;
  try {
    const s = await stat(fullPath);
    return s.mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

// Split a turn longer than the threshold at paragraph breaks, so no single
// record is too large to embed usefully. Short turns pass through unchanged.
function splitLongTurn(text: string): string[] {
  if (text.length <= MAX_TURN_CHARS) return [text];
  const paras = text.split(/\n\s*\n/);
  const pieces: string[] = [];
  let buf = "";
  for (const para of paras) {
    if (buf.length + para.length + 2 > MAX_TURN_CHARS && buf.length > 0) {
      pieces.push(buf);
      buf = "";
    }
    buf = buf ? `${buf}\n\n${para}` : para;
    // A single paragraph over the limit: hard-split it.
    while (buf.length > MAX_TURN_CHARS) {
      pieces.push(buf.slice(0, MAX_TURN_CHARS));
      buf = buf.slice(MAX_TURN_CHARS);
    }
  }
  if (buf) pieces.push(buf);
  return pieces;
}

// Content hash scoped to the user, so idempotent dedup is per-user: the same
// user re-ingesting the same text is a no-op, while two users may hold identical
// text. (Duplicate content within one user's corpus is intentionally collapsed.)
function hashContent(userId: string, content: string): string {
  const norm = content.replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(`${userId}\n${norm}`).digest("hex");
}

// A deterministic RFC-4122 v5-style uuid from a name, so re-ingest produces the
// same ids (and thus hits the PK on conflict).
function uuidFrom(name: string): string {
  const h = createHash("sha1").update(name).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC-4122 variant
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function cryptoRandom(): string {
  return createHash("sha1").update(`${Math.random()}:${Date.now()}`).digest("hex");
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function str(x: unknown): string | null {
  return typeof x === "string" && x.length > 0 ? x : null;
}

function isoOrNull(x: unknown): string | null {
  if (typeof x === "string") {
    const d = new Date(x);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof x === "number") {
    const d = new Date(x);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}
