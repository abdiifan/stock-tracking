// =============================================================================
// PharmaTrack v2 — auth.js
// Supabase Authentication layer.
// Must be loaded BEFORE filters.js and script.js.
//
// Setup:
//   1. Create a free project at https://supabase.com
//   2. Replace SUPABASE_URL and SUPABASE_ANON_KEY below with your project values
//      (Settings → API in the Supabase dashboard)
//   3. In Supabase → Authentication → URL Configuration, add your site URL
//      to "Redirect URLs"
// =============================================================================

// ── CONFIG ────────────────────────────────────────────────────────────────────
const SUPABASE_URL      = "https://YOUR_PROJECT.supabase.co";   // ← replace
const SUPABASE_ANON_KEY = "YOUR_ANON_KEY";                       // ← replace

// ── SUPABASE CLIENT ───────────────────────────────────────────────────────────
// Loaded via CDN in index.html (supabase-js v2).
// window._supabase is set here so script.js can call it for DB saves.
let _supabase = null;

function getSupabase() {
  if (_supabase) return _supabase;
  if (!window.supabase) {
    console.error("Supabase JS not loaded. Check the <script> tag in index.html.");
    return null;
  }
  _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _supabase;
}

// ── STATE ─────────────────────────────────────────────────────────────────────
let _currentUser = null;

// ── RENDER HELPERS ────────────────────────────────────────────────────────────
function _authCSS() {
  if (document.getElementById("_auth-styles")) return;
  const s = document.createElement("style");
  s.id = "_auth-styles";
  s.textContent = `
    /* Auth overlay */
    #auth-overlay {
      position: fixed; inset: 0; z-index: 9999;
      background: var(--bg, #07090d);
      display: flex; align-items: center; justify-content: center;
      font-family: 'Plus Jakarta Sans', 'Inter', sans-serif;
    }
    #auth-card {
      background: var(--surface, #0e1420);
      border: 1px solid var(--border, #1f2e44);
      border-radius: 14px;
      padding: 2.5rem 2.4rem 2.2rem;
      width: 100%; max-width: 400px;
      box-shadow: 0 24px 60px rgba(0,0,0,0.5);
      display: flex; flex-direction: column; gap: 1.4rem;
    }
    #auth-card .auth-logo {
      text-align: center;
      font-size: 1.55rem; font-weight: 800;
      color: var(--text, #dce8f5);
      letter-spacing: -0.03em;
    }
    #auth-card .auth-logo span {
      color: var(--blue, #3d94e0);
    }
    #auth-card .auth-sub {
      text-align: center; margin-top: -0.8rem;
      font-size: 0.78rem; color: var(--muted, #7a9ab8);
    }
    #auth-card .auth-tabs {
      display: flex; border-bottom: 1px solid var(--border, #1f2e44);
      gap: 0;
    }
    #auth-card .auth-tab {
      flex: 1; padding: 0.55rem 0; font-size: 0.82rem; font-weight: 600;
      cursor: pointer; background: none; border: none;
      color: var(--muted, #7a9ab8);
      border-bottom: 2px solid transparent; margin-bottom: -1px;
      transition: color 0.18s, border-color 0.18s;
    }
    #auth-card .auth-tab.active {
      color: var(--blue, #3d94e0);
      border-bottom-color: var(--blue, #3d94e0);
    }
    #auth-card .auth-field {
      display: flex; flex-direction: column; gap: 0.38rem;
    }
    #auth-card label {
      font-size: 0.73rem; font-weight: 600;
      color: var(--muted, #7a9ab8); letter-spacing: 0.04em; text-transform: uppercase;
    }
    #auth-card input[type="email"],
    #auth-card input[type="password"],
    #auth-card input[type="text"] {
      background: var(--surface2, #141c2b);
      border: 1px solid var(--border, #1f2e44);
      border-radius: 8px;
      color: var(--text, #dce8f5);
      font-size: 0.88rem; font-family: inherit;
      padding: 0.65rem 0.85rem;
      outline: none; width: 100%;
      transition: border-color 0.18s, box-shadow 0.18s;
    }
    #auth-card input:focus {
      border-color: var(--blue, #3d94e0);
      box-shadow: 0 0 0 3px var(--blue-glow, rgba(61,148,224,0.22));
    }
    #auth-card .auth-btn {
      background: var(--blue, #3d94e0);
      color: #fff; border: none; border-radius: 8px;
      font-size: 0.88rem; font-weight: 700; font-family: inherit;
      padding: 0.72rem 1rem; cursor: pointer; width: 100%;
      transition: opacity 0.18s, transform 0.1s;
    }
    #auth-card .auth-btn:hover { opacity: 0.88; }
    #auth-card .auth-btn:active { transform: scale(0.98); }
    #auth-card .auth-btn:disabled { opacity: 0.5; cursor: default; }

    #auth-card .auth-msg {
      font-size: 0.78rem; padding: 0.6rem 0.85rem;
      border-radius: 7px; display: none;
    }
    #auth-card .auth-msg.error  { display:block; background:rgba(224,69,69,0.12); color:#e04545; }
    #auth-card .auth-msg.success{ display:block; background:rgba(48,168,95,0.12); color:#30a85f; }

    /* User pill in sidebar */
    #auth-user-pill {
      display: flex; align-items: center; gap: 0.55rem;
      padding: 0.55rem 0.75rem;
      background: var(--surface2, #141c2b);
      border: 1px solid var(--border, #1f2e44);
      border-radius: 8px; margin-top: auto;
    }
    #auth-user-pill .pill-avatar {
      width: 28px; height: 28px; border-radius: 50%;
      background: var(--blue, #3d94e0);
      display: flex; align-items: center; justify-content: center;
      font-size: 0.78rem; font-weight: 700; color: #fff; flex-shrink: 0;
    }
    #auth-user-pill .pill-email {
      font-size: 0.72rem; color: var(--muted, #7a9ab8);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;
    }
    #auth-user-pill .pill-logout {
      background: none; border: none; cursor: pointer;
      color: var(--dim, #4a6275); font-size: 0.85rem; padding: 0.15rem;
      transition: color 0.15s; flex-shrink: 0;
    }
    #auth-user-pill .pill-logout:hover { color: var(--red, #e04545); }
  `;
  document.head.appendChild(s);
}

