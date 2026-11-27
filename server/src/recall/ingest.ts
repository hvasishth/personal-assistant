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
  embeddingProvider: EmbeddingProvider;
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
  const parsedConversations = await parseNotesFolder(dirPath);
  return store(deps, userId, parsedConversations, "meeting_notes");
}

// -------------------------------------------------------------------------
// Storage: deterministic ids, chunking, dedup, batch embed, insert
// -------------------------------------------------------------------------

async function store(
  deps: IngestDeps,
  userId: string,
  parsedConversations: ParsedConversation[],
  source: string,
): Promise<IngestResult> {
  // Flatten into turn records first (so embedding batches across conversations),
  // assigning a deterministic uuid and a content hash to each.
  interface TurnRecord {
    id: string;
    conversationId: string;
    role: string;
    content: string;
    seq: number;
    surface: string;
    ts: string;
    contentHash: string;
  }
  const records: TurnRecord[] = [];
  let conversationCount = 0;

  for (const conv of parsedConversations) {
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
    let batchEmbeddings: (number[] | null)[];
    try {
      batchEmbeddings = await deps.embeddingProvider.embed(batch.map((r) => r.content));
    } catch (err) {
      log.warn("embed batch failed; inserting without vectors:", err);
      batchEmbeddings = batch.map(() => null);
    }
    for (let j = 0; j < batch.length; j++) {
      const r = batch[j]!;
      const embedding = batchEmbeddings[j] ?? null;
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
  const rawConversations = Array.isArray(data)
    ? data
    : isObj(data) && Array.isArray(data.conversations)
      ? data.conversations
      : [];
  const out: ParsedConversation[] = [];
  for (const rawConversation of rawConversations) {
    if (!isObj(rawConversation)) continue;
    const externalId =
      str(rawConversation.uuid) ?? str(rawConversation.id) ?? str(rawConversation.conversation_id) ?? cryptoRandom();
    const title = str(rawConversation.name) ?? str(rawConversation.title) ?? null;
    const startedAt = isoOrNull(rawConversation.created_at) ?? isoOrNull(rawConversation.created);
    const rawMessages = Array.isArray(rawConversation.chat_messages)
      ? rawConversation.chat_messages
      : Array.isArray(rawConversation.messages)
        ? rawConversation.messages
        : [];
    const turns: ParsedTurn[] = [];
    for (const rawMessage of rawMessages) {
      if (!isObj(rawMessage)) continue;
      const text = messageText(rawMessage);
      if (!text) continue;
      const sender = str(rawMessage.sender) ?? str(rawMessage.role) ?? "user";
      const role = sender === "assistant" ? "assistant" : "user";
      turns.push({
        role,
        content: text,
        surface: "text",
        ts: isoOrNull(rawMessage.created_at) ?? startedAt ?? new Date().toISOString(),
      });
    }
    if (turns.length > 0) out.push({ externalId, title, startedAt, turns });
  }
  return out;
}

// A message's text may be a `text` field or an array of content blocks.
function messageText(rawMessage: Record<string, unknown>): string | null {
  if (typeof rawMessage.text === "string" && rawMessage.text.trim()) return rawMessage.text.trim();
  if (Array.isArray(rawMessage.content)) {
    const parts = rawMessage.content
      .map((p) => (isObj(p) && typeof p.text === "string" ? p.text : ""))
      .filter((s) => s.length > 0);
    if (parts.length > 0) return parts.join("\n").trim();
  }
  if (typeof rawMessage.content === "string" && rawMessage.content.trim()) return rawMessage.content.trim();
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
  const dateMatch = name.match(/(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) return `${dateMatch[1]}T00:00:00Z`;
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
  const paragraphs = text.split(/\n\s*\n/);
  const pieces: string[] = [];
  let pending = "";
  for (const paragraph of paragraphs) {
    if (pending.length + paragraph.length + 2 > MAX_TURN_CHARS && pending.length > 0) {
      pieces.push(pending);
      pending = "";
    }
    pending = pending ? `${pending}\n\n${paragraph}` : paragraph;
    // A single paragraph over the limit: hard-split it.
    while (pending.length > MAX_TURN_CHARS) {
      pieces.push(pending.slice(0, MAX_TURN_CHARS));
      pending = pending.slice(MAX_TURN_CHARS);
    }
  }
  if (pending) pieces.push(pending);
  return pieces;
}

// Content hash scoped to the user, so idempotent dedup is per-user: the same
// user re-ingesting the same text is a no-op, while two users may hold identical
// text. (Duplicate content within one user's corpus is intentionally collapsed.)
function hashContent(userId: string, content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(`${userId}\n${normalized}`).digest("hex");
}

// A deterministic RFC-4122 v5-style uuid from a name, so re-ingest produces the
// same ids (and thus hits the PK on conflict).
function uuidFrom(name: string): string {
  const digest = createHash("sha1").update(name).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC-4122 variant
  const hex = bytes.toString("hex");
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
