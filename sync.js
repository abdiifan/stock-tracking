// =============================================================================
// PharmaTrack v2 — sync.js
// Supabase data sync layer.
//
// WHAT THIS DOES:
//   • After an admin uploads any of the 4 files, saves the parsed data to
//     Supabase so all viewers see the same data automatically.
//   • When any user opens the app, loads the latest saved data from Supabase
//     and hydrates the app exactly as if they had uploaded the files themselves.
//
// LOAD ORDER in index.html (add AFTER script.js):
//   <script src="sync.js" defer></script>
//
// SUPABASE TABLE REQUIRED:
//   Run this SQL in Supabase → SQL Editor:
//
//   create table if not exists shared_data (
//     key        text primary key,
//     data       jsonb not null,
//     updated_at timestamptz default now()
//   );
//
//   -- Only admins can write; everyone can read
//   alter table shared_data enable row level security;
//
//   create policy "Anyone can read shared_data"
//     on shared_data for select using (true);
//
//   create policy "Admins can upsert shared_data"
//     on shared_data for all
//     using  (exists (select 1 from user_roles where user_id = auth.uid() and role = 'admin'))
//     with check (exists (select 1 from user_roles where user_id = auth.uid() and role = 'admin'));
// =============================================================================

// Keys used in the shared_data table
const SYNC_KEYS = {
  inventory: "inventory",
  transit:   "transit",
  mapping:   "mapping",
  incoming:  "incoming",
};

// ── SAVE ─────────────────────────────────────────────────────────────────────
/**
 * Saves data to the shared_data table under a given key.
 * Only called after a successful admin upload.
 */
