import { App, TFile, TFolder, normalizePath, parseYaml } from "obsidian";
import type { ContactsIndexFile, ContactIndexItem } from "./types";
import { ContactsIndexStore, ContactsInteractionsStore } from "./indexStore";
import { computeSortname, ensureSortnameInFrontmatter } from "./sortname";

function nowIso() {
  return new Date().toISOString();
}

function asStringArray(v: any): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter((s) => !!s);
  if (typeof v === "string") return v ? [v] : [];
  return [];
}

function asStringOrNull(v: any): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function isContactFile(file: TFile): boolean {
  // Path convention: {contactsDir}/{group}/C_{uid}.md
  const name = file.name ?? "";
  return file.extension === "md" && /^C_[A-Za-z0-9]+\.md$/i.test(name);
}

function shouldSkipFolder(folder: TFolder): boolean {
  const n = folder.name ?? "";
  return (n === ".attachments" || n === ".rslatte");
}

async function readFrontmatterAny(app: App, file: TFile): Promise<Record<string, any>> {
  const cached = app.metadataCache.getFileCache(file)?.frontmatter;
  if (cached && typeof cached === "object") return { ...cached };

  // fallback: parse YAML block manually
  const text = await app.vault.read(file);
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return {};
  try {
    const obj = parseYaml(m[1]);
    if (obj && typeof obj === "object") return obj as any;
    return {};
  } catch {
    return {};
  }
}

export class ContactsIndexService {
  private app: App;
  private contactsDirRef: () => string;
  private archiveDirRef: () => string;
  private centralIndexDirRef: () => string;
  private store: ContactsIndexStore;
  private interactionsStore: ContactsInteractionsStore;

  constructor(app: App, contactsDirRef: () => string, archiveDirRef: () => string, centralIndexDirRef: () => string) {
    this.app = app;
    this.contactsDirRef = contactsDirRef;
    this.archiveDirRef = archiveDirRef;
    this.centralIndexDirRef = centralIndexDirRef;
    this.store = new ContactsIndexStore(app, centralIndexDirRef);
    this.interactionsStore = new ContactsInteractionsStore(app, centralIndexDirRef);
  }

  public getIndexStore(): ContactsIndexStore {
    return this.store;
  }

  public getInteractionsStore(): ContactsInteractionsStore {
    return this.interactionsStore;
  }

  /** Step0: ensure contacts-interactions index exists (best-effort) */
  public async ensureInteractionsIndexReady(): Promise<void> {
    await this.interactionsStore.ensureExists();
  }

  /**
   * Best-effort rewrite of interaction source paths after external move/rename.
   *
   * Used by diary auto-archive so contact dynamic links remain valid without
   * waiting for the next task/project incremental scan.
   */
  public async rewriteInteractionsSourcePaths(moves: Array<{ from: string; to: string }>): Promise<{ updated: number }> {
    await this.ensureInteractionsIndexReady();
    return this.interactionsStore.rewriteSourcePaths(moves);
  }

  private listContactFiles(opts?: { includeArchived?: boolean; archivedOnly?: boolean }): TFile[] {
    const contactsRoot = normalizePath((this.contactsDirRef() ?? "").trim() || "90-Contacts");
    const archiveRoot = normalizePath((this.archiveDirRef() ?? "").trim() || `${contactsRoot}/_archived`);

    const pickRoot = (opts?.archivedOnly === true) ? archiveRoot : contactsRoot;
    const af = this.app.vault.getAbstractFileByPath(pickRoot);
    if (!af || !(af instanceof TFolder)) return [];

    const out: TFile[] = [];
    const walk = (folder: TFolder) => {
      // skip well-known subfolders
      if (shouldSkipFolder(folder)) return;
      // when scanning main contactsRoot, exclude archiveRoot if it is nested inside
      if (opts?.archivedOnly !== true) {
        const fp = normalizePath(folder.path);
        if (fp === archiveRoot || fp.startsWith(archiveRoot + "/")) return;
      }
      for (const c of folder.children) {
        if (c instanceof TFolder) walk(c);
        else if (c instanceof TFile) {
          if (isContactFile(c)) out.push(c);
        }
      }
    };

    walk(af);
    return out;
  }

