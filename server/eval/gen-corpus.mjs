// Generates the synthetic recall corpus spanning 2026-07-09 .. 2026-11-12.
// Output: <out>/notes/*.md  and  <out>/claude-export.json
// Deterministic (no RNG) so re-running is stable and re-ingest stays idempotent.
//
//   node eval/gen-corpus.mjs eval/corpus
//
// The corpus is built to make the retrieval ablation discriminating, not just
// to be answerable. Beyond one planted answer per golden question it adds:
//   - near-miss `port` decoys  -> lexical can rank a wrong turn first
//   - an on-call rotation phrased identically across weeks -> only the time
//     filter disambiguates "this week" (hybrid beats hybrid_no_time)
// A paraphrase question (built in build-golden.ts) exercises vector over lexical.

import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

const OUT = process.argv[2];
if (!OUT) {
  console.error("usage: node gen-corpus.mjs <out-dir>");
  process.exit(1);
}
const NOTES = join(OUT, "notes");

const PEOPLE = ["Priya", "Luke", "Dana", "Marco", "me"];

// ---------------------------------------------------------------------------
// Planted answers — one per answerable golden question. The answer to each
// question lives only here. (Quantum teleportation is left unanswerable.)
// ---------------------------------------------------------------------------
const PLANTED_NOTES = [
  {
    date: "2026-07-21",
    file: "2026-07-21-infra-sync.md",
    title: "Infra sync — local dev setup",
    heading: "Dev server",
    body: "Settled the local setup: the dev server runs on port 8787, Postgres on 5432 in Docker. Everyone standardises on `make dev` so the ports don't drift between machines.",
  },
  {
    date: "2026-08-12",
    file: "2026-08-12-migration-kickoff.md",
    title: "Migration kickoff",
    heading: "Naming",
    body: "We kicked off the Postgres-to-pgvector migration today. The migration project is codenamed Seahorse — all the tracking tickets go under the SEAHORSE epic.",
  },
  {
    date: "2026-08-26",
    file: "2026-08-26-ownership.md",
    title: "Workstream ownership",
    heading: "Embeddings",
    body: "Locked in ownership for the quarter. Priya owns the embeddings work — provider abstraction, the Voyage integration, and backfill. Dana takes lexical search.",
  },
  {
    date: "2026-09-23",
    file: "2026-09-23-launch-planning.md",
    title: "Launch planning",
    heading: "Date",
    body: "After the scope review we agreed to move the public launch from January 15 to March 3, 2027. The extra six weeks go to the eval harness and latency work.",
  },
  {
    date: "2026-10-02",
    file: "2026-10-02-ingest-design.md",
    title: "Ingest design review",
    heading: "Dedup",
    body: "Decided how to handle duplicate ingestion: a per-user content_hash column plus INSERT ... ON CONFLICT DO NOTHING, so re-running ingest is an idempotent no-op instead of creating duplicate turns.",
  },
  {
    date: "2026-10-15",
    file: "2026-10-15-retrieval-design.md",
    title: "Retrieval design",
    heading: "Fusion",
    body: "Chose reciprocal rank fusion (RRF, k=60) to combine the lexical and vector result lists. The reasoning: RRF fuses by rank, so we don't have to calibrate the two scoring scales against each other, and a turn that both methods like floats to the top.",
  },
  {
    date: "2026-11-10",
    file: "2026-11-10-weekly-sync.md",
    title: "Weekly sync",
    heading: "Budget",
    body: "On the Q3 budget: we decided last week's leftover carries forward — the roughly $48k of unspent Q3 budget rolls into Q4 tooling and embedding API credits rather than being returned.",
  },
];

// Near-miss decoys for the port question: real wrong answers that also contain
// "port" + a number, so the lexical arm has something to rank ahead of 8787.
const PORT_DECOYS = [
  {
    date: "2026-07-14",
    file: "2026-07-14-ports.md",
    title: "Port allocations",
    heading: "Prototype",
    body: "Reminder on ports: the old prototype used port 3000, which clashed with the web app, so we retired that port.",
  },
  {
    date: "2026-07-28",
    file: "2026-07-28-staging.md",
    title: "Staging setup",
    heading: "Ports",
    body: "The staging server listens on port 9090, and the metrics/health endpoint is exposed on port 9100 across every environment.",
  },
];

// On-call rotation: phrased identically every week, so the words don't tell you
// WHICH week — only the date does. "Who is on call this week?" (filtered to the
// current week) must land on Marco; the earlier weeks are out-of-window decoys.
const ON_CALL = [
  { date: "2026-08-19", person: "Priya" },
  { date: "2026-09-16", person: "Dana" },
  // Heavier term frequency so this OLD week outranks the current one on content
  // alone — without the time filter it wins top-1, which is the whole point.
  {
    date: "2026-10-21",
    person: "Luke",
    body: "Luke is on call this week. Luke is the primary on call contact; route every on call page and on call escalation to Luke while he is on call.",
  },
  { date: "2026-11-11", person: "Marco" }, // in-window for "this week" @ 2026-11-16
];

