// Multitude for Obsidian: two-way sync between your vault and Multitude memory.
//
// - Your notes go to Multitude, so every AI you use there can look them up, and key facts become memories.
//   Only notes that changed are sent (by content hash), and notes you delete are removed there too.
// - Your Multitude memory comes back as Markdown in a "Multitude" folder, linked from one index note,
//   so it shows up in search and in Obsidian's own graph. That folder is never sent back.
//
// It talks only to the Multitude server you set, with a key you created in Multitude (Import > Obsidian).
// No telemetry. Open source under MIT.
import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, normalizePath, requestUrl, debounce } from "obsidian";

interface Settings {
  server: string;
  ws: string;
  key: string;
  scope: "team" | "me";
  folder: string;
  pull: boolean;
  everyMinutes: number;
  exclude: string;
  cursor: number;
  files: Record<string, string>; // memory id -> file path
  lastSync: number;
}
const DEFAULTS: Settings = { server: "https://app.trymultitude.com", ws: "", key: "", scope: "team", folder: "Multitude", pull: true, everyMinutes: 15, exclude: "", cursor: 0, files: {}, lastSync: 0 };
const MAX_BODY = 20_000;

export default class MultitudePlugin extends Plugin {
  settings: Settings = { ...DEFAULTS };
  status!: HTMLElement;
  busy = false;
  timer: number | null = null;

