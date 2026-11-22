// pm2 process definitions for `make up`. Both apps do their own file watching
// (tsx watch / vite), so pm2's watcher stays off.
module.exports = {
  apps: [
    {
      name: "api",
      cwd: "./server",
      script: "npx",
      args: "tsx watch --inspect --env-file-if-exists=../.env src/index.ts",
      autorestart: false,
      interpreter: "none", // npx/npm are shell shims (esp. under mise), not JS
    },
    {
      name: "web",
      cwd: "./web",
      script: "npm",
      args: "run dev",
      autorestart: false,
      interpreter: "none", // npx/npm are shell shims (esp. under mise), not JS
    },
  ],
};
