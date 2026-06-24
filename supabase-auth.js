// =============================================================================
//  PharmaTrack v2 — supabase-auth.js
//  Authentication + database persistence layer.
//  Load this BEFORE filters.js and script.js in index.html.
//
//  Setup:
//    1. Run supabase_schema.sql in your Supabase SQL Editor.
//    2. Replace SUPABASE_URL and SUPABASE_ANON_KEY below with your project values
//       (Dashboard → Project Settings → API).
//    3. Add the Supabase CDN script to index.html (see comment at bottom).
// =============================================================================

const SUPABASE_URL      = "https://YOUR_PROJECT_ID.supabase.co";  // ← replace
const SUPABASE_ANON_KEY = "YOUR_ANON_KEY";                        // ← replace

// ── BATCH SIZES ────────────────────────────────────────────────────────────
// Supabase recommends ≤ 1 000 rows per insert for best throughput.
// For very large files we chunk into parallel batches of BATCH_SIZE.
const BATCH_SIZE        = 500;
const MAX_PARALLEL      = 4;   // concurrent insert promises

// =============================================================================
//  1. CLIENT BOOTSTRAP
// =============================================================================
let _supabase = null;

function getSupabase() {
  if (_supabase) return _supabase;
  if (typeof window.supabase === "undefined" || typeof window.supabase.createClient !== "function") {
    throw new Error("Supabase JS SDK not loaded. Add the CDN <script> before supabase-auth.js.");
  }
  _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession:   true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  return _supabase;
}

// =============================================================================
//  2. AUTH STATE
// =============================================================================
let _currentUser    = null;   // supabase User object | null
let _currentProfile = null;   // { id, email, full_name, role } | null

function getCurrentUser()    { return _currentUser; }
function getCurrentProfile() { return _currentProfile; }

/**
 * Loads the profile row for the current user and caches it.
 */
async function loadProfile(user) {
  if (!user) { _currentProfile = null; return null; }
  const sb = getSupabase();
  const { data, error } = await sb.from("profiles").select("*").eq("id", user.id).single();
  if (error) { console.warn("Profile load error:", error.message); return null; }
  _currentProfile = data;
  return data;
}

/**
 * Subscribe to auth state changes and keep _currentUser/_currentProfile in sync.
 * Also drives the UI (auth overlay vs app shell).
 */
function initAuthListener() {
  const sb = getSupabase();
  sb.auth.onAuthStateChange(async (event, session) => {
    _currentUser = session?.user ?? null;
    _currentProfile = null;

    if (_currentUser) {
      await loadProfile(_currentUser);
      hideAuthOverlay();
      updateUserBadge();
      // After sign-in, load the latest data from the DB (non-blocking)
      loadLatestDataFromDB().catch(e => console.warn("Auto-load from DB failed:", e.message));
    } else {
      showAuthOverlay();
    }
  });
}

// =============================================================================
//  3. AUTH ACTIONS
// =============================================================================

async function signIn(email, password) {
  const sb = getSupabase();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

async function signUp(email, password, fullName) {
  const sb = getSupabase();
  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName } },
  });
  if (error) throw error;
  return data;
}

async function signOut() {
  const sb = getSupabase();
  await sb.auth.signOut();
}

async function resetPassword(email) {
  const sb = getSupabase();
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + window.location.pathname,
  });
  if (error) throw error;
}

// =============================================================================
//  4. FAST BATCHED INSERT HELPERS
// =============================================================================

/**
 * Inserts rows into a Supabase table in parallel batches.
 * Returns { count, errors }.
 */
