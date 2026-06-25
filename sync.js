// =============================================================================
// PharmaTrack v2 — sync.js  (Storage Edition)
// Supabase data sync layer.
//
// STRATEGY (replaces JSONB-per-row approach):
//   • Admin upload  → raw Excel bytes → Supabase Storage bucket
//                     + tiny metadata row in shared_data  { path, count }
//   • Viewer load   → read metadata row → download bytes from Storage
//                     → re-parse with XLSX (same path as a local upload)
//                     → hydrate app state
//
//   This sidesteps the free-tier 1 MB JSONB-per-row limit entirely; the
//   Storage bucket supports files up to 50 MB on the free tier.
//
// SUPABASE SETUP (one-time):
// ─────────────────────────────────────────────────────────────────────────────
// 1. Create a Storage bucket called "pharmatrack-files"
//      Dashboard → Storage → New bucket
//      Public: OFF  (we stream via signed URLs or the authed client)
//
// 2. Create / keep the shared_data table (schema is backward-compatible):
//
//   create table if not exists shared_data (
//     key        text primary key,
//     data       jsonb not null,        -- holds metadata object, not full rows
//     updated_at timestamptz default now()
//   );
//   alter table shared_data enable row level security;
//   create policy "Anyone can read shared_data"
//     on shared_data for select using (true);
//   create policy "Admins can upsert shared_data"
//     on shared_data for all
//     using  (exists (select 1 from user_roles where user_id = auth.uid() and role = 'admin'))
//     with check (exists (select 1 from user_roles where user_id = auth.uid() and role = 'admin'));
//
// 3. Storage RLS policies for "pharmatrack-files" bucket:
//
//   -- Anyone authenticated can read
//   create policy "Authenticated users can read pharmatrack files"
//     on storage.objects for select
//     using (bucket_id = 'pharmatrack-files' and auth.role() = 'authenticated');
//
//   -- Only admins can write
//   create policy "Admins can upload pharmatrack files"
//     on storage.objects for insert
//     with check (
//       bucket_id = 'pharmatrack-files' and
//       exists (select 1 from user_roles where user_id = auth.uid() and role = 'admin')
//     );
//
//   create policy "Admins can update pharmatrack files"
//     on storage.objects for update
//     using (
//       bucket_id = 'pharmatrack-files' and
//       exists (select 1 from user_roles where user_id = auth.uid() and role = 'admin')
//     );
// =============================================================================

const SYNC_BUCKET = "pharmatrack-files";

// Keys used in the shared_data table AND as Storage object names
const SYNC_KEYS = {
  inventory: "inventory",
  transit:   "transit",
  mapping:   "mapping",   // small enough to keep as JSON; Storage used as fallback
  incoming:  "incoming",
};

// ── HELPERS ───────────────────────────────────────────────────────────────────

/**
 * Returns the Storage object path for a given key.
 * e.g. "inventory" → "inventory.xlsx"
 */
function _storagePath(key) {
  return `${key}.xlsx`;
}

/**
 * Reads a File object as an ArrayBuffer (Promise).
 */
function _fileToBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error("FileReader error"));
    reader.readAsArrayBuffer(file);
  });
}

// ── SAVE ─────────────────────────────────────────────────────────────────────

/**
 * Uploads the raw File to Storage and saves a metadata stub to shared_data.
 *
 * @param {string} key        - one of SYNC_KEYS values
 * @param {File}   file       - the original File object from the <input>
 * @param {number} rowCount   - number of parsed rows (stored in metadata for display)
 */
