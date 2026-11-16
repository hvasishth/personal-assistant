import { Router, type Request, type Response } from "express";
import type { Pool } from "../db";
import {
  listConversations,
  findConversation,
  findConversationOwner,
  loadHistory,
} from "../conversations/repo";

// Read endpoints that back the conversation sidebar. Mounted behind requireAuth
// (see app.ts), so req.userId is always set here.
//
//   GET /api/conversations            -> the user's conversations, newest first
//   GET /api/conversations/:id/messages -> one conversation's messages, in order
//
// The messages endpoint is ownership-checked: a conversation that isn't yours
// and one that doesn't exist both return 404, so the endpoint can't be used to
// probe which conversation ids exist.
export function makeConversationsRouter(pool: Pool): Router {
  const router = Router();

  router.get("/", async (req: Request, res: Response): Promise<void> => {
    const userId = req.userId!;
    const conversations = await listConversations(pool, userId);
    res.json({ conversations });
  });

  // One conversation's metadata. The client polls this after the first turn to
  // pick up the asynchronously-generated title. Ownership-checked: not-yours
  // and missing both return 404.
  router.get("/:id", async (req: Request, res: Response): Promise<void> => {
    const userId = req.userId!;
    const id = req.params.id;
    if (typeof id !== "string") {
      res.status(400).json({ error: "missing conversation id" });
      return;
    }

    const conv = await findConversation(pool, id);
    if (!conv || conv.user_id !== userId) {
      res.status(404).json({ error: "conversation not found" });
      return;
    }

    res.json({
      conversation: {
        id: conv.id,
        title: conv.title,
        created_at: conv.created_at,
        updated_at: conv.updated_at,
      },
    });
  });

  router.get(
    "/:id/messages",
    async (req: Request, res: Response): Promise<void> => {
      const userId = req.userId!;
      const conversationId = req.params.id;
      if (typeof conversationId !== "string") {
        res.status(400).json({ error: "missing conversation id" });
        return;
      }

      const ownerId = await findConversationOwner(pool, conversationId);
      if (ownerId !== userId) {
        // Covers both "doesn't exist" and "not yours" — same response, no oracle.
        res.status(404).json({ error: "conversation not found" });
        return;
      }

      const messages = await loadHistory(pool, conversationId);
      res.json({
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          status: m.status,
        })),
      });
    },
  );

  return router;
}