async function batchInsert(table, rows, progressCb) {
  const sb      = getSupabase();
  const chunks  = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    chunks.push(rows.slice(i, i + BATCH_SIZE));
  }

  let inserted = 0;
  let errors   = [];

  // Run up to MAX_PARALLEL batches at a time
  for (let i = 0; i < chunks.length; i += MAX_PARALLEL) {
    const window = chunks.slice(i, i + MAX_PARALLEL);
    const results = await Promise.all(
      window.map(chunk => sb.from(table).insert(chunk))
    );
    results.forEach(({ error, data }, idx) => {
      if (error) {
        errors.push({ chunk: i + idx, message: error.message });
      } else {
        inserted += window[idx].length;
      }
    });
    if (progressCb) progressCb(inserted, rows.length);
  }

  return { count: inserted, errors };
}

// =============================================================================
//  5. UPLOAD SESSION MANAGEMENT
// =============================================================================

/**
 * Creates a pending upload_sessions row and returns its id.
 */
async function createSession(uploadType, fileName) {
  const sb = getSupabase();
  const user = getCurrentUser();
  if (!user) throw new Error("Not authenticated");

  const { data, error } = await sb
    .from("upload_sessions")
    .insert({ user_id: user.id, upload_type: uploadType, file_name: fileName, status: "pending" })
    .select("id")
    .single();

  if (error) throw error;
  return data.id;
}

/**
 * Marks a session as complete (or error).
 */
async function finalizeSession(sessionId, rowCount, errorMsg = null) {
  const sb = getSupabase();
  const { error } = await sb
    .from("upload_sessions")
    .update({ status: errorMsg ? "error" : "complete", row_count: rowCount, error_msg: errorMsg })
    .eq("id", sessionId);
  if (error) console.warn("Session finalize error:", error.message);
}

/**
 * Returns the most recent complete session for a given uploadType.
 */
async function getLatestSession(uploadType) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("upload_sessions")
    .select("id, file_name, row_count, uploaded_at")
    .eq("upload_type", uploadType)
    .eq("status", "complete")
    .order("uploaded_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) { console.warn("getLatestSession error:", error.message); return null; }
  return data;
}

// =============================================================================
//  6. PERSIST EACH FILE TYPE TO SUPABASE
// =============================================================================

/**
 * Saves the main inventory file (filtDf after filters) to Supabase.
 * Called by the existing loadFile() success path in script.js.
 *
 * @param {Array}    df         — processed inventory rows (rawDf after filters)
 * @param {string}   fileName   — original file name (for the session log)
 * @param {Function} progressCb — (done, total) → void
 */
async function saveInventoryToDB(df, fileName, progressCb) {
  const sessionId = await createSession("inventory", fileName);
  try {
    const rows = df.map(r => ({
      session_id:                  sessionId,
      user_id:                     getCurrentUser().id,
      material:                    String(r["Material"]                     || "").trim(),
      material_description:        String(r["Material Description"]         || "").trim(),
      plant:                       String(r["Plant"]                        || "").trim(),
      plant_name:                  String(r["Plant Name"]                   || "").trim(),
      storage_location:            String(r["Storage Location"]             || "").trim(),
      storage_location_desc:       String(r["Description of Storage Location"] || "").trim(),
      special_stock_type:          String(r["Special Stock Type"]           || "").trim(),
      special_stock_type_desc:     String(r["Special Stock Type Description"] || "").trim(),
      batch:                       String(r["Batch"]                        || "").trim(),
      inventory_valuation_type:    String(r["Inventory Valuation Type"]     || "").trim(),
      material_group_name:         String(r["Material Group Name"]          || "").trim(),
      unrestricted_stock:          r["Unrestricted Stock"]                  || 0,
      stock_in_qi:                 r["Stock in Quality Inspection"]         || 0,
      blocked_stock:               r["Blocked Stock"]                       || 0,
      stock_in_transit:            r["Stock in Transit"]                    || 0,
      value_unrestricted:          r["Value of Unrestricted Stock"]         || 0,
      value_in_transit:            r["Value of Stock in Transit"]           || 0,
      value_in_qi:                 r["Value of Stock in Quality Inspection"] || 0,
      total_value:                 r["Total Value"]                         || 0,
      total_qty:                   r["Total Qty"]                           || 0,
      shelf_life_expiration_date:  r._expiry ? fmtLocalDate(r._expiry) : null,
    }));

    const { count, errors } = await batchInsert("inventory_rows", rows, progressCb);
    await finalizeSession(sessionId, count, errors.length ? errors[0].message : null);
    return { sessionId, count, errors };
  } catch (err) {
    await finalizeSession(sessionId, 0, err.message);
    throw err;
  }
}