const PLANTED_CHAT = {
  convId: "conv-hiring-2026-09-09",
  date: "2026-09-09",
  title: "Hiring level discussion",
  text: "Summarising the thread: Luke said we should hire at the senior level (L5), not mid, because a senior engineer can own the retrieval work end to end and we'll move faster even though it costs more up front.",
};

// ---------------------------------------------------------------------------
// Filler content so planted answers sit among plausible neighbours and decoys.
// ---------------------------------------------------------------------------
const DECOYS = [
  "Revisited the Q2 budget retro — we underspent on compute but overspent on contractor hours; noted for next planning round.",
  "There was a suggestion to codename the eval work 'Lighthouse' but we didn't adopt it; only the migration got a codename.",
  "Marco asked whether we should hire a contractor for the frontend; parked that, it's separate from the retrieval hire.",
  "Earlier draft had the launch pencilled for February but that was never agreed — Feb was only ever a placeholder.",
  "Debated whether to return unused budget each quarter; historically we have, but it's revisited every time.",
];

const STANDUP_LINES = [
  "Shipped the provider abstraction so Anthropic is the default and the fake provider backs the tests.",
  "Vector index is up: HNSW over cosine distance, 1024-dim to match Voyage voyage-3.",
  "Lexical side now uses websearch_to_tsquery with a GIN index on the generated tsvector.",
  "Spent the morning on the SSE stream parser; token-by-token rendering works end to end now.",
  "Wired the time filter into both searches — ts >= start AND ts < end, start inclusive, end exclusive.",
  "Added the widen-on-empty fallback: if a filtered search returns nothing we double the window once and retry.",
  "Query parser prompt is in: a small model returns JSON with time_range, people, surfaces, key_terms.",
  "Instrumented per-stage latency; p50/p95 recorded for parse, embed, search, fuse, answer.",
  "Backfill command embeds any turns that have no vector yet, in batches of 64.",
  "Fact extraction now stores a subject alongside the statement so we can supersede instead of delete.",
  "Debugged a timestamp bug — node-postgres hands back Date objects, not strings, broke a .slice call.",
  "Hardened the Claude export parser; it tolerates both chat_messages and messages, and content arrays.",
  "Added recall scoring to the eval and the four ablations: vector, lexical, hybrid, hybrid_no_time.",
  "Cleaned up the system-prompt assembly so retrieved turns are rendered with id, date, title, speaker.",
  "Looked at cost: Voyage free tier is 3 requests a minute, so ingest batches to stay under it.",
];

const BLOCKER_LINES = [
  "Blocked briefly on a role CHECK constraint rejecting 'notes' turns; widened it.",
  "Flaky embed calls when we fire too fast — rate limit. Added spacing between batches.",
  "HNSW recall felt low until we raised ef_search; noting to revisit before launch.",
  "Still no good golden set with real expected ids; that's the gap before the eval means anything.",
  "Open question: should ingest chunk at 800 tokens or go smaller for notes? Left at ~800 for now.",
];

function pick(arr, i) {
  return arr[i % arr.length];
}

function fillerSections(weekIdx) {
  const n = 3 + (weekIdx % 2); // 3 or 4
  const out = [];
  for (let k = 0; k < n; k++) {
    const who = pick(PEOPLE, weekIdx + k);
    const kind = (weekIdx + k) % 3;
    let line;
    if (kind === 0) line = pick(STANDUP_LINES, weekIdx * 2 + k);
    else if (kind === 1) line = pick(BLOCKER_LINES, weekIdx + k);
    else line = pick(DECOYS, weekIdx + k);
    const heading = kind === 1 ? "Blockers" : kind === 2 ? "Parked" : "Progress";
    out.push({ heading: `${heading} — ${who}`, body: line });
  }
  return out;
}

const WEEKLY_DATES = [];
{
  const d = new Date("2026-07-09T00:00:00Z");
  const end = new Date("2026-11-12T00:00:00Z");
  while (d <= end) {
    WEEKLY_DATES.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 7);
  }
}

