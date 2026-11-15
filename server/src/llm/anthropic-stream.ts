import type { StreamEvent } from "./types";
import { log } from "../logger";

// ============================================================================
// YOUR PIECE #1 (brief): "Parsing the SSE stream from the LLM API (raw fetch,
// no SDK streaming helpers)."
//
// `body` is the raw response body from `fetch` against Anthropic's streaming
// endpoint. Your job: read the bytes, parse the Server-Sent Events framing,
// interpret Anthropic's event types, and `yield` our normalized StreamEvents.
//
// Nothing else in the codebase is blocked on this — the fetch request, the
// Express SSE route, and the fake provider are all wired already. Implement
// this and real tokens flow from Claude to the browser.
//
// ---------------------------------------------------------------------------
// STEP A — SSE framing (generic, not Anthropic-specific):
//   - Get a reader: `const reader = body.getReader()`, loop `reader.read()`.
//   - Decode Uint8Array chunks to text with a streaming TextDecoder:
//       `new TextDecoder().decode(value, { stream: true })`.
//   - BUFFER across reads: a line or event can be split across two chunks.
//   - Events are separated by a BLANK LINE ("\n\n"). Split the buffer on that.
//   - Within an event, lines look like `event: <name>` and `data: <payload>`.
//   - Strip a single leading space after the colon. Ignore lines starting ":".
//   - Multiple `data:` lines in one event join with "\n".
//
// STEP B — interpret Anthropic's events. Each `data:` payload is JSON. The
// sequence for a text response is roughly:
//   message_start
//   content_block_start   { content_block: { type: "text" } }
//   content_block_delta   { delta: { type: "text_delta", text: "Hel" } }   <- the tokens
//   content_block_delta   { delta: { type: "text_delta", text: "lo" } }
//   ping                  (keep-alive; ignore)
//   content_block_stop
//   message_delta         { delta: { stop_reason }, usage: { output_tokens } }
//   message_stop          <- end of stream
//   (on failure)  error   { error: { message } }
//
// Map them to StreamEvents:
//   content_block_delta + text_delta  ->  { type: "text", text }
//   message_stop                       ->  { type: "done" }  (then return)
//   error                              ->  { type: "error", message }
//
// Tip: before writing this, run `./scripts/raw-stream.sh` to watch the real
// bytes come off the wire, and sketch your approach. Then compare.
// ============================================================================
export async function* parseAnthropicStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n\n');
    buffer = lines.pop() ?? '';   // last piece may be a half-received event
    for (const line of lines) {
      if (line.startsWith('event:')) {
        const [eventLine, data] = line.split('data:');
        const event = eventLine?.split(':')?.[1]?.trim();
        const partToSendToClient = data? JSON.parse(data)?.delta?.text : '';
        log.trace('anthropic sse block:', JSON.stringify(line));
        if (event === 'message_start') {
          continue;
        } else if (event === 'content_block_start') {
          continue;
        } else if (event === 'content_block_delta') {
          yield { type: 'text', text: partToSendToClient };
        } else if (event === 'ping') {
          continue;
        } else if (event === 'content_block_stop') {
          continue;
        } else if (event === 'message_stop') {
          yield { type: 'done' };
        } else if (event === 'error') {
          yield { type: 'error', message: data? JSON.parse(data)?.error?.message ?? '': '' };
        }
      }
    }
  }
}