/**
 * Saves the Stock-in-Transit file rows to Supabase.
 */
async function saveTransitToDB(transitRaw, fileName, progressCb) {
  const sessionId = await createSession("transit", fileName);
  try {
    const rows = transitRaw.map(r => ({
      session_id: sessionId,
      user_id:    getCurrentUser().id,
      data:       r,
    }));
    const { count, errors } = await batchInsert("transit_rows", rows, progressCb);
    await finalizeSession(sessionId, count, errors.length ? errors[0].message : null);
    return { sessionId, count, errors };
  } catch (err) {
    await finalizeSession(sessionId, 0, err.message);
    throw err;
  }
}

/**
 * Saves the Received Goods / Incoming Shelf-Life file.
 */
async function saveIncomingToDB(incomingRaw, fileName, progressCb) {
  const sessionId = await createSession("incoming", fileName);
  try {
    const rows = incomingRaw.map(r => ({
      session_id: sessionId,
      user_id:    getCurrentUser().id,
      data:       r,
    }));
    const { count, errors } = await batchInsert("incoming_rows", rows, progressCb);
    await finalizeSession(sessionId, count, errors.length ? errors[0].message : null);
    return { sessionId, count, errors };
  } catch (err) {
    await finalizeSession(sessionId, 0, err.message);
    throw err;
  }
}

/**
 * Saves the Material Standardization Mapping file.
 */
async function saveMappingToDB(mappingTable, fileName, progressCb) {
  const sessionId = await createSession("mapping", fileName);
  try {
    const rows = [...mappingTable.entries()].map(([sourceCode, m]) => ({
      session_id:  sessionId,
      user_id:     getCurrentUser().id,
      source_code: String(sourceCode).trim(),
      target_code: String(m.targetCode || "").trim(),
      target_desc: String(m.targetDesc || "").trim(),
      factor:      m.factor || 1,
    }));
    const { count, errors } = await batchInsert("mapping_rows", rows, progressCb);
    await finalizeSession(sessionId, count, errors.length ? errors[0].message : null);
    return { sessionId, count, errors };
  } catch (err) {
    await finalizeSession(sessionId, 0, err.message);
    throw err;
  }
}

// =============================================================================
//  7. LOAD LATEST DATA FROM DB (on sign-in / page refresh)
// =============================================================================

/**
 * Fetches the most recent complete dataset for each upload type from Supabase
 * and injects it into the in-memory state that script.js already manages.
 * Uses parallel requests for speed.
 */
