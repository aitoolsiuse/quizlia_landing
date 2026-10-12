// Folder-registry cloud sync (shared schema with the iOS app).
//
// Web keeps localStorage (`folders_${profileId}`) as the immediate cache and
// mirrors the profile's whole folder list to
// `users/{uid}/profiles/{pid}/folders/folderRegistry` — one consolidated doc
// (same pattern as notes/userContent). Last-write-wins per folder by
// updatedAt; deletes are tombstones (deletedAt) kept locally and remotely so
// an offline device cannot resurrect a deleted folder. Signed-out users get
// the local list untouched.
import { db, auth, isFirebaseConfigured } from "./firebase";
import { doc, getDoc, setDoc } from "firebase/firestore";

// Shape stored in localStorage folders_<pid> AND in the registry doc.
// Tombstoned entries (deletedAt set) stay in the array but are hidden by UI.
export interface SyncedFolder {
  id: string; // cloud id: web local id (stable string) or "ios_<sqliteId>"
  name: string;
  icon: string;
  createdAt: string;
  updatedAt: string; // ISO locally; Firestore Timestamp inside the registry
  deletedAt?: string | null;
  clientOrigin?: "web" | "ios";
}

export function localFoldersKey(profileId: number | string): string {
  return `folders_${profileId}`;
}

type RemoteFolder = {
  id: string;
  name: string;
  icon: string | null;
  clientOrigin: string;
  createdAt: string;
  updatedAt: { toDate(): Date } | string; // Firestore Timestamp or ISO
  deletedAt?: { toDate(): Date } | string | null;
};

const asDate = (v: unknown): number => {
  if (!v) return 0;
  if (typeof v === "string") return new Date(v).getTime() || 0;
  const maybe = v as { toDate?: () => Date };
  if (typeof maybe.toDate === "function") return maybe.toDate().getTime();
  return 0;
};

export async function syncProfileFolders(
  profile: { id: number | string; email?: string },
  hooks?: { onRemoteDelete?: (folderId: string) => void }
): Promise<SyncedFolder[]> {
  const key = localFoldersKey(profile.id);
  let local: SyncedFolder[] = [];
  if (typeof window !== "undefined") {
    try {
      local = JSON.parse(localStorage.getItem(key) || "[]");
    } catch {
      local = [];
    }
  }

  if (!isFirebaseConfigured() || !db || !auth?.currentUser) return local;

  try {
    const uid = auth.currentUser.uid;
    const ref = doc(db, "users", uid, "profiles", String(profile.id), "folders", "folderRegistry");
    const snap = await getDoc(ref);
    const remote: RemoteFolder[] = snap.exists() ? (snap.data().folders as RemoteFolder[]) || [] : [];

    const byId = new Map<string, SyncedFolder>();
    for (const folder of local) byId.set(folder.id, folder);

    for (const r of remote) {
      const existing = byId.get(r.id);
      const remoteMs = asDate(r.updatedAt);
      const localMs = existing ? new Date(existing.updatedAt).getTime() || 0 : 0;

      if (!existing) {
        if (r.deletedAt) {
          // Tombstone for a folder this device has never seen: remember it
          // (kept locally and re-pushed) so a stale device cannot resurrect
          // the folder; nothing to unsort for an unknown folder.
          byId.set(r.id, {
            id: r.id,
            name: r.name || "deleted",
            icon: r.icon || "📁",
            createdAt: r.createdAt || new Date().toISOString(),
            updatedAt: new Date(remoteMs || Date.now()).toISOString(),
            deletedAt: new Date(asDate(r.deletedAt) || remoteMs || Date.now()).toISOString(),
            clientOrigin: (r.clientOrigin as "web" | "ios") || "ios",
          });
        } else {
          byId.set(r.id, {
            id: r.id,
            name: r.name,
            icon: r.icon || "📁",
            createdAt: r.createdAt || new Date().toISOString(),
            updatedAt: new Date(remoteMs || Date.now()).toISOString(),
            clientOrigin: (r.clientOrigin as "web" | "ios") || "ios",
          });
        }
        continue;
      }

      if (remoteMs > localMs) {
        if (r.deletedAt) {
          // Remote delete wins: unsort this folder's notes and KEEP the
          // tombstone locally (and in the push below) so every device
          // converges on the delete.
          hooks?.onRemoteDelete?.(r.id);
          byId.set(r.id, {
            ...existing,
            deletedAt: new Date(asDate(r.deletedAt)).toISOString(),
            updatedAt: new Date(remoteMs).toISOString(),
          });
        } else {
          // Remote edit/undelete wins: the folder is alive.
          byId.set(r.id, {
            ...existing,
            name: r.name,
            icon: r.icon || existing.icon, // remote null never clobbers a local emoji
            updatedAt: new Date(remoteMs).toISOString(),
            deletedAt: null,
          });
        }
      }
      // else: local is newer or equal — local entry (possibly a tombstone)
      // stays and is re-pushed below.
    }

    const merged = Array.from(byId.values());

    // Push the merged registry (creates, local edits, tombstones all ride along).
    await setDoc(ref, {
      clientOrigin: "web",
      updatedAt: new Date().toISOString(),
      folders: merged.map((f) => ({
        id: f.id,
        name: f.name,
        icon: f.icon || null,
        clientOrigin: f.clientOrigin || "web",
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
        deletedAt: f.deletedAt || null,
      })),
    });

    if (typeof window !== "undefined") {
      localStorage.setItem(key, JSON.stringify(merged));
    }
    return merged;
  } catch (error) {
    console.warn("Folder sync failed (kept locally):", error);
    return local;
  }
}
