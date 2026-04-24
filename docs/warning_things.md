# Warning Things

- The user explicitly instructed not to stop until the migration is complete, so I proceeded without the interactive approval gates normally required by the Superpowers brainstorming and planning workflows.
- The repository starts on `main`; the user requested a completed commit and no push, so implementation is being done directly on the current branch.
- `codex app-server` is marked experimental by the Codex CLI. I verified the local protocol with `codex app-server generate-ts` and a WebSocket probe before implementation, but future Codex CLI versions may change the protocol.
- The migration changes the user-facing assistant identity from OpenCode to Codex. Existing installed Discord slash commands may need redeploying so `/codex` replaces `/opencode`.
- `npm ci` failed under Node 24.14.1 because `node-pty` attempted a native rebuild and `make` is not installed in the environment. I used `npm ci --ignore-scripts` for test/build tooling; a production install should run lifecycle scripts in an environment with native build tools or compatible prebuilds.
- After removing the OpenCode-only dependencies, `npm install --package-lock-only --ignore-scripts` still reports 7 audit findings (1 moderate, 6 high). I did not run `npm audit fix` because that can make unrelated dependency upgrades outside this migration.