async function loadLatestDataFromDB() {
  const sb   = getSupabase();
  const user = getCurrentUser();
  if (!user) return;

  // Find latest session IDs for each type (in parallel)
  const [invSession, transitSession, incomingSession, mappingSession] = await Promise.all([
    getLatestSession("inventory"),
    getLatestSession("transit"),
    getLatestSession("incoming"),
    getLatestSession("mapping"),
  ]);

  // ── Inventory ──────────────────────────────────────────────
  if (invSession) {
    dbSetStatus("fileStatus", "⏳ Loading inventory from database…");
    const { data: invRows, error: invErr } = await sb
      .from("inventory_rows")
      .select("*")
      .eq("session_id", invSession.id)
      .order("id");

    if (!invErr && invRows?.length) {
      const df = invRows.map(dbRowToAppRow);
      // Re-inject into script.js globals (they are var-scope on window)
      window.rawDf  = df;
      window.filtDf = df;
      if (typeof resetPageFilters  === "function") resetPageFilters();
      if (typeof recomputeIslMatch === "function") recomputeIslMatch();
      if (typeof populateAllFilters=== "function") populateAllFilters();
      if (typeof hideLanding       === "function") hideLanding();
      if (typeof renderPage        === "function") renderPage(window.currentPage || "dashboard");
      dbSetStatus("fileStatus", `✓ ${invSession.file_name} (${df.length.toLocaleString()} records) — from DB`);
    }
  }

  // ── Transit ────────────────────────────────────────────────
  if (transitSession) {
    const { data: tRows, error: tErr } = await sb
      .from("transit_rows")
      .select("data")
      .eq("session_id", transitSession.id);

    if (!tErr && tRows?.length) {
      window.stockTransitRaw = tRows.map(r => r.data);
      if (typeof recomputePhantomTransit === "function") recomputePhantomTransit();
      dbSetStatus("transitFileStatus", `✓ ${transitSession.file_name} (${tRows.length.toLocaleString()} rows) — from DB`);
    }
  }

  // ── Incoming ───────────────────────────────────────────────
  if (incomingSession) {
    const { data: iRows, error: iErr } = await sb
      .from("incoming_rows")
      .select("data")
      .eq("session_id", incomingSession.id);

    if (!iErr && iRows?.length) {
      window.incomingRaw = iRows.map(r => r.data);
      if (typeof recomputeIslMatch === "function") recomputeIslMatch();
      dbSetStatus("incomingFileStatus", `✓ ${incomingSession.file_name} (${iRows.length.toLocaleString()} rows) — from DB`);
    }
  }

  // ── Mapping ────────────────────────────────────────────────
  if (mappingSession) {
    const { data: mRows, error: mErr } = await sb
      .from("mapping_rows")
      .select("*")
      .eq("session_id", mappingSession.id);

    if (!mErr && mRows?.length) {
      const tbl = new Map();
      mRows.forEach(r => {
        tbl.set(r.source_code, {
          targetCode: r.target_code,
          targetDesc: r.target_desc,
          factor:     r.factor,
        });
      });
      window.mappingTable = tbl;
      if (typeof applyMaterialMapping === "function") applyMaterialMapping();
      dbSetStatus("mappingFileStatus", `✓ ${mappingSession.file_name} (${mRows.length.toLocaleString()} entries) — from DB`);
    }
  }
}

/**
 * Converts a DB inventory_rows record back to the shape script.js expects.
 */
function dbRowToAppRow(r) {
  const row = {
    "Material":                           r.material,
    "Material Description":               r.material_description,
    "Plant":                              r.plant,
    "Plant Name":                         r.plant_name,
    "Storage Location":                   r.storage_location,
    "Description of Storage Location":    r.storage_location_desc,
    "Special Stock Type":                 r.special_stock_type,
    "Special Stock Type Description":     r.special_stock_type_desc,
    "Batch":                              r.batch,
    "Inventory Valuation Type":           r.inventory_valuation_type,
    "Material Group Name":                r.material_group_name,
    "Unrestricted Stock":                 Number(r.unrestricted_stock   || 0),
    "Stock in Quality Inspection":        Number(r.stock_in_qi          || 0),
    "Blocked Stock":                      Number(r.blocked_stock        || 0),
    "Stock in Transit":                   Number(r.stock_in_transit     || 0),
    "Value of Unrestricted Stock":        Number(r.value_unrestricted   || 0),
    "Value of Stock in Transit":          Number(r.value_in_transit     || 0),
    "Value of Stock in Quality Inspection": Number(r.value_in_qi       || 0),
    "Total Value":                        Number(r.total_value          || 0),
    "Total Qty":                          Number(r.total_qty            || 0),
    "Shelf Life Expiration Date":         r.shelf_life_expiration_date  || "",
  };
  // Restore computed _expiry date used for watchlist calculations
  row._expiry = r.shelf_life_expiration_date
    ? (function() {
        const [y,m,d] = r.shelf_life_expiration_date.split("-");
        return new Date(+y, +m - 1, +d);
      })()
    : null;
  return row;
}

