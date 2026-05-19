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
TG自动转存/YYYY-MM-DD/<share title>
```

Then it saves the shared files into that folder, scans the folder through the OAuth provider, and applies basic filename cleanup.

## Persistent Data

All state lives in `./data` when using the included compose file:

- `autosave.db`: settings, tasks, files, events.
- `oauth-store/`: 115 OAuth token store.

Back up this directory before moving the service.