async function syncSaveFile(key, file, rowCount) {
  const sb = getSupabase();
  if (!sb) return;

  const path = _storagePath(key);

  try {
    // 1. Upload raw bytes to Storage (upsert = overwrite on re-upload)
    const { error: uploadErr } = await sb.storage
      .from(SYNC_BUCKET)
      .upload(path, file, {
        upsert: true,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

    if (uploadErr) {
      console.warn(`sync: storage upload failed for "${key}":`, uploadErr.message);
      return;
    }
    console.log(`sync: uploaded "${path}" to Storage (${(file.size / 1024).toFixed(0)} KB)`);

    // 2. Save lightweight metadata to shared_data so all clients know a file exists
    const meta = {
      storagePath: path,
      count:       rowCount,
      fileName:    file.name,
      uploadedAt:  new Date().toISOString(),
    };

    const { error: metaErr } = await sb.from("shared_data").upsert(
      { key, data: meta, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
    if (metaErr) console.warn(`sync: metadata save failed for "${key}":`, metaErr.message);
    else         console.log(`sync: metadata saved for "${key}" (${rowCount} rows)`);

  } catch (e) {
    console.warn("sync: unexpected save error:", e);
  }
}

/**
 * Saves the mapping table as JSON directly (it's tiny — a few KB at most).
 * Keeps the original JSONB approach for this one dataset.
 */
async function syncSaveMapping(entries) {
  const sb = getSupabase();
  if (!sb) return;
  try {
    const { error } = await sb.from("shared_data").upsert(
      { key: SYNC_KEYS.mapping, data: { entries, count: entries.length }, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
    if (error) console.warn(`sync: mapping save failed:`, error.message);
    else       console.log(`sync: saved mapping (${entries.length} entries)`);
  } catch (e) {
    console.warn("sync: unexpected mapping save error:", e);
  }
}

// ── LOAD ─────────────────────────────────────────────────────────────────────

/**
 * Downloads a file from Storage and returns its ArrayBuffer.
 * Returns null on failure.
 */
async function _downloadFromStorage(sb, path) {
  try {
    const { data, error } = await sb.storage.from(SYNC_BUCKET).download(path);
    if (error) { console.warn(`sync: storage download failed for "${path}":`, error.message); return null; }
    return await data.arrayBuffer();
  } catch (e) {
    console.warn(`sync: unexpected download error for "${path}":`, e);
    return null;
  }
}

/**
 * Parses an Excel ArrayBuffer using the SheetJS (XLSX) library that script.js
 * already loads.  Returns an array of row objects (sheet_to_json format).
 * Returns null if XLSX is not available or parsing fails.
 */
function _parseXlsx(buffer) {
  if (typeof XLSX === "undefined") {
    console.warn("sync: XLSX library not available — cannot parse downloaded file");
    return null;
  }
  try {
    const wb = XLSX.read(buffer, { type: "array", cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { defval: "" });
  } catch (e) {
    console.warn("sync: XLSX parse error:", e);
    return null;
  }
}

/**
 * Loads all four datasets from Supabase and hydrates the app.
 * Called once on startup (for all users).
 */
async function syncLoad() {
  const sb = getSupabase();
  if (!sb) return;

  try {
    // ── 1. Fetch all metadata rows ─────────────────────────────────────────
    const { data: rows, error } = await sb
      .from("shared_data")
      .select("key, data")
      .in("key", Object.values(SYNC_KEYS));

    if (error) { console.warn("sync: load failed:", error.message); return; }
    if (!rows || !rows.length) { console.log("sync: no shared data yet."); return; }

    const byKey = {};
    rows.forEach(r => { byKey[r.key] = r.data; });

    // ── 2. Inventory ───────────────────────────────────────────────────────
    const invMeta = byKey[SYNC_KEYS.inventory];
    if (invMeta?.storagePath) {
      const buf = await _downloadFromStorage(sb, invMeta.storagePath);
      if (buf) {
        const parsed = _parseXlsx(buf);
        if (parsed?.length) {
          // script.js's processInventoryData() handles filtering + _expiry etc.
          // We call it exactly as if the user had uploaded the file locally.
          processInventoryData(parsed);
          console.log(`sync: loaded inventory from Storage (${rawDf.length} rows)`);
          document.getElementById("fileStatus").style.display = "block";
          document.getElementById("fileStatus").innerHTML =
            `<div class="status-ok">✓ DATA LOADED</div>` +
            `<div class="status-name">Shared · ${invMeta.fileName ?? "inventory"} · ${rawDf.length.toLocaleString()} records</div>`;
        }
      }
    }

    // ── 3. Transit ─────────────────────────────────────────────────────────
    const transMeta = byKey[SYNC_KEYS.transit];
    if (transMeta?.storagePath) {
      const buf = await _downloadFromStorage(sb, transMeta.storagePath);
      if (buf) {
        const parsed = _parseXlsx(buf);
        if (parsed?.length) {
          processTransitData(parsed);
          console.log(`sync: loaded transit from Storage (${stockTransitRaw.length} rows)`);
          document.getElementById("transitFileStatus").style.display = "block";
          document.getElementById("transitFileStatus").innerHTML =
            `<div class="status-ok">✓ TRANSIT LOADED</div>` +
            `<div class="status-name">Shared · ${transMeta.fileName ?? "transit"} · ${stockTransitRaw.length.toLocaleString()} records</div>`;
        }
      }
    }

    // ── 4. Mapping (stored as JSON entries — small dataset) ────────────────
    const mapMeta = byKey[SYNC_KEYS.mapping];
    if (mapMeta?.entries?.length) {
      mappingTable = new Map(mapMeta.entries);
      console.log(`sync: loaded mapping (${mappingTable.size} entries)`);
      document.getElementById("mappingFileStatus").style.display = "block";
      document.getElementById("mappingFileStatus").innerHTML =
        `<div class="status-ok">✓ MAPPING LOADED</div>` +
        `<div class="status-name">Shared mapping · ${mappingTable.size.toLocaleString()} entries</div>`;
    }

    // ── 5. Incoming / Shelf Life ───────────────────────────────────────────
    const incMeta = byKey[SYNC_KEYS.incoming];
    if (incMeta?.storagePath) {
      const buf = await _downloadFromStorage(sb, incMeta.storagePath);
      if (buf) {
        const parsed = _parseXlsx(buf);
        if (parsed?.length) {
          processIncomingData(parsed);
          console.log(`sync: loaded incoming from Storage (${incomingDf.length} rows)`);
          document.getElementById("incomingFileStatus").style.display = "block";
          document.getElementById("incomingFileStatus").innerHTML =
            `<div class="status-ok">✓ SHELF LIFE LOADED</div>` +
            `<div class="status-name">Shared · ${incMeta.fileName ?? "shelf-life"} · ${incomingDf.length.toLocaleString()} records</div>`;
        }
      }
    }

    // ── 6. Re-compute derived state and render ─────────────────────────────
    if (rawDf.length) {
      if (mappingTable.size > 0) applyMaterialMapping();
      if (stockTransitRaw.length) recomputePhantomTransit();
      recomputeIslMatch();
      resetPageFilters();
      populateAllFilters();
      hideLanding();
      renderPage(currentPage === "home" ? "dashboard" : currentPage);
    }

  } catch (e) {
    console.warn("sync: unexpected load error:", e);
  }
}

// ── HOOK INTO UPLOADS ─────────────────────────────────────────────────────────
// Patches each file <input> so that after script.js parses the file, we also
// upload the raw bytes to Storage (instead of posting the parsed JSON rows).
//
// NOTE: We capture the File reference synchronously on "change", then wait for
// script.js to finish parsing before reading rowCount from global state.

function _patchUploads() {

  // ── Inventory ─────────────────────────────────────────────────────────────
  const fileInput = document.getElementById("fileInput");
  if (fileInput) {
    fileInput.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      await new Promise(r => setTimeout(r, 500));   // let script.js parse first
      if (!rawDf.length) return;                     // parse failed
      await syncSaveFile(SYNC_KEYS.inventory, file, rawDf.length);
    });
  }

  // ── Transit ───────────────────────────────────────────────────────────────
  const transitInput = document.getElementById("transitFileInput");
  if (transitInput) {
    transitInput.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      await new Promise(r => setTimeout(r, 500));
      if (!stockTransitRaw.length) return;
      await syncSaveFile(SYNC_KEYS.transit, file, stockTransitRaw.length);
    });
  }

  // ── Mapping (JSON path — file is tiny) ────────────────────────────────────
  const mappingInput = document.getElementById("mappingFileInput");
  if (mappingInput) {
    mappingInput.addEventListener("change", async () => {
      await new Promise(r => setTimeout(r, 500));
      if (!mappingTable.size) return;
      await syncSaveMapping([...mappingTable.entries()]);
    });
  }

  // ── Incoming / Shelf Life ─────────────────────────────────────────────────
  const incomingInput = document.getElementById("incomingFileInput");
  if (incomingInput) {
    incomingInput.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      await new Promise(r => setTimeout(r, 500));
      if (!incomingDf.length) return;
      await syncSaveFile(SYNC_KEYS.incoming, file, incomingDf.length);
    });
  }
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
// Poll until auth.js has resolved the session, then load shared data.

function _syncBoot() {
  let attempts = 0;
  const poll = setInterval(async () => {
    attempts++;
    if (attempts > 60) { clearInterval(poll); return; }   // give up after 30s
    if (window.__pharmaUser === undefined) return;         // auth not resolved yet
    clearInterval(poll);

    await syncLoad();
    _patchUploads();
  }, 500);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _syncBoot);
} else {
  _syncBoot();
}