// =============================================================================
//  8. HOOKS — PATCH loadFile() ETC. AFTER script.js LOADS
// =============================================================================
// We wait for DOMContentLoaded so script.js has run and defined its functions.

document.addEventListener("DOMContentLoaded", () => {
  // ── Patch loadFile ─────────────────────────────────────────
  if (typeof window.loadFile === "function") {
    const _origLoadFile = window.loadFile.bind(window);
    window.loadFile = function(file) {
      _origLoadFile(file);

      // After a short delay the data will be in rawDf — persist it.
      // We poll until rawDf is populated (max 60 s).
      const startWait = Date.now();
      const poller = setInterval(async () => {
        if (!window.rawDf?.length) {
          if (Date.now() - startWait > 60000) clearInterval(poller);
          return;
        }
        clearInterval(poller);
        if (!getCurrentUser()) return;

        setDbSaving("fileStatus", "💾 Saving to database…");
        try {
          const { count, errors } = await saveInventoryToDB(
            window.rawDf,
            file.name,
            (done, total) => setDbProgress("fileStatus", done, total)
          );
          const warn = errors.length ? ` (${errors.length} chunk errors)` : "";
          setDbSaved("fileStatus", `Saved ${count.toLocaleString()} rows${warn}`);
        } catch (err) {
          console.error("Inventory save failed:", err);
          setDbError("fileStatus", err.message);
        }
      }, 200);
    };
  }

  // ── Patch transit file input ───────────────────────────────
  patchFileInput("transitFileInput", "transitFileStatus", async (file, rawRows) => {
    await saveTransitToDB(rawRows, file.name);
  }, () => window.stockTransitRaw);

  // ── Patch incoming file input ──────────────────────────────
  patchFileInput("incomingFileInput", "incomingFileStatus", async (file, rawRows) => {
    await saveIncomingToDB(rawRows, file.name);
  }, () => window.incomingRaw);

  // ── Patch mapping file input ───────────────────────────────
  patchFileInput("mappingFileInput", "mappingFileStatus", async (file) => {
    if (window.mappingTable?.size) {
      await saveMappingToDB(window.mappingTable, file.name);
    }
  }, () => null);
});

/**
 * Wraps a file <input>'s change event to persist to DB after script.js processes it.
 */
function patchFileInput(inputId, statusId, saveFn, getDataFn) {
  const input = document.getElementById(inputId);
  if (!input) return;

  input.addEventListener("change", async () => {
    if (!getCurrentUser() || !input.files[0]) return;
    const file = input.files[0];

    // Give script.js ~2 s to process the file, then persist
    setTimeout(async () => {
      const data = getDataFn ? getDataFn() : null;
      if (data !== null && (!Array.isArray(data) || !data.length)) return;

      setDbSaving(statusId, "💾 Saving to database…");
      try {
        await saveFn(file, data);
        setDbSaved(statusId, "Saved to database");
      } catch (err) {
        console.error(`${inputId} save failed:`, err);
        setDbError(statusId, err.message);
      }
    }, 2000);
  }, { capture: true });
}

// =============================================================================
//  9. STATUS UI HELPERS
// =============================================================================

function dbSetStatus(elId, msg) {
  const el = document.getElementById(elId);
  if (!el) return;
  // Append a db-status line below the existing content
  let dbLine = el.querySelector(".db-status-line");
  if (!dbLine) {
    dbLine = document.createElement("div");
    dbLine.className = "db-status-line";
    dbLine.style.cssText = "font-size:0.68rem;color:var(--muted);margin-top:3px;";
    el.appendChild(dbLine);
  }
  dbLine.textContent = msg;
}

function setDbSaving(elId, msg) { dbSetStatus(elId, msg); }