async function syncSave(key, data) {
  const sb = getSupabase();
  if (!sb) return;
  try {
    const { error } = await sb.from("shared_data").upsert(
      { key, data, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
    if (error) console.warn(`sync: save failed for "${key}":`, error.message);
    else console.log(`sync: saved "${key}" (${data.length ?? "?"} rows)`);
  } catch (e) {
    console.warn("sync: unexpected save error:", e);
  }
}

// ── LOAD ─────────────────────────────────────────────────────────────────────
/**
 * Loads all four datasets from Supabase and hydrates the app.
 * Called once on startup (for all users).
 */
async function syncLoad() {
  const sb = getSupabase();
  if (!sb) return;

  try {
    const { data: rows, error } = await sb
      .from("shared_data")
      .select("key, data")
      .in("key", Object.values(SYNC_KEYS));

    if (error) { console.warn("sync: load failed:", error.message); return; }
    if (!rows || !rows.length) { console.log("sync: no shared data yet."); return; }

    const byKey = {};
    rows.forEach(r => { byKey[r.key] = r.data; });

    // ── Inventory (main dataset) ───────────────────────────────────────────
    if (byKey[SYNC_KEYS.inventory]?.length) {
      // Restore _expiry dates (they become strings in JSON)
      byKey[SYNC_KEYS.inventory].forEach(row => {
        if (row._expiry) row._expiry = new Date(row._expiry);
      });
      rawDf  = byKey[SYNC_KEYS.inventory];
      filtDf = rawDf;
      console.log(`sync: loaded inventory (${rawDf.length} rows)`);

      document.getElementById("fileStatus").style.display = "block";
      document.getElementById("fileStatus").innerHTML =
        `<div class="status-ok">✓ DATA LOADED</div><div class="status-name">Shared inventory · ${rawDf.length.toLocaleString()} records</div>`;
    }

    // ── Transit ───────────────────────────────────────────────────────────
    if (byKey[SYNC_KEYS.transit]?.length) {
      stockTransitRaw = byKey[SYNC_KEYS.transit];
      console.log(`sync: loaded transit (${stockTransitRaw.length} rows)`);
      document.getElementById("transitFileStatus").style.display = "block";
      document.getElementById("transitFileStatus").innerHTML =
        `<div class="status-ok">✓ TRANSIT LOADED</div><div class="status-name">Shared transit · ${stockTransitRaw.length.toLocaleString()} records</div>`;
    }

    // ── Mapping ───────────────────────────────────────────────────────────
    if (byKey[SYNC_KEYS.mapping]?.length) {
      // mappingTable is a Map — rebuild it from the saved array of [key, value] pairs
      mappingTable = new Map(byKey[SYNC_KEYS.mapping]);
      console.log(`sync: loaded mapping (${mappingTable.size} entries)`);
      document.getElementById("mappingFileStatus").style.display = "block";
      document.getElementById("mappingFileStatus").innerHTML =
        `<div class="status-ok">✓ MAPPING LOADED</div><div class="status-name">Shared mapping · ${mappingTable.size.toLocaleString()} entries</div>`;
    }

    // ── Incoming / Shelf Life ─────────────────────────────────────────────
    if (byKey[SYNC_KEYS.incoming]?.length) {
      incomingDf = byKey[SYNC_KEYS.incoming];
      console.log(`sync: loaded incoming (${incomingDf.length} rows)`);
      document.getElementById("incomingFileStatus").style.display = "block";
      document.getElementById("incomingFileStatus").innerHTML =
        `<div class="status-ok">✓ SHELF LIFE LOADED</div><div class="status-name">Shared shelf life · ${incomingDf.length.toLocaleString()} records</div>`;
    }

    // ── Re-compute derived state and render ───────────────────────────────
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
// We patch the four file input change listeners AFTER script.js has set them up.
// Each patch wraps the original handler: after the file is parsed, we save to Supabase.

function _patchUploads() {
  // ── Inventory ────────────────────────────────────────────────────────────
  const fileInput = document.getElementById("fileInput");
  if (fileInput) {
    fileInput.addEventListener("change", async () => {
      // Wait for script.js's handler to finish parsing (it uses setTimeout 30ms)
      await new Promise(r => setTimeout(r, 500));
      if (!rawDf.length) return; // parse failed — don't save garbage
      await syncSave(SYNC_KEYS.inventory, rawDf);
    });
  }

  // ── Transit ──────────────────────────────────────────────────────────────
  const transitInput = document.getElementById("transitFileInput");
  if (transitInput) {
    transitInput.addEventListener("change", async () => {
      await new Promise(r => setTimeout(r, 500));
      if (!stockTransitRaw.length) return;
      await syncSave(SYNC_KEYS.transit, stockTransitRaw);
    });
  }

  // ── Mapping ──────────────────────────────────────────────────────────────
  const mappingInput = document.getElementById("mappingFileInput");
  if (mappingInput) {
    mappingInput.addEventListener("change", async () => {
      await new Promise(r => setTimeout(r, 500));
      if (!mappingTable.size) return;
      // Map is not JSON-serialisable directly — convert to array of pairs
      await syncSave(SYNC_KEYS.mapping, [...mappingTable.entries()]);
    });
  }

  // ── Incoming / Shelf Life ─────────────────────────────────────────────────
  const incomingInput = document.getElementById("incomingFileInput");
  if (incomingInput) {
    incomingInput.addEventListener("change", async () => {
      await new Promise(r => setTimeout(r, 500));
      if (!incomingDf.length) return;
      await syncSave(SYNC_KEYS.incoming, incomingDf);
    });
  }
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
// Wait for auth to finish (so we have a session) then load shared data.
// We poll window.__pharmaRole because it's set by auth.js after sign-in.

function _syncBoot() {
  let attempts = 0;
  const poll = setInterval(async () => {
    attempts++;
    // Give up after 30 seconds
    if (attempts > 60) { clearInterval(poll); return; }

    // Wait until auth.js has resolved the session
    if (window.__pharmaUser === undefined) return; // not yet resolved
    clearInterval(poll);

    // Load shared data for everyone
    await syncLoad();

    // Patch upload handlers so admins auto-save after upload
    _patchUploads();
  }, 500);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _syncBoot);
} else {
  _syncBoot();
}
