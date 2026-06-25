// =============================================================================
// PharmaTrack v2 — sync.js
// Supabase data sync layer.
//
// WHAT THIS DOES:
//   • After an admin uploads any of the 4 files, saves the parsed data to
//     Supabase so all viewers see the same data automatically.
//   • When a signed-in user opens the app, loads the latest saved data from
//     Supabase and hydrates the app exactly as if they had uploaded the files.
//
// LOAD ORDER in index.html (add AFTER script.js):
//   <script src="sync.js" defer></script>
// =============================================================================

const SYNC_KEYS = {
  inventory: "inventory",
  transit:   "transit",
  mapping:   "mapping",
  incoming:  "incoming",
};

// ── SAVE ─────────────────────────────────────────────────────────────────────
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

    // ── Inventory ─────────────────────────────────────────────────────────
    if (byKey[SYNC_KEYS.inventory]?.length) {
      byKey[SYNC_KEYS.inventory].forEach(row => {
        if (row._expiry) row._expiry = new Date(row._expiry);
      });
      rawDf  = byKey[SYNC_KEYS.inventory];
      filtDf = rawDf;
      document.getElementById("fileStatus").style.display = "block";
      document.getElementById("fileStatus").innerHTML =
        `<div class="status-ok">✓ DATA LOADED</div><div class="status-name">Shared inventory · ${rawDf.length.toLocaleString()} records</div>`;
    }

    // ── Transit ───────────────────────────────────────────────────────────
    if (byKey[SYNC_KEYS.transit]?.length) {
      stockTransitRaw = byKey[SYNC_KEYS.transit];
      document.getElementById("transitFileStatus").style.display = "block";
      document.getElementById("transitFileStatus").innerHTML =
        `<div class="status-ok">✓ TRANSIT LOADED</div><div class="status-name">Shared transit · ${stockTransitRaw.length.toLocaleString()} records</div>`;
    }

    // ── Mapping ───────────────────────────────────────────────────────────
    if (byKey[SYNC_KEYS.mapping]?.length) {
      mappingTable = new Map(byKey[SYNC_KEYS.mapping]);
      document.getElementById("mappingFileStatus").style.display = "block";
      document.getElementById("mappingFileStatus").innerHTML =
        `<div class="status-ok">✓ MAPPING LOADED</div><div class="status-name">Shared mapping · ${mappingTable.size.toLocaleString()} entries</div>`;
    }

    // ── Incoming / Shelf Life ─────────────────────────────────────────────
    if (byKey[SYNC_KEYS.incoming]?.length) {
      incomingDf = byKey[SYNC_KEYS.incoming];
      document.getElementById("incomingFileStatus").style.display = "block";
      document.getElementById("incomingFileStatus").innerHTML =
        `<div class="status-ok">✓ SHELF LIFE LOADED</div><div class="status-name">Shared shelf life · ${incomingDf.length.toLocaleString()} records</div>`;
    }

    // ── Re-compute and render ─────────────────────────────────────────────
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

// ── HOOK INTO UPLOADS ────────────────────────────────────────────────────────
function _patchUploads() {
  const fileInput = document.getElementById("fileInput");
  if (fileInput) {
    fileInput.addEventListener("change", async () => {
      await new Promise(r => setTimeout(r, 500));
      if (!rawDf.length) return;
      await syncSave(SYNC_KEYS.inventory, rawDf);
    });
  }

  const transitInput = document.getElementById("transitFileInput");
  if (transitInput) {
    transitInput.addEventListener("change", async () => {
      await new Promise(r => setTimeout(r, 500));
      if (!stockTransitRaw.length) return;
      await syncSave(SYNC_KEYS.transit, stockTransitRaw);
    });
  }

  const mappingInput = document.getElementById("mappingFileInput");
  if (mappingInput) {
    mappingInput.addEventListener("change", async () => {
      await new Promise(r => setTimeout(r, 500));
      if (!mappingTable.size) return;
      await syncSave(SYNC_KEYS.mapping, [...mappingTable.entries()]);
    });
  }

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
// CRITICAL FIX: only load data AFTER the user is fully signed in.
// window.__pharmaRole is set by auth.js only after a successful login + role fetch.
// While it is null/undefined the user is not authenticated — do NOT load anything.
function _syncBoot() {
  let attempts = 0;
  const poll = setInterval(async () => {
    attempts++;
    // Give up after 60 seconds
    if (attempts > 120) { clearInterval(poll); return; }

    // Not signed in yet — keep waiting
    if (!window.__pharmaRole) return;

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