// ── AUTH OVERLAY ──────────────────────────────────────────────────────────────
function _showAuthOverlay() {
  _authCSS();
  if (document.getElementById("auth-overlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "auth-overlay";
  overlay.innerHTML = `
    <div id="auth-card">
      <div class="auth-logo">Stock-<span>Multiple</span>Track</div>
      <div class="auth-sub">EPSS Pharmaceutical Inventory — Sign in to continue</div>

      <div class="auth-tabs">
        <button class="auth-tab active" id="tab-signin" type="button">Sign in</button>
        <button class="auth-tab"        id="tab-signup" type="button">Create account</button>
      </div>

      <!-- Sign In -->
      <div id="panel-signin">
        <div style="display:flex;flex-direction:column;gap:1rem">
          <div class="auth-field">
            <label for="si-email">Email</label>
            <input type="email" id="si-email" placeholder="you@epss.gov.et" autocomplete="email" />
          </div>
          <div class="auth-field">
            <label for="si-pass">Password</label>
            <input type="password" id="si-pass" placeholder="••••••••" autocomplete="current-password" />
          </div>
          <div class="auth-msg" id="si-msg"></div>
          <button class="auth-btn" id="si-submit">Sign in</button>
        </div>
      </div>

      <!-- Sign Up -->
      <div id="panel-signup" style="display:none">
        <div style="display:flex;flex-direction:column;gap:1rem">
          <div class="auth-field">
            <label for="su-name">Full name</label>
            <input type="text" id="su-name" placeholder="Selam Tadesse" autocomplete="name" />
          </div>
          <div class="auth-field">
            <label for="su-email">Email</label>
            <input type="email" id="su-email" placeholder="you@epss.gov.et" autocomplete="email" />
          </div>
          <div class="auth-field">
            <label for="su-pass">Password <span style="font-weight:400;text-transform:none;letter-spacing:0">(min 8 chars)</span></label>
            <input type="password" id="su-pass" placeholder="••••••••" autocomplete="new-password" />
          </div>
          <div class="auth-msg" id="su-msg"></div>
          <button class="auth-btn" id="su-submit">Create account</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // ── Tab switching
  document.getElementById("tab-signin").onclick = () => _switchTab("signin");
  document.getElementById("tab-signup").onclick = () => _switchTab("signup");

  // ── Sign in
  document.getElementById("si-submit").onclick = _handleSignIn;
  document.getElementById("si-pass").addEventListener("keydown", e => {
    if (e.key === "Enter") _handleSignIn();
  });

  // ── Sign up
  document.getElementById("su-submit").onclick = _handleSignUp;


}

function _switchTab(tab) {
  const isSign = tab === "signin";
  document.getElementById("tab-signin").classList.toggle("active", isSign);
  document.getElementById("tab-signup").classList.toggle("active", !isSign);
  document.getElementById("panel-signin").style.display = isSign  ? "" : "none";
  document.getElementById("panel-signup").style.display = !isSign ? "" : "none";
}

function _setMsg(id, text, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = `auth-msg ${type}`;
}

function _setBusy(btnId, busy) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = busy;
  if (busy) { btn._orig = btn.textContent; btn.textContent = "Please wait…"; }
  else if (btn._orig) btn.textContent = btn._orig;
}

async function _handleSignIn() {
  const sb    = getSupabase(); if (!sb) return;
  const email = (document.getElementById("si-email")?.value || "").trim();
  const pass  =  document.getElementById("si-pass")?.value  || "";
  if (!email || !pass) { _setMsg("si-msg", "Enter your email and password.", "error"); return; }

  _setBusy("si-submit", true);
  const { error } = await sb.auth.signInWithPassword({ email, password: pass });
  _setBusy("si-submit", false);

  if (error) { _setMsg("si-msg", error.message, "error"); }
  // success is handled by the onAuthStateChange listener
}

async function _handleSignUp() {
  const sb    = getSupabase(); if (!sb) return;
  const name  = (document.getElementById("su-name")?.value  || "").trim();
  const email = (document.getElementById("su-email")?.value || "").trim();
  const pass  =  document.getElementById("su-pass")?.value  || "";
  if (!email || !pass) { _setMsg("su-msg", "Email and password are required.", "error"); return; }
  if (pass.length < 8)  { _setMsg("su-msg", "Password must be at least 8 characters.", "error"); return; }

  _setBusy("su-submit", true);
  const { error } = await sb.auth.signUp({
    email, password: pass,
    options: { data: { full_name: name } },
  });
  _setBusy("su-submit", false);

  if (error) {
    _setMsg("su-msg", error.message, "error");
  } else {
    _setMsg("su-msg", "Check your email for a confirmation link.", "success");
  }
}

async function _handleGoogle() {
  const sb = getSupabase(); if (!sb) return;
  await sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.href },
  });
}

// ── USER PILL in sidebar ──────────────────────────────────────────────────────
function _renderUserPill(user, role) {
  _authCSS();
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;

  let pill = document.getElementById("auth-user-pill");
  if (!pill) {
    pill = document.createElement("div");
    pill.id = "auth-user-pill";
    sidebar.appendChild(pill);
  }

  const email      = user.email || "";
  const initial    = email.charAt(0).toUpperCase();
  const isAdmin    = role === "admin";
  const badgeColor = isAdmin ? "var(--blue,#3d94e0)" : "var(--dim,#4a6275)";
  const badgeLabel = isAdmin ? "Admin" : "Viewer";

  pill.innerHTML = `
    <div class="pill-avatar">${initial}</div>
    <div style="flex:1;overflow:hidden">
      <div class="pill-email" title="${email}">${email}</div>
      <div style="font-size:0.65rem;font-weight:700;color:${badgeColor};letter-spacing:0.05em;margin-top:1px">
        ${badgeLabel}
      </div>
    </div>
    <button class="pill-logout" id="auth-logout-btn" title="Sign out">⏻</button>
  `;
  document.getElementById("auth-logout-btn").onclick = async () => {
    const sb = getSupabase(); if (!sb) return;
    await sb.auth.signOut();
  };
}

function _removePill() {
  document.getElementById("auth-user-pill")?.remove();
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
async function authBoot() {
  const sb = getSupabase();
  if (!sb) {
    // Supabase not configured — skip auth and load app directly.
    console.warn("auth.js: Supabase not configured. Running without authentication.");
    return;
  }

  // Listen for auth state changes (sign-in, sign-out, token refresh)
  sb.auth.onAuthStateChange(async (_event, session) => {
    if (session?.user) {
      _currentUser = session.user;
      document.getElementById("auth-overlay")?.remove();

      // Fetch this user's role from user_roles table
      const role = await _fetchRole(session.user.id);
      window.__pharmaRole = role;          // 'admin' | 'viewer'
      window.__pharmaUser = session.user;

      _renderUserPill(session.user, role);
      _applyRoleRestrictions(role);
    } else {
      _currentUser = null;
      _removePill();
      window.__pharmaUser = null;
      window.__pharmaRole = null;
      _showAuthOverlay();
    }
  });

  // Check for existing session on page load
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    _showAuthOverlay();
  }
}

// ── ROLE HELPERS ──────────────────────────────────────────────────────────────

/**
 * Fetches the role for a given user id from user_roles.
 * Returns 'viewer' if no row exists (safe default).
 */
async function _fetchRole(userId) {
  const sb = getSupabase();
  if (!sb) return "viewer";
  const { data } = await sb
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .single();
  return data?.role || "viewer";
}

/**
 * Hides all upload controls for viewers.
 * Upload label wrappers in the sidebar all use class="upload-btn" or
 * specific ids — we hide the entire sidebar upload sections.
 */
function _applyRoleRestrictions(role) {
  // Run after DOM is ready
  const apply = () => {
    const isViewer = role !== "admin";

    // All four upload sections: inventory, incoming, transit, mapping
    const uploadSections = [
      "fileInput", "incomingFileInput", "transitFileInput", "mappingFileInput"
    ];

    uploadSections.forEach(inputId => {
      // Walk up to the <label> wrapper and its sibling status div
      const input = document.getElementById(inputId);
      if (!input) return;
      const label = input.closest("label");
      if (label) label.style.display = isViewer ? "none" : "";
    });

    // Also hide the upload section headers and status divs for viewers
    const uploadLabels = document.querySelectorAll(".upload-label");
    uploadLabels.forEach(el => {
      el.style.display = isViewer ? "none" : "";
    });

    const statusDivs = ["fileStatus","incomingFileStatus","transitFileStatus","mappingFileStatus"];
    statusDivs.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = isViewer ? "none" : "";
    });

    // Show a viewer notice in the sidebar where uploads were
    if (isViewer) {
      const sidebar = document.getElementById("sidebar");
      if (sidebar && !document.getElementById("viewer-notice")) {
        const notice = document.createElement("div");
        notice.id = "viewer-notice";
        notice.style.cssText = `
          font-size:0.72rem; color:var(--muted,#7a9ab8);
          background:var(--surface2,#141c2b);
          border:1px solid var(--border,#1f2e44);
          border-radius:8px; padding:0.6rem 0.8rem;
          margin-top:0.5rem; line-height:1.5;
        `;
        notice.textContent = "👁 View-only access. Contact your admin to upload data.";
        // Insert before the user pill
        const pill = document.getElementById("auth-user-pill");
        sidebar.insertBefore(notice, pill || null);
      }
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", apply);
  } else {
    apply();
  }
}

/**
 * Exposed helper — lets script.js check the role before any action.
 * Usage:  if (!isAdmin()) return;
 */
function isAdmin() {
  return window.__pharmaRole === "admin";
}

// ── DB HELPERS (callable from script.js) ─────────────────────────────────────
/**
 * Saves a named snapshot of the current inventory data to Supabase.
 * Rows are stored as JSONB; max ~4 MB per row (Supabase limit).
 *
 * Usage in script.js:
 *   await saveSnapshot("Main Inventory 2025-Q2", rawDf);
 */
async function saveSnapshot(label, rows) {
  const sb   = getSupabase(); if (!sb) return { error: "Supabase not ready" };
  const user = _currentUser;  if (!user) return { error: "Not signed in" };

  return sb.from("snapshots").insert({
    user_id:    user.id,
    label:      label,
    row_count:  rows.length,
    data:       rows,             // stored as JSONB
    created_at: new Date().toISOString(),
  });
}

/**
 * Lists saved snapshots for the current user (most recent first).
 */
async function listSnapshots() {
  const sb   = getSupabase(); if (!sb) return { data: [], error: "not ready" };
  const user = _currentUser;  if (!user) return { data: [], error: "not signed in" };

  return sb.from("snapshots")
    .select("id, label, row_count, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(20);
}

/**
 * Loads rows from a saved snapshot by id.
 */
async function loadSnapshot(id) {
  const sb   = getSupabase(); if (!sb) return { data: null, error: "not ready" };
  const user = _currentUser;  if (!user) return { data: null, error: "not signed in" };

  return sb.from("snapshots")
    .select("data, label")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();
}

// ── INIT ──────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", authBoot);
