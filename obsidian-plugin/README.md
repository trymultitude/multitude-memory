# Multitude for Obsidian (beta)

Two-way sync between your Obsidian vault and Multitude memory.

- **Notes out.** Your Markdown notes go to Multitude, where every AI you use there can look them up, and key facts become memories. Only notes that changed are sent (compared by SHA-1 content hash), and notes you delete are removed there too. If most of your notes seem to vanish at once, nothing is deleted and you're asked to check.
- **Memory in.** Your Multitude memory comes back as one note per memory in a `Multitude/Memory` folder, plus a `Multitude/Memory index` note that links them all, so they show in search and in Obsidian's graph. That folder is never sent back.

## How it connects

Only official, local methods: the plugin reads your vault through Obsidian's plugin API and talks to the Multitude server with a key you create in Multitude (Memory, Import, Obsidian, **Create plugin key**). The key can sync notes and read memory, nothing else (no chats, billing or account), and you can revoke it in Connected AIs. It never touches Obsidian Sync or any other credentials. No telemetry.

## Install

Until it's listed in Obsidian's Community plugins:

1. `npm install && npm run build` here, or download `main.js` and `manifest.json` from the Multitude app (Import, Obsidian).
2. Put both files in `<your vault>/.obsidian/plugins/multitude/`.
3. In Obsidian, Settings, Community plugins: turn on **Multitude** and paste your key in its settings.

It syncs a minute after you stop editing, every 15 minutes, and from the ribbon button or the "Sync now" command.

## Server API used

`POST /api/vault/manifest`, `POST /api/vault/push`, `POST /api/vault/digest`, `GET /api/vault/pull`, all with `Authorization: Bearer <key>`.

MIT licensed, like the rest of this repository.
