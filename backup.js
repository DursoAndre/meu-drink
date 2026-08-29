// backup.js
// Export/restore for Meus Drinks. Backup format:
// { backup_version, exported_at, records: [{ import_data, rating, comment,
//   status, created_at, updated_at, photos: { primary, secondary } }] }
// Photos are embedded as base64 data URLs with explicit MIME types.

import { BACKUP_VERSION, validateBackupStructure, computeIdentity } from "./validation.js";
import { exportSnapshot, importRecords, findByIdentity } from "./db.js";

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  // Avoid fetch() on data: URIs (keeps behavior CSP-connect-src independent
  // and works identically across browsers).
  const [header, base64] = dataUrl.split(",");
  const mimeMatch = /data:([^;]+);base64/.exec(header || "");
  const mime = mimeMatch ? mimeMatch[1] : "application/octet-stream";
  const binary = atob(base64 || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function photoToPayload(photo) {
  if (!photo) return null;
  return { name: photo.name || "photo", type: photo.type || "image/jpeg", data: null, _blob: photo.blob };
}

/** Builds the full backup JSON (as an object) plus a Blob ready to save/share. */
export async function buildBackup() {
  const { records, photosByRecord, revision } = await exportSnapshot();

  const outRecords = [];
  // Sequential, not concurrent: avoids holding many decoded images in memory.
  for (const rec of records) {
    const photoRow = photosByRecord.get(rec.id);
    const primary = photoRow && photoRow.primaryPhoto ? photoRow.primaryPhoto : null;
    const secondary = photoRow && photoRow.secondaryPhoto ? photoRow.secondaryPhoto : null;
    const primaryData = primary ? await blobToDataUrl(primary.blob) : null;
    const secondaryData = secondary ? await blobToDataUrl(secondary.blob) : null;
    outRecords.push({
      import_data: rec.import_data,
      rating: rec.rating,
      comment: rec.comment,
      status: rec.status,
      created_at: rec.created_at,
      updated_at: rec.updated_at,
      photos: {
        primary: primary ? { name: primary.name, type: primary.type, data: primaryData } : null,
        secondary: secondary ? { name: secondary.name, type: secondary.type, data: secondaryData } : null,
      },
    });
  }

  const payload = {
    backup_version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    records: outRecords,
  };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const stamp = payload.exported_at.replace(/[:.]/g, "-");
  const filename = `meus-drinks-backup-${stamp}.json`;
  return { payload, blob, filename, revision };
}

/**
 * Attempts to share the backup via the Web Share API (mobile-friendly).
 * Falls back to a plain download. IMPORTANT: resolving does not mean the
 * user actually kept the file — the caller must still ask for explicit
 * confirmation before marking the revision as backed up.
 */
export async function shareOrDownloadBackup(blob, filename) {
  const file = new File([blob], filename, { type: "application/json" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: "Backup do Meus Drinks",
      });
      return { method: "share", completed: true };
    } catch (err) {
      if (err && err.name === "AbortError") {
        return { method: "share", completed: false };
      }
      // Fall through to download if sharing failed for another reason.
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { method: "download", completed: true };
}

const MAX_TEXT_BYTES = 30 * 1024 * 1024;

/**
 * Reads and structurally validates a backup file WITHOUT decoding any photo
 * bytes yet (sizes are estimated from the base64 length). Returns
 * { valid, errors, parsed }.
 */
export async function readAndValidateBackupFile(file) {
  if (file.size > MAX_TEXT_BYTES) {
    return { valid: false, errors: [`arquivo maior que ${MAX_TEXT_BYTES} bytes`], parsed: null };
  }
  const text = await file.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { valid: false, errors: [`JSON inválido: ${e.message}`], parsed: null };
  }
  const result = validateBackupStructure(parsed, file.size);
  return { valid: result.valid, errors: result.errors, parsed: result.valid ? parsed : null };
}

/**
 * Given an already-validated backup object, decodes photos (only now that
 * structure passed) and finds which incoming records collide with existing
 * local identities. Returns { items, duplicates } where `items` is ready
 * for db.importRecords and `duplicates` lists identities needing a
 * keep/replace decision from the user.
 */
export async function prepareRestore(parsed) {
  const items = [];
  const duplicates = [];
  for (const rec of parsed.records) {
    const identity = computeIdentity(rec.import_data);
    const primaryPhoto = rec.photos && rec.photos.primary
      ? { name: rec.photos.primary.name, type: rec.photos.primary.type, blob: await dataUrlToBlob(rec.photos.primary.data) }
      : null;
    const secondaryPhoto = rec.photos && rec.photos.secondary
      ? { name: rec.photos.secondary.name, type: rec.photos.secondary.type, blob: await dataUrlToBlob(rec.photos.secondary.data) }
      : null;
    items.push({
      record: {
        import_data: rec.import_data,
        rating: rec.rating ?? null,
        comment: rec.comment ?? "",
        status: rec.status ?? "want_to_try",
        has_primary_photo: !!primaryPhoto,
        has_secondary_photo: !!secondaryPhoto,
        created_at: rec.created_at,
        updated_at: rec.updated_at,
      },
      primaryPhoto,
      secondaryPhoto,
    });

    const existing = await findByIdentity(identity);
    if (existing) {
      duplicates.push({ identity, existingRecord: existing, incomingName: rec.import_data.name });
    }
  }
  return { items, duplicates };
}

/** Applies the restore after the user resolved any duplicates. */
export async function performRestore(items, resolutions) {
  return importRecords(items, resolutions);
}
