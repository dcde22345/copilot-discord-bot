# Copilot Discord Bot — GitHub Copilot on the go

Use GitHub Copilot from your phone by chatting in Discord.

You run this bot on a server/PC (home lab, VM, cloud box) that has:

- GitHub Copilot CLI + authentication
- Your repos under a configured root folder (`Bot:ReposRoot`)

Then you use Discord mobile to:

- Create a session (Discord thread)
- Pick a repo with reactions (1️⃣..🔟)
- Approve/deny tool actions with reactions (👍/👎)
- Watch a single “CLI panel” status message update in-place

## Demo

![New session](media/new-session.png)

![New message](media/new-message.png)

![Permission approval](media/permission-approval.png)

Video: [media/copilot-discord-bot.mp4](media/copilot-discord-bot.mp4)

## Highlights

- **Emoji-first UX**: threads + reactions work great on mobile.
- **Single status panel**: no spam; one message edits in-place.
- **Repo sandbox**: agent work is scoped under `Bot:ReposRoot`.
- **Interactive approvals**: prompts show what’s being approved.

## Security model (read this)

- Set `Bot:OwnerDiscordUserId` (recommended). If set, the bot ignores everyone else.
- Keep `Bot:ReposRoot` tight. The bot should only see repos you want it to touch.
- Keep approvals on (`cp approve ask`) unless you fully trust your tools + repos.
- Optional: `Bot:AutoApproveReadPermissions=true` reduces prompt spam for read-only actions.

## Prereqs

- .NET 10 (SDK or runtime)
  - Verify: `dotnet --version` should be `10.x`
- GitHub Copilot CLI installed on the server and authenticated
  - Verify: `copilot --version` (should not prompt)
  - Authenticate (interactive): run `copilot` once and complete sign-in
  - Authenticate (service-friendly): set `GH_TOKEN` / `COPILOT_GITHUB_TOKEN`
- A Discord application + bot token

## Create a Discord bot + invite it

In the Discord Developer Portal:

1. Create an Application
2. Create a Bot and copy the token
3. Enable **Privileged Gateway Intents**:
   - Message Content Intent (required)
4. Invite the bot to your server (OAuth2 → URL Generator):
   - Scopes: `bot`
   - Permissions (minimum recommended):
     - View Channels
     - Send Messages
     - Read Message History
     - Create Public Threads
     - Send Messages in Threads
     - Add Reactions
     - Use External Emojis (optional)

## Configure

You can put defaults in [src/CopilotDiscordBot/appsettings.json](src/CopilotDiscordBot/appsettings.json), but for production it’s recommended to use **environment variables** (especially when running as a service).

Required settings:

- `Bot:DiscordBotToken` – your bot token
- `Bot:OwnerDiscordUserId` – your Discord user id (recommended)
- `Bot:ReposRoot` – root folder containing repos (example: `e:\\Git`)

Environment variable equivalents:

- `Bot__DiscordBotToken`
- `Bot__OwnerDiscordUserId`
- `Bot__ReposRoot`
- `Bot__DataDir` (recommended to set to an absolute path when running as a service)

Dev-friendly option (user-secrets), from repo root:

- `dotnet user-secrets set "Bot:DiscordBotToken" "YOUR_TOKEN" --project src/CopilotDiscordBot/CopilotDiscordBot.csproj`
- `dotnet user-secrets set "Bot:OwnerDiscordUserId" "123456789012345678" --project src/CopilotDiscordBot/CopilotDiscordBot.csproj`
- `dotnet user-secrets set "Bot:ReposRoot" "e:\\Git" --project src/CopilotDiscordBot/CopilotDiscordBot.csproj`

## Run (dev)

From repo root:

- `dotnet run -c Release --project src/CopilotDiscordBot/CopilotDiscordBot.csproj`

Health endpoint:

- `http://localhost:5000/health`

## Install as a background service (recommended)

These scripts publish the app, set environment variables, and register an always-on service.

### Windows (Windows Service)

Run from an **elevated PowerShell**:

- `powershell -ExecutionPolicy Bypass -File .\\scripts\\install-service-windows.ps1`

Common options:

- `-ReposRoot "E:\\Git"`
- `-OwnerDiscordUserId 123456789012345678`
- `-GhToken "..."` (recommended for services)
- `-CopilotCliPath "C:\\Path\\to\\copilot.exe"`

Uninstall:

- `powershell -ExecutionPolicy Bypass -File .\\scripts\\uninstall-service-windows.ps1`

### Linux (systemd)

Make scripts executable and run with sudo:

- `chmod +x scripts/*.sh`
- `sudo ./scripts/install-service-linux.sh --user <username> --repos-root /path/to/repos`

The installer writes an env file at `/etc/copilot-discord-bot.env` (mode 600) and creates a systemd unit.

Uninstall:

- `sudo ./scripts/uninstall-service-linux.sh --remove-env`

## Use it (emoji-first)

### Create a session

In any normal text channel:

- `cp new my-session`

The bot creates a **thread** (that thread is the session) and posts a repo picker.

### Pick a repo

In the session thread:

- React with **1️⃣..🔟** on the repo picker message.

Fallback: `cp repo <path>`

### Chat

Just send normal messages in the thread.

You’ll see a single status panel updated in-place (state/repo/model/doing).

### Change model

In the session thread:

- `cp model` (shows current)
- `cp model gpt-5.2` (sets for this session)

### Approve/Deny tool actions

When Copilot requests permission, the bot posts a prompt message.

- React **👍** to approve
- React **👎** to deny

## Troubleshooting

### "StreamJsonRpc.ConnectionLostException" on first message

This usually means the `copilot` process exited immediately (often because PATH resolved to a VS Code shim that prints an interactive install prompt).

- Run `where copilot` (Windows) and verify it points to the winget-installed `copilot.exe`
- Run `copilot --version` in the same shell you launch the bot from
- If it prompts to install/reinstall, restart your terminal (PATH update) and try again
- If it still points to the shim, set `Bot:CopilotCliPath` to the full `copilot.exe` path

### Permission prompt too vague

The Copilot SDK is preview and permission payload fields can vary. You can temporarily enable:

- `Bot:DebugPermissionPayload=true`

This adds a redacted debug panel to permission prompts.

### Auto-approve policy (per session)

- `cp approve ask` (recommended)
- `cp approve always`

### MCP server example

Enable the GitHub MCP server for a session:

`cp config set {"model":"gpt-5.2","mcpServers":{"github":{"type":"http","url":"https://api.githubcopilot.com/mcp/","tools":["*"]}}}`
