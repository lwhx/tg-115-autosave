# TG 115 Autosave

Dockerized Telegram Bot service for watching 115 share links, saving them to your 115 drive, and doing basic post-save cleanup. This directory is a standalone project and can be moved out of the BoxPlayer repository.

## Quick Start

```bash
cd tg-115-autosave
copy .env.example .env
# edit ADMIN_PASSWORD in .env
docker compose up -d --build
```

Open `http://localhost:8715`, sign in with `ADMIN_PASSWORD`, then configure:

- `115 Cookie`: used by `webapi.115.com/share/snap` and `share/receive` for share save.
- `115 OAuth`: use the Web UI QR login; used for scanning, renaming, and organizing saved files.
- `Telegram Bot Token`: Bot API token from BotFather.
- `监听 Chat ID`: only messages from this chat are processed. Leave empty only for local testing.
- `通知 Chat ID`: chat that receives success/failure notifications.
- `115 目标根目录 CID`: defaults to `0`.

## Behavior

The service extracts links like:

```text
https://115cdn.com/s/swf0k0j3w30?password=h6e7#
```

It creates a target folder like:

```text
TG自动转存/YYYY-MM-DD/<share title> [<task id>-<unique suffix>]
```

Each task keeps its own persistent folder name. Before organizing, the service matches saved files to the share manifest by name, type, and available size/hash information. Filename cleanup preserves file extensions.

Both Telegram messages and channel posts are supported. The bot must have access to the configured chat/channel. Telegram polling runs in the background so it does not block the Web UI or task worker; polling errors appear in the event log. Temporary startup failures retry with exponential backoff, and stopping or replacing the bot cancels pending startup requests and retry waits. Invalid credentials and other permanent Bot API errors require a settings update.

Leaving a configured Cookie or Bot Token blank keeps its current value. Use the explicit clear checkbox to remove a credential. Cookie and OAuth must belong to the same 115 account.

Transient transfer errors wait until the previous request's confirmation window ends before retrying. Partial transfers resubmit only manifest entries still missing from the target folder. Unexpected target content requires manual review. Completion/failure and their notification are saved in one database transaction. Interrupted tasks that have exhausted their attempts become failed and can be retried manually. Each manual retry starts a new notification generation and supersedes unsent messages from the previous run; running tasks cannot be reset mid-execution.

Database errors in task claiming, notification delivery bookkeeping, or lease renewal are logged and handled by the worker loops. A failed lease renewal stops subsequent task operations. Notification delivery uses leases and can retry, so delivery is not guaranteed to be exactly once.

When upgrading, legacy in-progress tasks with saved file IDs resume organization. Tasks without confirmed file IDs restart in a separate folder; existing remote folders are preserved and may contain files from the earlier attempt.

## Persistent Data

All state lives in `./data` when using the included compose file:

- `autosave.db`: settings, tasks, files, events.
- `oauth-store/`: 115 OAuth token store.

OAuth login and refresh writes are serialized per store directory within this process. JSON files are replaced atomically so concurrent readers do not see a partially written token file. Run only one service process against a shared data directory.

Back up this directory before moving the service.
