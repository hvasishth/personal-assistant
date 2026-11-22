// Clears a user's entire corpus (conversations cascade to messages) so the
// synthetic eval set can be re-ingested from scratch — a reproducible fixture,
// not an accreting pile. Scoped to one user; never touches other accounts.
//
//   tsx --env-file-if-exists=../.env eval/reset-eval-user.ts [--user eval@local]

import { loadConfig } from "../src/config";
import { createPool } from "../src/db";
import { getOrCreateCliUser } from "../src/recall/repo";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const i = process.argv.indexOf("--user");
  const email = i !== -1 ? process.argv[i + 1]! : "eval@local";
  try {
    const userId = await getOrCreateCliUser(pool, email);
    const { rowCount } = await pool.query(
      `DELETE FROM conversations WHERE user_id = $1`,
      [userId],
    );
    console.log(`reset ${email}: deleted ${rowCount ?? 0} conversations (messages cascade)`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