function setDbProgress(elId, done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  dbSetStatus(elId, `💾 Saving… ${pct}% (${done.toLocaleString()} / ${total.toLocaleString()} rows)`);
}

function setDbSaved(elId, msg) {
  dbSetStatus(elId, `✓ DB: ${msg}`);
}

function setDbError(elId, msg) {
  dbSetStatus(elId, `⚠ DB error: ${msg}`);
}

// =============================================================================
//  10. AUTH OVERLAY UI
// =============================================================================

function showAuthOverlay() {
  let overlay = document.getElementById("auth-overlay");
  if (!overlay) { overlay = buildAuthOverlay(); document.body.appendChild(overlay); }
  overlay.style.display = "flex";
  document.getElementById("sidebar")?.classList.add("auth-hidden");
  document.getElementById("main")?.classList.add("auth-hidden");
  document.getElementById("theme-toggle")?.classList.add("auth-hidden");
}

function hideAuthOverlay() {
  const overlay = document.getElementById("auth-overlay");
  if (overlay) overlay.style.display = "none";
  document.getElementById("sidebar")?.classList.remove("auth-hidden");
  document.getElementById("main")?.classList.remove("auth-hidden");
  document.getElementById("theme-toggle")?.classList.remove("auth-hidden");
}

function updateUserBadge() {
  const profile = getCurrentProfile() || { email: getCurrentUser()?.email || "" };
  let badge = document.getElementById("user-badge");
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "user-badge";
    badge.style.cssText = `
      position: fixed;
      bottom: 1rem;
      left: 0;
      width: var(--sidebar-w, 248px);
      padding: 0.55rem 1rem;
      font-size: 0.72rem;
      color: var(--muted);
      border-top: 1px solid var(--border);
      background: var(--surface);
      display: flex;
      align-items: center;
      gap: 0.5rem;
      z-index: 110;
    `;
    document.body.appendChild(badge);
  }

  const initials = (profile.full_name || profile.email || "?")
    .split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();

  badge.innerHTML = `
    <span style="
      width:26px;height:26px;border-radius:50%;background:var(--blue);
      color:#fff;font-weight:700;display:inline-flex;align-items:center;
      justify-content:center;font-size:0.7rem;flex-shrink:0;
    ">${initials}</span>
    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">
      ${escHtmlAuth(profile.full_name || profile.email)}
    </span>
    <button onclick="doSignOut()" title="Sign out" style="
      background:none;border:none;color:var(--muted);cursor:pointer;
      font-size:0.8rem;padding:2px 4px;flex-shrink:0;
    ">⎋</button>
  `;
}

async function doSignOut() {
  await signOut();
  const badge = document.getElementById("user-badge");
  if (badge) badge.remove();
}