  async onload() {
    this.settings = { ...DEFAULTS, ...(await this.loadData()) };
    this.status = this.addStatusBarItem();
    this.paint();
    this.addRibbonIcon("refresh-cw", "Sync with Multitude", () => this.sync(true));
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.sync(true) });
    this.addCommand({ id: "pull-memory", name: "Refresh memory folder from scratch", callback: async () => { this.settings.cursor = 0; await this.saveData(this.settings); await this.sync(true); } });
    this.addSettingTab(new MultitudeSettings(this.app, this));
    // Edits are batched: one sync a minute after you stop typing.
    const soon = debounce(() => this.sync(false), 60_000, true);
    const mine = (f: { path: string }) => f instanceof TFile && f.extension === "md" && !this.skip(f.path);
    this.registerEvent(this.app.vault.on("modify", (f) => mine(f) && soon()));
    this.registerEvent(this.app.vault.on("create", (f) => mine(f) && soon()));
    this.registerEvent(this.app.vault.on("delete", (f) => mine(f) && soon()));
    this.registerEvent(this.app.vault.on("rename", (f) => mine(f) && soon()));
    this.app.workspace.onLayoutReady(() => { this.schedule(); if (this.ready()) window.setTimeout(() => this.sync(false), 5000); });
  }
  onunload() { if (this.timer) window.clearInterval(this.timer); }

  schedule() {
    if (this.timer) window.clearInterval(this.timer);
    const m = Math.max(5, Number(this.settings.everyMinutes) || 15);
    this.timer = window.setInterval(() => this.sync(false), m * 60_000);
    this.registerInterval(this.timer);
  }
  ready() { return !!(this.settings.server && this.settings.ws && this.settings.key); }
  skip(path: string) {
    const f = normalizePath(this.settings.folder || "Multitude") + "/";
    if (path.startsWith(f) || path === f.slice(0, -1) + ".md") return true;
    if (/(^|\/)(\.trash|\.obsidian)\//.test(path)) return true;
    return this.settings.exclude.split(",").map((x) => x.trim()).filter(Boolean).some((x) => path.startsWith(normalizePath(x) + "/"));
  }
  paint(text?: string) {
    const s = this.settings;
    this.status.setText(text ?? (!this.ready() ? "Multitude: not set up" : s.lastSync ? `Multitude: synced ${ago(s.lastSync)}` : "Multitude: ready"));
  }

  async api(path: string, body?: unknown) {
    const r = await requestUrl({
      url: this.settings.server.replace(/\/+$/, "") + path,
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${this.settings.key}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      throw: false,
    });
    if (r.status === 401) throw new Error("Multitude didn't accept the key. Create a new one in Multitude: Memory, Import, Obsidian.");
    if (r.status >= 400) throw new Error(r.json?.error || `Multitude error ${r.status}`);
    return r.json;
  }

  async sync(loud: boolean) {
    if (this.busy) return;
    if (!this.ready()) { if (loud) new Notice("Multitude: paste your key in Settings, Multitude first."); return; }
    this.busy = true;
    const s = this.settings;
    try {
      // 1. Notes out: hash everything, ask which changed, send those, remove deleted ones.
      this.paint("Multitude: checking notes…");
      const files = this.app.vault.getMarkdownFiles().filter((f) => !this.skip(f.path));
      const notes = new Map<string, { path: string; title: string; body: string; tags: string[]; created: number }>();
      const list: { path: string; h: string }[] = [];
      for (const f of files) {
        const body = (await this.app.vault.cachedRead(f)).slice(0, MAX_BODY);
        if (body.trim().length < 3) continue;
        const cache = this.app.metadataCache.getFileCache(f);
        const fmTags = cache?.frontmatter?.tags;
        const tags = [...(Array.isArray(fmTags) ? fmTags : typeof fmTags === "string" ? fmTags.split(/[,\s]+/) : []), ...(cache?.tags ?? []).map((t) => t.tag)].map((t) => String(t).replace(/^#/, "")).filter(Boolean);
        const title = String(cache?.frontmatter?.title || cache?.headings?.find((h) => h.level === 1)?.heading || f.basename).slice(0, 200);
        notes.set(f.path, { path: f.path, title, body, tags: [...new Set(tags)].slice(0, 20), created: f.stat.ctime });
        list.push({ path: f.path, h: await sha1(body) });
      }
      const m = await this.api("/api/vault/manifest", { ws: s.ws, source: "obsidian", files: list });
      let gone: string[] = m.gone ?? [];
      // Safety: if most of what Multitude knows has vanished (a vault moved or half-synced), don't delete; ask.
      if (gone.length > 20 && gone.length > (m.known || 0) * 0.5) {
        new Notice(`Multitude: ${gone.length} notes look deleted, so nothing was removed. If that's right, remove them in Multitude: Import, Obsidian.`, 12000);
        gone = [];
      }
      const send = (m.need as string[]).map((p) => notes.get(p)).filter(Boolean) as any[];
      let stored = 0, removed = 0, sentDel = false;
      for (let i = 0; i < send.length || (i === 0 && gone.length);) {
        const batch: any[] = []; let size = 0;
        while (i < send.length && batch.length < 40 && size < 400_000) { batch.push(send[i]); size += send[i].body.length; i++; }
        this.paint(`Multitude: sending ${Math.min(i, send.length)} of ${send.length}…`);
        const j = await this.api("/api/vault/push", { ws: s.ws, source: "obsidian", scope: s.scope, vault: this.app.vault.getName(), notes: batch, deleted: sentDel ? [] : gone });
        sentDel = true;
        stored += j.stored; removed += j.removed;
        if (!send.length) break;
      }
      // 2. New and changed notes are read for key facts (a few at a time, within your plan's limits).
      let facts = 0;
      if (stored) for (let k = 0; k < 20; k++) {
        this.paint("Multitude: finding key facts…");
        const d = await this.api("/api/vault/digest", { ws: s.ws });
        facts += d.saved || 0;
        if (!d.remaining) break;
      }
      // 3. Memory in: write each memory as a note in the Multitude folder.
      let wrote = 0;
      if (s.pull) wrote = await this.pullMemory();
      s.lastSync = Date.now();
      await this.saveData(s);
      this.paint();
      if (loud || stored || removed || facts) new Notice(`Multitude: ${stored ? `${stored} note${stored === 1 ? "" : "s"} sent` : "notes up to date"}${removed ? `, ${removed} removed` : ""}${facts ? `, ${facts} new memor${facts === 1 ? "y" : "ies"}` : ""}${wrote ? `, ${wrote} memory notes updated` : ""}.`);
    } catch (e) {
      this.paint("Multitude: sync failed");
      if (loud) new Notice(String((e as Error)?.message ?? e), 10000);
      console.error("Multitude sync", e);
    } finally { this.busy = false; }
  }

  async pullMemory() {
    const s = this.settings, vault = this.app.vault;
    const root = normalizePath(s.folder || "Multitude");
    const dir = `${root}/Memory`;
    for (const p of [root, dir]) if (!vault.getAbstractFileByPath(p)) await vault.createFolder(p).catch(() => {});
    const j = await this.api(`/api/vault/pull?ws=${encodeURIComponent(s.ws)}&since=${s.cursor || 0}`);
    let wrote = 0;
    const used = new Set(Object.values(s.files));
    for (const m of j.memories as any[]) {
      let path = s.files[m.id];
      if (!path) {
        const base = `${dir}/${slug(m.key) || "memory"}`;
        path = `${base}.md`;
        for (let n = 2; used.has(path) || (vault.getAbstractFileByPath(path) && !Object.values(s.files).includes(path)); n++) path = `${base}-${n}.md`;
        s.files[m.id] = path; used.add(path);
      }
      const body = [
        "---",
        `multitude_id: ${m.id}`,
        `key: ${yaml(m.key)}`,
        `scope: ${m.scope === "me" ? "only me" : "team"}`,
        m.project ? `project: ${yaml(m.project)}` : null,
        m.source ? `source: ${yaml(m.source)}` : null,
        m.author ? `author: ${yaml(m.author)}` : null,
        `updated: ${new Date(m.updated).toISOString()}`,
        "tags: [multitude]",
        "---",
        "",
        m.text,
        "",
        `Back to [[${root}/Memory index|Memory index]]. Synced from Multitude: edit it there, changes here are replaced on the next sync.`,
        "",
      ].filter((x) => x !== null).join("\n");
      const f = vault.getAbstractFileByPath(path);
      if (f instanceof TFile) { if ((await vault.read(f)) !== body) { await vault.modify(f, body); wrote++; } }
      else { await vault.create(path, body); wrote++; }
    }
    for (const r of j.removed as any[]) {
      const path = s.files[r.id]; if (!path) continue;
      const f = vault.getAbstractFileByPath(path);
      if (f instanceof TFile) { await this.app.fileManager.trashFile(f); wrote++; }
      delete s.files[r.id];
    }
    if (j.memories.length || j.removed.length || !vault.getAbstractFileByPath(`${root}/Memory index.md`)) await this.writeIndex(root);
    s.cursor = j.cursor || s.cursor;
    return wrote;
  }

  async writeIndex(root: string) {
    const vault = this.app.vault;
    const rows: { path: string; text: string }[] = [];
    for (const path of Object.values(this.settings.files)) {
      const f = vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile)) continue;
      const text = (await vault.cachedRead(f)).split(/\n---\n/)[1]?.trim().split("\n")[0] ?? f.basename;
      rows.push({ path: path.replace(/\.md$/, ""), text });
    }
    rows.sort((a, b) => a.text.localeCompare(b.text));
    const body = `# Memory index\n\nWhat Multitude remembers, shared with every AI you use there. ${rows.length} memor${rows.length === 1 ? "y" : "ies"}, synced ${new Date().toLocaleString()}.\n\n${rows.map((r) => `- [[${r.path}|${r.text.replace(/[\[\]|]/g, "").slice(0, 140)}]]`).join("\n")}\n`;
    const path = `${root}/Memory index.md`;
    const f = vault.getAbstractFileByPath(path);
    if (f instanceof TFile) await vault.modify(f, body); else await vault.create(path, body);
  }
}

