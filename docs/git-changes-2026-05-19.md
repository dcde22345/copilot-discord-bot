# Git Changes Summary - 2026-05-19

This document summarizes the working tree state before this report file was added. Sensitive values from `.env`, `.mcp.json`, `.codex/config.toml`, and `opencode.json` are intentionally not included.

## Git Status

- Branch: `main`
- Remote state: `main` is ahead of `origin/main` by 1 commit.
- Staged changes: none.
- Unstaged tracked changes: 37 files, `972 insertions`, `153 deletions`.
- Untracked items: local Codex/GitHub config files, MCP/OpenCode config files, generated `dist` outputs, new source files, and installed dependency directories under `node_modules`.

## Main Functional Changes

- Adds RAG-related configuration through `.env.example` and `src/config.ts`: `OPENAI_API_KEY`, `EMBEDDING_MODEL`, and `RAG_TOP_K`.
- Adds OpenAI embedding support through `src/services/EmbeddingService.ts`, including a small in-memory cache and graceful disablement when no API key is configured.
- Adds conversation unit modeling in `src/models/ConversationUnit.ts`.
- Extends `SessionRuntimeManager` to search related conversation history before a turn, inject related context into the Copilot runtime, and save completed user/assistant exchanges as embedding-backed conversation units.
- Updates `CopilotRuntime` to accept optional RAG context, record completed conversations, and merge project-level `.mcp.json` MCP servers with per-session MCP configuration.
- Extends MCP local server config with `env` support and expands `${ENV_VAR}` placeholders before passing MCP server configuration to the SDK.
- Adds `src/appConfig.ts` and `config.yml` for app behavior configuration. Current `config.yml` disables mandatory repo selection with `requireRepoSelection: false`.
- Updates Discord routing so mentioning the bot in a normal text channel creates a session thread and forwards the prompt. Inside session threads, plain chat now requires a bot mention, while `cp` commands and approval responses still work without one.
- Adds deferred prompt handling for repo picker flows, so an initial user prompt can run after the repo is selected.

## File Groups

- Source changes: `src/config.ts`, `src/index.ts`, `src/models/SessionConfigState.ts`, `src/services/CopilotRuntime.ts`, `src/services/DiscordBotService.ts`, `src/services/DiscordCommandRouter.ts`, and `src/services/SessionRuntimeManager.ts`.
- New source files: `src/appConfig.ts`, `src/models/ConversationUnit.ts`, and `src/services/EmbeddingService.ts`.
- Dependency changes: `package.json` and `package-lock.json` add `openai`, `sqlite-vec`, and `yaml`.
- Generated output changes: multiple `dist/**` files mirror the TypeScript source changes, including generated files for `appConfig`, `ConversationUnit`, and `EmbeddingService`.
- Local/runtime config changes: `.env` changed locally, `.env.example` adds public placeholders, and new config files exist at `config.yml`, `.mcp.json`, `.codex/config.toml`, and `opencode.json`.
- Additional untracked workflow file: `.github/skills/create-plane-design-doc/SKILL.md`.

## Review Notes

- Do not commit real secrets from `.env`, `.mcp.json`, `.codex/config.toml`, or `opencode.json`. Move tokens to environment variables or rotate them before sharing the repository.
- `node_modules` contains modified and untracked dependency files. If this repository does not intentionally track `node_modules`, leave those files uncommitted and commit only `package.json` plus `package-lock.json`.
- The `dist/**` files appear to be generated build artifacts. Confirm whether this project expects generated output to be committed.
- The RAG flow depends on the existing session store methods used by `SessionRuntimeManager`; run the normal build/test command before committing.