function buildAuthOverlay() {
  const overlay = document.createElement("div");
  overlay.id = "auth-overlay";
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:9999;
    display:flex;align-items:center;justify-content:center;
    background:var(--bg, #07090d);
  `;

  overlay.innerHTML = `
    <div id="auth-card" style="
      background:var(--surface,#0e1420);
      border:1px solid var(--border,#1f2e44);
      border-radius:14px;
      padding:2.2rem 2.4rem;
      width:min(420px,92vw);
      box-shadow:0 24px 60px rgba(0,0,0,0.55);
      font-family:'Plus Jakarta Sans','Inter',sans-serif;
    ">
      <!-- Logo / title -->
      <div style="text-align:center;margin-bottom:1.6rem">
        <div style="font-size:2rem;margin-bottom:0.3rem">💊</div>
        <div style="font-size:1.18rem;font-weight:700;color:var(--text,#dce8f5)">
          PharmaTrack
        </div>
        <div style="font-size:0.75rem;color:var(--muted,#7a9ab8);margin-top:2px">
          Inventory Management — Stock-Multiple
        </div>
      </div>

      <!-- Tab row -->
      <div id="auth-tabs" style="
        display:flex;gap:0;margin-bottom:1.4rem;
        border-bottom:1px solid var(--border,#1f2e44);
      ">
        <button onclick="showAuthTab('signin')" id="tab-signin" class="auth-tab auth-tab-active"
          style="flex:1;padding:.5rem;background:none;border:none;cursor:pointer;
            font-size:.83rem;font-weight:600;color:var(--blue,#3d94e0);
            border-bottom:2px solid var(--blue,#3d94e0);transition:all .2s">
          Sign In
        </button>
        <button onclick="showAuthTab('signup')" id="tab-signup" class="auth-tab"
          style="flex:1;padding:.5rem;background:none;border:none;cursor:pointer;
            font-size:.83rem;font-weight:600;color:var(--muted,#7a9ab8);
            border-bottom:2px solid transparent;transition:all .2s">
          Sign Up
        </button>
        <button onclick="showAuthTab('reset')" id="tab-reset" class="auth-tab"
          style="flex:1;padding:.5rem;background:none;border:none;cursor:pointer;
            font-size:.83rem;font-weight:600;color:var(--muted,#7a9ab8);
            border-bottom:2px solid transparent;transition:all .2s">
          Reset
        </button>
      </div>

      <!-- Error / success banner -->
      <div id="auth-msg" style="
        display:none;margin-bottom:1rem;padding:.55rem .8rem;border-radius:7px;
        font-size:.78rem;font-weight:500;
      "></div>

      <!-- ── Sign In ── -->
      <div id="auth-signin">
        <label class="auth-label">Email</label>
        <input id="si-email" type="email" placeholder="you@example.com" class="auth-input" />
        <label class="auth-label" style="margin-top:.8rem">Password</label>
        <input id="si-pass"  type="password" placeholder="••••••••"      class="auth-input" />
        <button onclick="doSignIn()" class="auth-submit">Sign In</button>
      </div>

      <!-- ── Sign Up ── -->
      <div id="auth-signup" style="display:none">
        <label class="auth-label">Full Name</label>
        <input id="su-name"  type="text"     placeholder="Your Name"    class="auth-input" />
        <label class="auth-label" style="margin-top:.8rem">Email</label>
        <input id="su-email" type="email"    placeholder="you@example.com" class="auth-input" />
        <label class="auth-label" style="margin-top:.8rem">Password</label>
        <input id="su-pass"  type="password" placeholder="Min 6 chars"  class="auth-input" />
        <button onclick="doSignUp()" class="auth-submit">Create Account</button>
      </div>

      <!-- ── Reset ── -->
      <div id="auth-reset" style="display:none">
        <p style="font-size:.78rem;color:var(--muted);margin-bottom:.9rem">
          Enter your email and we'll send a reset link.
        </p>
        <label class="auth-label">Email</label>
        <input id="rp-email" type="email" placeholder="you@example.com" class="auth-input" />
        <button onclick="doReset()" class="auth-submit">Send Reset Link</button>
      </div>

      <!-- Spinner -->
      <div id="auth-spinner" style="display:none;text-align:center;margin-top:.8rem;
        font-size:.78rem;color:var(--muted)">⏳ Please wait…</div>
    </div>

    <style>
      .auth-label {
        display:block;font-size:.72rem;font-weight:600;
        color:var(--muted,#7a9ab8);margin-bottom:.3rem;
      }
      .auth-input {
        width:100%;padding:.55rem .75rem;
        background:var(--surface2,#141c2b);
        border:1px solid var(--border,#1f2e44);
        border-radius:7px;color:var(--text,#dce8f5);
        font-size:.85rem;font-family:inherit;
        outline:none;transition:border-color .2s;box-sizing:border-box;
      }
      .auth-input:focus { border-color:var(--blue,#3d94e0); }
      .auth-submit {
        width:100%;margin-top:1.1rem;padding:.65rem;
        background:var(--blue,#3d94e0);color:#fff;
        border:none;border-radius:8px;font-size:.88rem;
        font-weight:600;cursor:pointer;font-family:inherit;
        transition:opacity .2s;
      }
      .auth-submit:hover { opacity:.88; }
      .auth-hidden { display:none !important; }
    </style>
  `;
  return overlay;
}

// ── Auth tab switcher ──────────────────────────────────────────────────────
window.showAuthTab = function(tab) {
  ["signin","signup","reset"].forEach(t => {
    const panel = document.getElementById(`auth-${t}`);
    const btn   = document.getElementById(`tab-${t}`);
    if (!panel || !btn) return;
    const active = t === tab;
    panel.style.display          = active ? "block" : "none";
    btn.style.color              = active ? "var(--blue,#3d94e0)" : "var(--muted,#7a9ab8)";
    btn.style.fontWeight         = active ? "700" : "600";
    btn.style.borderBottomColor  = active ? "var(--blue,#3d94e0)" : "transparent";
  });
  clearAuthMsg();
};

// ── Auth action handlers ───────────────────────────────────────────────────
window.doSignIn = async function() {
  const email = document.getElementById("si-email")?.value.trim();
  const pass  = document.getElementById("si-pass")?.value;
  if (!email || !pass) { showAuthMsg("Please enter your email and password.", "error"); return; }
  showAuthSpinner(true);
  try {
    await signIn(email, pass);
    // onAuthStateChange fires → hideAuthOverlay() called automatically
  } catch (err) {
    showAuthMsg(err.message, "error");
  } finally {
    showAuthSpinner(false);
  }
};

window.doSignUp = async function() {
  const name  = document.getElementById("su-name")?.value.trim();
  const email = document.getElementById("su-email")?.value.trim();
  const pass  = document.getElementById("su-pass")?.value;
  if (!email || !pass) { showAuthMsg("Email and password are required.", "error"); return; }
  if (pass.length < 6) { showAuthMsg("Password must be at least 6 characters.", "error"); return; }
  showAuthSpinner(true);
  try {
    await signUp(email, pass, name);
    showAuthMsg("Account created! Check your email to confirm, then sign in.", "success");
    showAuthTab("signin");
  } catch (err) {
    showAuthMsg(err.message, "error");
  } finally {
    showAuthSpinner(false);
  }
};

window.doReset = async function() {
  const email = document.getElementById("rp-email")?.value.trim();
  if (!email) { showAuthMsg("Enter your email address.", "error"); return; }
  showAuthSpinner(true);
  try {
    await resetPassword(email);
    showAuthMsg("Reset link sent — check your inbox.", "success");
  } catch (err) {
    showAuthMsg(err.message, "error");
  } finally {
    showAuthSpinner(false);
  }
};

function showAuthMsg(msg, type) {
  const el = document.getElementById("auth-msg");
  if (!el) return;
  el.textContent = msg;
  el.style.display     = "block";
  el.style.background  = type === "error" ? "rgba(224,69,69,.15)" : "rgba(48,168,95,.15)";
  el.style.color       = type === "error" ? "var(--red,#e04545)"  : "var(--green,#30a85f)";
  el.style.border      = `1px solid ${type === "error" ? "rgba(224,69,69,.3)" : "rgba(48,168,95,.3)"}`;
}

function clearAuthMsg() {
  const el = document.getElementById("auth-msg");
  if (el) { el.style.display = "none"; el.textContent = ""; }
}

function showAuthSpinner(on) {
  const el = document.getElementById("auth-spinner");
  if (el) el.style.display = on ? "block" : "none";
}

// Minimal escHtml for auth layer (script.js version may not be available yet)
function escHtmlAuth(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// =============================================================================
//  11. BOOT
// =============================================================================

// Kick off auth listener as soon as the script runs (before DOMContentLoaded)
// so we handle the initial session from localStorage without any flash.
try {
  getSupabase();   // initialise client
  initAuthListener();
} catch (e) {
  console.error("Supabase init failed:", e.message);
}