class MultitudeSettings extends PluginSettingTab {
  constructor(app: App, private plugin: MultitudePlugin) { super(app, plugin); }
  display() {
    const { containerEl: el } = this; const s = this.plugin.settings;
    el.empty();
    el.createEl("p", { text: "Two-way sync with Multitude: your notes become searchable by every AI you use there, and your memory appears here in a Multitude folder." });
    new Setting(el).setName("Key").setDesc("In Multitude, open Memory, then Import, choose Obsidian and tap Create plugin key. Paste the whole line here.")
      .addText((t) => t.setPlaceholder("https://app.trymultitude.com#…").setValue(s.key ? `${s.server}#${s.ws}:••••••••` : "").onChange(async (v) => {
        const m = v.trim().match(/^(https?:\/\/[^#\s]+)#(\w+):([\w-]{16,})$/);
        if (!m) return;
        s.server = m[1].replace(/\/+$/, ""); s.ws = m[2]; s.key = m[3]; s.cursor = 0;
        await this.plugin.saveData(s); this.plugin.paint(); new Notice("Multitude: key saved. Syncing…"); this.plugin.sync(true);
      }));
    new Setting(el).setName("Who can use your notes").setDesc("Team: your Multitude workspace can use them. Only me: private to you.")
      .addDropdown((d) => d.addOption("team", "Team").addOption("me", "Only me").setValue(s.scope).onChange(async (v) => { s.scope = v as Settings["scope"]; await this.plugin.saveData(s); }));
    new Setting(el).setName("Bring memory into the vault").setDesc("Keeps a Multitude folder with one note per memory and an index.")
      .addToggle((t) => t.setValue(s.pull).onChange(async (v) => { s.pull = v; await this.plugin.saveData(s); }));
    new Setting(el).setName("Memory folder").setDesc("Never sent to Multitude.")
      .addText((t) => t.setValue(s.folder).onChange(async (v) => { s.folder = v.trim() || "Multitude"; await this.plugin.saveData(s); }));
    new Setting(el).setName("Folders to leave out").setDesc("Comma separated, e.g. Journal, Private")
      .addText((t) => t.setValue(s.exclude).onChange(async (v) => { s.exclude = v; await this.plugin.saveData(s); }));
    new Setting(el).setName("Sync every (minutes)").setDesc("Also syncs a minute after you stop editing.")
      .addText((t) => t.setValue(String(s.everyMinutes)).onChange(async (v) => { s.everyMinutes = Math.max(5, Number(v) || 15); await this.plugin.saveData(s); this.plugin.schedule(); }));
    new Setting(el).addButton((b) => b.setButtonText("Sync now").setCta().onClick(() => this.plugin.sync(true)));
  }
}

async function sha1(s: string) {
  const b = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const slug = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const yaml = (s: string) => JSON.stringify(String(s ?? ""));
function ago(t: number) { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} hr ago` : `${Math.round(m / 1440)} d ago`; }
