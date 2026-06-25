// =============================================================================
// PharmaTrack v2 — sync.js  (Storage Edition)
// Supabase data sync layer.
//
// STRATEGY:
//   • Admin upload  → raw Excel bytes → Supabase Storage bucket
//                     + tiny metadata row in shared_data  { path, count }
//   • Viewer load   → read metadata row → download Blob from Storage
//                     → wrap as File → call the same load* functions as a
//                       local upload (loadFile / loadTransitFile / etc.)
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
  mapping:   "mapping",
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


// ── LOAD ─────────────────────────────────────────────────────────────────────

/**
 * Downloads a file from Storage and returns it as a File object.
 * The existing load* functions in script.js all accept a File, so we wrap
 * the downloaded Blob — this reuses all validation/parsing/rendering logic
 * in script.js with zero duplication.
 *
 * Returns null on failure.
 *
 * @param {object} sb          - Supabase client
 * @param {string} storagePath - e.g. "inventory.xlsx"
 * @param {string} fileName    - display name for status messages
 */
async function _downloadAsFile(sb, storagePath, fileName) {
  try {
    const { data: blob, error } = await sb.storage
      .from(SYNC_BUCKET)
      .download(storagePath);

    if (error) {
      console.warn(`sync: storage download failed for "${storagePath}":`, error.message);
      return null;
    }

    // Wrap the Blob as a proper File so load* functions see a File object
    return new File(
      [blob],
      fileName || storagePath,
      { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }
    );
  } catch (e) {
    console.warn(`sync: unexpected download error for "${storagePath}":`, e);
    return null;
  }
}

/**
 * Loads all four datasets from Supabase Storage and hydrates the app by
 * calling the same load* functions that a manual upload would trigger.
 * Called once on startup (for all authenticated users).
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

    // ── 2. Mapping first — must be loaded before inventory so that
    //       applyMaterialMapping() runs automatically inside loadFile() ──────
    const mapMeta = byKey[SYNC_KEYS.mapping];
    if (mapMeta?.storagePath) {
      const file = await _downloadAsFile(sb, mapMeta.storagePath, mapMeta.fileName ?? "mapping.xlsx");
      if (file) {
        console.log("sync: loading mapping from Storage…");
        loadMappingFile(file);
        // Give the synchronous FileReader + setTimeout(30ms) inside loadMappingFile time to finish
        await new Promise(r => setTimeout(r, 200));
      }
    }

    // ── 3. Inventory ───────────────────────────────────────────────────────
    const invMeta = byKey[SYNC_KEYS.inventory];
    if (invMeta?.storagePath) {
      const file = await _downloadAsFile(sb, invMeta.storagePath, invMeta.fileName ?? "inventory.xlsx");
      if (file) {
        console.log("sync: loading inventory from Storage…");
        loadFile(file);
        await new Promise(r => setTimeout(r, 400)); // larger — inventory parse is heavier
      }
    }

    // ── 4. Transit ─────────────────────────────────────────────────────────
    const transMeta = byKey[SYNC_KEYS.transit];
    if (transMeta?.storagePath) {
      const file = await _downloadAsFile(sb, transMeta.storagePath, transMeta.fileName ?? "transit.xlsx");
      if (file) {
        console.log("sync: loading transit from Storage…");
        loadTransitFile(file);
        await new Promise(r => setTimeout(r, 200));
      }
    }

    // ── 5. Incoming / Shelf Life ───────────────────────────────────────────
    const incMeta = byKey[SYNC_KEYS.incoming];
    if (incMeta?.storagePath) {
      const file = await _downloadAsFile(sb, incMeta.storagePath, incMeta.fileName ?? "shelf-life.xlsx");
      if (file) {
        console.log("sync: loading incoming shelf life from Storage…");
        loadIncomingFile(file);
        await new Promise(r => setTimeout(r, 200));
      }
    }

  } catch (e) {
    console.warn("sync: unexpected load error:", e);
  }
}

// ── HOOK INTO UPLOADS ─────────────────────────────────────────────────────────
// After script.js finishes processing a user-uploaded file (admins only),
// we also push the raw File to Storage so viewers pick it up on next load.
//
// We attach a second "change" listener on each input; the first listener
// (registered by script.js) fires first and parses the file.  We wait
// 500 ms for that parsing to settle, then read the resulting row count
// from the global state before uploading.

function _patchUploads() {

  // ── Inventory ─────────────────────────────────────────────────────────────
  const fileInput = document.getElementById("fileInput");
  if (fileInput) {
    fileInput.addEventListener("change", async (e) => {
      if (!isAdmin()) return;
      const file = e.target.files?.[0];
      if (!file) return;
      await new Promise(r => setTimeout(r, 600));   // let script.js parse first
      if (!rawDf.length) return;                     // parse failed — skip upload
      await syncSaveFile(SYNC_KEYS.inventory, file, rawDf.length);
    });
  }

  // ── Transit ───────────────────────────────────────────────────────────────
  const transitInput = document.getElementById("transitFileInput");
  if (transitInput) {
    transitInput.addEventListener("change", async (e) => {
      if (!isAdmin()) return;
      const file = e.target.files?.[0];
      if (!file) return;
      await new Promise(r => setTimeout(r, 600));
      if (!stockTransitRaw.length) return;
      await syncSaveFile(SYNC_KEYS.transit, file, stockTransitRaw.length);
    });
  }

  // ── Mapping ───────────────────────────────────────────────────────────────
  const mappingInput = document.getElementById("mappingFileInput");
  if (mappingInput) {
    mappingInput.addEventListener("change", async (e) => {
      if (!isAdmin()) return;
      const file = e.target.files?.[0];
      if (!file) return;
      await new Promise(r => setTimeout(r, 600));
      if (!mappingTable.size) return;
      await syncSaveFile(SYNC_KEYS.mapping, file, mappingTable.size);
    });
  }

  // ── Incoming / Shelf Life ─────────────────────────────────────────────────
  const incomingInput = document.getElementById("incomingFileInput");
  if (incomingInput) {
    incomingInput.addEventListener("change", async (e) => {
      if (!isAdmin()) return;
      const file = e.target.files?.[0];
      if (!file) return;
      await new Promise(r => setTimeout(r, 600));
      if (!incomingRaw.length) return;
      await syncSaveFile(SYNC_KEYS.incoming, file, incomingRaw.length);
    });
  }
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
// Poll until auth.js has resolved the session (window.__pharmaUser is set),
// then load shared data and wire up upload patching.

function _syncBoot() {
  let attempts = 0;
  const poll = setInterval(async () => {
    attempts++;
    if (attempts > 60) { clearInterval(poll); return; }   // give up after 30 s
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