  public async rebuild(opts?: { includeArchived?: boolean; archivedOnly?: boolean }): Promise<{ index: ContactsIndexFile; parseErrorFiles: string[] }> {
    const files = this.listContactFiles(opts);
    const items: ContactIndexItem[] = [];
    const parseErrorFiles: string[] = [];

    for (const f of files) {
      try {
        const fm = await readFrontmatterAny(this.app, f);
        const type = String((fm as any).type ?? "").trim();
        const uid = String((fm as any).contact_uid ?? "").trim();
        const displayName = String((fm as any).display_name ?? "").trim();
        const sortnameRaw = String((fm as any).sortname ?? "").trim();
        const sortname = sortnameRaw || computeSortname(displayName);

        // best-effort validation: must have uid & display_name; type=contact is strongly recommended
        if (!uid || !displayName) {
          parseErrorFiles.push(f.path);
          continue;
        }
        if (type && type !== "contact") {
          // still accept but mark as parse error (so user can fix)
          parseErrorFiles.push(f.path);
        }

        const folderGroup = f.parent?.name ?? "";
        const groupName = String((fm as any).group_name ?? folderGroup).trim() || folderGroup;

        const archiveRoot = normalizePath((this.archiveDirRef() ?? "").trim() || `${normalizePath((this.contactsDirRef() ?? "").trim() || "90-Contacts")}/_archived`);
        const isArchived = opts?.archivedOnly === true || (normalizePath(f.path).startsWith(archiveRoot + "/") || normalizePath(f.path) === archiveRoot);

        const item: ContactIndexItem = {
          contact_uid: uid,
          display_name: displayName,
          sortname,
          aliases: asStringArray((fm as any).aliases),
          group_name: groupName,
          title: String((fm as any).title ?? "").trim(),

          status: String((fm as any).status ?? "active").trim() || "active",
          cancelled_at: asStringOrNull((fm as any).cancelled_at),

          tags: asStringArray((fm as any).tags),
          avatar_path: asStringOrNull((fm as any).avatar_path),
          file_path: f.path,

          created_at: asStringOrNull((fm as any).created_at),
          updated_at: asStringOrNull((fm as any).updated_at),
          last_interaction_at: asStringOrNull((fm as any).last_interaction_at),

          archived: isArchived ? true : undefined,
          archived_at: asStringOrNull((fm as any).archived_at),
          archive_path: isArchived ? f.path : undefined,

          mtime_key: String(f.stat?.mtime ?? ""),
        };

        items.push(item);

        // Best-effort backfill: write sortname into frontmatter if missing/outdated.
        // This should never block rebuild.
        if (!sortnameRaw || sortnameRaw !== sortname) {
          // Await so that after rebuild/refresh completes, the user can immediately
          // see the "sortname" field in Properties. Still best-effort: errors are swallowed.
          await ensureSortnameInFrontmatter(this.app, f, displayName);
        }
      } catch {
        parseErrorFiles.push(f.path);
      }
    }

    const index: ContactsIndexFile = {
      version: 1,
      updatedAt: nowIso(),
      items,
      parseErrorFiles,
    };

    return { index, parseErrorFiles };
  }

  public async rebuildAndWrite(): Promise<{ indexPath: string; count: number; parseErrorFiles: string[]; scannedFiles?: string[] }> {
    const files = this.listContactFiles({ includeArchived: false, archivedOnly: false });
    const scannedFiles = files.map(f => f.path);
    const { index, parseErrorFiles } = await this.rebuild({ includeArchived: false, archivedOnly: false });
    await this.store.writeIndex(index);
    return { indexPath: this.store.getIndexFilePath(), count: index.items.length, parseErrorFiles, scannedFiles };
  }

  /** C6: rebuild archive contacts index (scan archiveDir) */
  public async rebuildArchiveAndWrite(): Promise<{ indexPath: string; count: number; parseErrorFiles: string[]; scannedFiles?: string[] }> {
    const files = this.listContactFiles({ archivedOnly: true });
    const scannedFiles = files.map(f => f.path);
    const { index, parseErrorFiles } = await this.rebuild({ archivedOnly: true });
    await this.store.writeArchiveIndex(index);
    return { indexPath: this.store.getArchiveIndexFilePath(), count: index.items.length, parseErrorFiles, scannedFiles };
  }

  /** C6: rebuild both main + archive indexes */
  public async rebuildAllAndWrite(): Promise<{
    main: { indexPath: string; count: number; parseErrorFiles: string[]; scannedFiles?: string[] };
    archive: { indexPath: string; count: number; parseErrorFiles: string[]; scannedFiles?: string[] };
  }> {
    const main = await this.rebuildAndWrite();
    const archive = await this.rebuildArchiveAndWrite();
    return { main, archive };
  }
}