async function writeNotes() {
  await rm(NOTES, { recursive: true, force: true });
  await mkdir(NOTES, { recursive: true });
  let fileCount = 0;
  let turnCount = 0;

  const writeFileWithSections = async (fname, title, sections) => {
    const lines = [`# ${title}`, ""];
    for (const s of sections) {
      lines.push(`## ${s.heading}`, "", s.body, "");
      turnCount++;
    }
    await writeFile(join(NOTES, fname), lines.join("\n"), "utf8");
    fileCount++;
  };

  // Weekly sync files.
  for (let w = 0; w < WEEKLY_DATES.length; w++) {
    const date = WEEKLY_DATES[w];
    await writeFileWithSections(`${date}-weekly.md`, `Weekly sync — ${date}`, fillerSections(w));
  }

  // Planted note files (distinct dates, each with a filler section first).
  const planted = [...PLANTED_NOTES, ...PORT_DECOYS];
  for (let i = 0; i < planted.length; i++) {
    const p = planted[i];
    const f = fillerSections(100 + i)[0];
    await writeFileWithSections(p.file, `${p.title} — ${p.date}`, [
      { heading: f.heading, body: f.body },
      { heading: p.heading, body: p.body },
    ]);
  }

  // On-call rotation files — identical phrasing, one per week.
  for (const o of ON_CALL) {
    await writeFileWithSections(`${o.date}-oncall.md`, `On-call handover — ${o.date}`, [
      {
        heading: "On call",
        body: o.body ?? `${o.person} is on call this week; page them first for anything urgent, then escalate to the lead.`,
      },
    ]);
  }

  return { fileCount, turnCount };
}

// ---------------------------------------------------------------------------
// Claude export JSON — dated conversations, one carrying the Luke/hiring answer.
// ---------------------------------------------------------------------------
const CHAT_TOPICS = [
  {
    id: "conv-rrf-2026-10-16",
    date: "2026-10-16",
    title: "Why RRF over weighted sum",
    msgs: [
      ["user", "Remind me why we went with rank fusion instead of just adding the scores?"],
      ["assistant", "Because the lexical ts_rank_cd scores and the vector cosine scores live on totally different scales, so a weighted sum needs calibration that drifts. RRF only looks at rank position, so it sidesteps that."],
      ["user", "And k=60?"],
      ["assistant", "k=60 is the common default from the original RRF paper; it damps the contribution of low-ranked items without tuning per query."],
    ],
  },
  {
    id: "conv-ingest-2026-10-03",
    date: "2026-10-03",
    title: "Ingest idempotency",
    msgs: [
      ["user", "If I run ingest twice does it double everything?"],
      ["assistant", "No — each turn gets a content_hash and the insert is ON CONFLICT DO NOTHING, so the second run reports everything as skipped."],
      ["user", "What about editing a note then re-ingesting?"],
      ["assistant", "Edited text hashes differently, so it comes in as a new turn; the old one stays unless you clear it. We don't diff-update in place yet."],
    ],
  },
  {
    id: PLANTED_CHAT.convId,
    date: PLANTED_CHAT.date,
    title: PLANTED_CHAT.title,
    msgs: [
      ["user", "Can you catch me up on where the hiring thread landed?"],
      ["assistant", PLANTED_CHAT.text],
      ["user", "Did anyone push back?"],
      ["assistant", "Dana worried about budget, but the group leaned toward Luke's view given how central retrieval is this quarter."],
    ],
  },
  {
    id: "conv-latency-2026-11-04",
    date: "2026-11-04",
    title: "Latency budget",
    msgs: [
      ["user", "Where is the time going on a query?"],
      ["assistant", "Mostly the answer generation — parse and embed are tens of milliseconds, search and fuse are small, and the LLM answer dominates TTFT because retrieved turns go in the system prompt."],
      ["user", "So we can't stream before retrieving?"],
      ["assistant", "Right, there's a data dependency: the facts have to be in the prompt before the first token, so retrieval blocks generation."],
    ],
  },
  {
    id: "conv-voice-2026-11-11",
    date: "2026-11-11",
    title: "Voice surface idea",
    msgs: [
      ["user", "Could we ingest voice memos as a surface too?"],
      ["assistant", "Yes — surface is already a filter dimension ('text' | 'voice' | 'notes'), so transcribed voice memos would ingest as surface=voice and be filterable."],
    ],
  },
  {
    id: "conv-budget-2026-07-15",
    date: "2026-07-15",
    title: "Early budget chat",
    msgs: [
      ["user", "What's our compute budget looking like for Q3?"],
      ["assistant", "Q3 is mostly embedding API credits and a small Postgres host; the number firmed up later, but early Q3 it was comfortable."],
    ],
  },
];

function toExport() {
  return CHAT_TOPICS.map((c) => ({
    uuid: c.id,
    name: c.title,
    created_at: `${c.date}T09:00:00Z`,
    chat_messages: c.msgs.map(([sender, text], i) => ({
      sender,
      text,
      created_at: `${c.date}T09:0${Math.min(i, 9)}:00Z`,
    })),
  }));
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const n = await writeNotes();
  const exportObj = toExport();
  await writeFile(join(OUT, "claude-export.json"), JSON.stringify(exportObj, null, 2), "utf8");
  const chatTurns = CHAT_TOPICS.reduce((s, c) => s + c.msgs.length, 0);
  console.log(`notes: ${n.fileCount} files, ${n.turnCount} sections (turns)`);
  console.log(`export: ${exportObj.length} conversations, ${chatTurns} messages (turns)`);
  console.log(`total turns ~= ${n.turnCount + chatTurns}`);
  console.log(`date span: ${WEEKLY_DATES[0]} .. 2026-11-12`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
