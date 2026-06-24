// ── CONSTANTS ──────────────────────────────────────────────────────────────
const REQUIRED_COLUMNS = [
  "Material","Material Description","Plant","Plant Name",
  "Storage Location","Description of Storage Location",
  "Special Stock Type","Special Stock Type Description",
  "Unrestricted Stock","Stock in Quality Inspection","Blocked Stock",
  "Batch","Inventory Valuation Type","Material Group Name",
  "Shelf Life Expiration Date","Stock in Transit",
  "Value of Stock in Quality Inspection","Value of Stock in Transit",
  "Value of Unrestricted Stock",
];

const COLORWAY = ["#3a8fd4","#2e9e5a","#c47f17","#d94040","#8763cc","#5cbfdb","#4db87a","#e09b2d","#e86060","#a78bde","#59b8f5","#70ce94"];

/**
 * Injects ⬇ CSV and ⬇ Excel buttons into a container div (by id).
 * Used to place download buttons directly above each page's table.
 */
function injectDlButtons(rowId, onCsv, onXlsx) {
  const row = document.getElementById(rowId);
  if (!row) return;
  row.innerHTML = '<button class="dl-btn">⬇ CSV</button><button class="dl-btn">⬇ Excel</button>';
  row.querySelectorAll(".dl-btn")[0].onclick = onCsv;
  row.querySelectorAll(".dl-btn")[1].onclick = onXlsx;
}

// NOTE: Exclusion rules (isNonMedicalCode, isNonMedicalGroup) are loaded from
// filters.js which MUST be included before this script in the HTML.
/**
 * Shows a brief toast notification confirming the Branch Comparison drilldown.
 * Auto-dismisses after 4 seconds.
 */
function showSpreadDrilldownToast(count, groupLabel) {
  // Remove any existing toast first
  const existing = document.getElementById("spread-drilldown-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "spread-drilldown-toast";
  toast.innerHTML = `
    <span style="font-size:1.1em">🎯</span>
    <span>Showing <strong>${count}</strong> material${count !== 1 ? "s" : ""} stocked in <strong>${escHtml(groupLabel)}</strong> — filtered from Stock Concentration</span>
    <button onclick="this.parentElement.remove()" style="margin-left:auto;background:none;border:none;color:inherit;cursor:pointer;font-size:1rem;opacity:0.7;padding:0 0.25rem" title="Dismiss">✕</button>
  `;
  Object.assign(toast.style, {
    position:       "fixed",
    bottom:         "1.5rem",
    left:           "50%",
    transform:      "translateX(-50%)",
    background:     "var(--blue, #3a8fd4)",
    color:          "#fff",
    padding:        "0.65rem 1.1rem",
    borderRadius:   "8px",
    boxShadow:      "0 4px 18px rgba(0,0,0,0.35)",
    display:        "flex",
    alignItems:     "center",
    gap:            "0.6rem",
    fontSize:       "0.82rem",
    fontFamily:     "Inter, sans-serif",
    zIndex:         "9999",
    maxWidth:       "520px",
    animation:      "fadeInUp 0.25s ease",
    pointerEvents:  "auto",
  });
  document.body.appendChild(toast);
  setTimeout(() => { if (toast.parentElement) toast.remove(); }, 4500);
}

// ── THEME-AWARE PLOTLY LAYOUT ─────────────────────────────────────────────
// Reads CSS vars at call time so chart colours match the active theme.
function getPlotlyThemeColors() {
  const s = getComputedStyle(document.documentElement);
  const get = v => s.getPropertyValue(v).trim();
  return {
    grid:   get('--border')  || '#1e2e3d',
    muted:  get('--muted')   || '#7a97b0',
    bg:     'rgba(0,0,0,0)',
  };
}

const PLOTLY_LAYOUT = {
  paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
  font: { family: "Inter, IBM Plex Sans, sans-serif", color: "#7a97b0", size: 12 },
  xaxis: { gridcolor: "#1e2e3d", zerolinecolor: "#1e2e3d", tickfont: { color: "#7a97b0" } },
  yaxis: { gridcolor: "#1e2e3d", zerolinecolor: "#1e2e3d", tickfont: { color: "#7a97b0" } },
  legend: { bgcolor: "rgba(0,0,0,0)", font: { color: "#7a97b0" } },
  margin: { l: 20, r: 20, t: 40, b: 40 },
  colorway: COLORWAY,
};
const PLOTLY_CONFIG = { displayModeBar: false, responsive: true };

// ── STATE ──────────────────────────────────────────────────────────────────
let rawDf  = [];
let filtDf = [];
let currentPage = "dashboard";

// Stock-in-Transit separate file state
let stockTransitRaw    = [];   // raw rows from the transit xlsx
let stFilterState      = { purDoc: "", supPlant: "" };  // filter state

// Incoming Shelf Life — received goods file state
let incomingRaw        = [];   // raw rows from received goods xlsx
const islFilterState   = { date: "", valType: "", sloc: "", mg: "", materials: [] };

// Page-level filter state — now arrays for multi-select support
const pageFilters = {
  dashboard: { plants: [], mgs: [], valTypes: [] },
  transit:   { plants: [], mgs: [], valTypes: [], materials: [] },
  expiry:    { plants: [], mgs: [], valTypes: [], materials: [] },
  qc:        { plants: [], mgs: [], valTypes: [], materials: [] },
  branch:    { mgs: [],             valTypes: [], materials: [] },
  flow:      { plants: [], mgs: [], valTypes: [], materials: [] },
  incoming:  {},
  concentration: { mgs: [], valTypes: [] },
};

// ── SPREAD CHART DRILLDOWN STATE ──────────────────────────────────────────
// Stores the last matConcentration array from renderConcentration() so that a
// bar-click can hand off the selected plant-count group to Branch Comparison.
let _lastSpreadDrilldown = null;   // { plantCount, matCodes[] } | null

// ── MATERIAL STANDARDIZATION MAPPING STATE ─────────────────────────────────
// mappingTable: Map<sourceCode → { targetCode, targetDesc, factor }>
let mappingTable   = new Map();   // populated when mapping file is uploaded
let mappedDf       = [];          // rawDf rows after applyMaterialMapping()
let mappingStats   = null;        // { mapped, total, valuePct } — shown in sidebar

// Returns the base dataset with material standardization applied (if mapping loaded).
function getReconciledBase() {
  return mappingTable.size > 0 ? mappedDf : rawDf;
}

// FIX BUG-3: reset all page filters when a new file is loaded so stale plant/MG
// values from the previous file can never produce a blank result set.
function resetPageFilters() {
  // BUG-RESET FIX: guard against pages (e.g. "branch") that have no "plants" key
  // BUG-FIX-2: also guard mgs/valTypes keys so "incoming: {}" never gets phantom slots
  Object.keys(pageFilters).forEach(page => {
    if ("plants"    in pageFilters[page]) pageFilters[page].plants    = [];
    if ("mgs"       in pageFilters[page]) pageFilters[page].mgs       = [];
    if ("valTypes"  in pageFilters[page]) pageFilters[page].valTypes  = [];
    if ("materials" in pageFilters[page]) pageFilters[page].materials = [];
  });
  islFilterState.materials = [];
}

// ── FORMAT HELPERS ─────────────────────────────────────────────────────────
const fmtETB = v => `ETB ${Number(v || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const fmtQty = v => Number(v || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });

// ── HTML ESCAPE (used by buildTable and reconciliation UI) ──────────────────
function escHtml(str) {
  return String(str ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── MATERIAL COLUMN HELPERS ────────────────────────────────────────────────
// SAP sometimes stores the description text in the Material field when no
// numeric/structured code exists. We detect and flag this clearly.

// Returns true if the value looks like free-text description rather than a code.
function looksLikeDescription(val) {
  if (!val) return false;
  const s = String(val).trim();
  if (!s) return false;
  return s.includes(" ") || (s.length > 22 && !/^[\w\-\.\/]+$/.test(s));
}

// Gets the code sibling field — used by desc renderer to detect duplicates.
function getSiblingCode(row) {
  if (!row) return "";
  return String(
    row["Material"] ?? row["_st_material"] ?? row["mat"] ?? ""
  ).trim();
}

// ── MAPPED MATERIAL RENDER HELPERS ────────────────────────────────────────
// These are used by renderMatCode/renderMatDesc when row._isMapped is true.
// Defined here (before renderMatCode) so the mutual reference resolves cleanly.

function renderMappedMatCode_early(val, row) {
  const target = escHtml(String(row._mappedMaterial || "").trim());
  const orig   = escHtml(String(row._origMaterial   || "").trim());
  if (!target) {
    const s = escHtml(String(val ?? "").trim());
    return s ? `<span class="col-mat-code">${s}</span>` : '<span style="color:var(--dim)">—</span>';
  }
  const codeHtml = `<span class="col-mat-code">${target}</span><span class="mat-mapped-badge" title="Standardized from ${orig}">STD</span>`;
  if (orig && orig !== target) {
    return codeHtml + `<span class="mat-orig-pill" title="Original SAP code">${orig}</span>`;
  }
  return codeHtml;
}

function renderMappedMatDesc_early(val, row) {
  const tDesc = String(row._mappedDesc || row["Material Description"] || "").trim();
  const oDesc = String(row._origDesc   || "").trim();
  if (!tDesc) return '<span style="color:var(--dim)">—</span>';
  let html = `<span class="col-mat-desc">${escHtml(tDesc)}</span>`;
  if (oDesc && oDesc !== tDesc) {
    html += `<div style="font-size:0.65rem;color:var(--dim);margin-top:1px;font-style:italic">${escHtml(oDesc)}</div>`;
  }
  return html;
}

// ── renderMatCode(val, row) ────────────────────────────────────────────────
// Renders the "Material Code" cell.
//  • Normal code  → purple monospace
//  • Val looks like a description (has spaces / long) → amber "NAME" badge,
//    styled differently so it's obvious this isn't a structured code
//  • If row._isMapped → delegates to renderMappedMatCode for standardized display
function renderMatCode(val, row) {
  // Delegate to mapped renderer when standardization is active for this row
  if (row && row._isMapped) return renderMappedMatCode_early(val, row);

  const s = escHtml(String(val ?? "").trim());
  if (!s) return '<span style="color:var(--dim)">—</span>';

  if (looksLikeDescription(val)) {
    // The "code" field actually contains a descriptive name
    return `<span class="mat-name-as-code" title="No structured code — SAP stores the name here">${s}</span>`
         + `<span class="mat-desc-badge" title="Material field contains a name, not a code">NAME</span>`;
  }
  return `<span class="col-mat-code">${s}</span>`;
}

// ── renderMatDesc(val, row) ────────────────────────────────────────────────
// Renders the "Material Description" cell.
//  • If description === code (SAP duplicate) → show italic muted "(same as code)"
//  • Otherwise → normal readable text
//  • If row._isMapped → delegates to renderMappedMatDesc
function renderMatDesc(val, row) {
  if (row && row._isMapped) return renderMappedMatDesc_early(val, row);

  const desc = String(val ?? "").trim();
  const code = getSiblingCode(row);

  if (!desc) return '<span style="color:var(--dim)">—</span>';

  // Description is identical to the code field → don't repeat it
  if (desc === code) {
    return `<span class="mat-desc-same" title="Description is identical to the material code field">— same as code —</span>`;
  }

  return `<span class="col-mat-desc">${escHtml(desc)}</span>`;
}

// ── FIX BUG-8: Timezone-safe expiry date parser ────────────────────────────
// new Date("2024-03-15") is parsed as UTC midnight → in UTC+3 it appears as
// 2024-03-14 after 21:00 local time, causing day-off expiry errors.
// This parser treats yyyy-mm-dd strings as LOCAL midnight to avoid that shift.
function parseExpiryDate(d) {
  if (d instanceof Date) return isNaN(d.getTime()) ? null : d;
  if (!d) return null;
  const s = String(d).trim();
  // yyyy-mm-dd → local date (not UTC)
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const dt = new Date(+isoMatch[1], +isoMatch[2] - 1, +isoMatch[3]);
    return isNaN(dt.getTime()) ? null : dt;
  }
  // Fallback for other string formats
  const p = new Date(d);
  return isNaN(p.getTime()) ? null : p;
}

// FIX-EXPIRY-DISPLAY: toISOString() converts local-midnight dates to UTC, producing
// a one-day-earlier date string in UTC+3 (Ethiopia). Use local date parts instead.
function fmtLocalDate(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return "";
  const y  = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const dy = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${dy}`;
}

// ── LOAD & PROCESS EXCEL ───────────────────────────────────────────────────
function loadFile(file) {
  // FIX PERF-2: warn before parsing very large files
  if (file.size > 25 * 1024 * 1024) {
    if (!confirm(`This file is ${(file.size / 1024 / 1024).toFixed(1)} MB. Large files may take a few seconds to parse. Continue?`)) return;
  }

  const statusEl = document.getElementById("fileStatus");
  statusEl.style.display = "block";
  statusEl.innerHTML = `<div class="status-ok">⏳ LOADING…</div><div class="status-name">Parsing ${escHtml(file.name)}</div>`;

  const reader = new FileReader();
  reader.onload = e => {
    setTimeout(() => {
      try {
        const wb   = XLSX.read(new Uint8Array(e.target.result), { type: "array", cellDates: true });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(ws, { defval: "" });
        if (!data.length) { showError("The uploaded file contains no data."); return; }

        const trimmed = data.map(row => {
          const r = {};
          for (const [k, v] of Object.entries(row)) r[k.trim()] = v;
          return r;
        });

        // FIX ROBUST: case-insensitive column header matching
        const colsLower = Object.keys(trimmed[0]).map(c => c.toLowerCase());
        const missing = REQUIRED_COLUMNS.filter(c => !colsLower.includes(c.toLowerCase()));
        if (missing.length) { showError(`Missing columns: ${missing.join(", ")}`); return; }

        let df = trimmed
          .filter(r => { const s = String(r["Special Stock Type"]).trim().toUpperCase(); return s !== "Q" && s !== "W"; })
          .filter(r => !isProjectStockDescription(r["Special Stock Type Description"]))
          .filter(r => !isNonMedicalCode(r["Material"]))
          .filter(r => !isNonMedicalGroup(r["Material Group Name"]))
          .filter(r => !isExcludedStorageLocation(r["Storage Location"]))
          .filter(r => String(r["Inventory Valuation Type"] || "").trim() !== "");

        const numCols = [
          "Unrestricted Stock","Stock in Quality Inspection","Blocked Stock","Stock in Transit",
          "Value of Stock in Quality Inspection","Value of Stock in Transit","Value of Unrestricted Stock",
        ];
        df.forEach(row => {
          numCols.forEach(c => { row[c] = parseFloat(row[c]) || 0; });
          // FIX BUG-8: use timezone-safe parser
          row._expiry = parseExpiryDate(row["Shelf Life Expiration Date"]);
          row["Total Value"] = row["Value of Unrestricted Stock"] + row["Value of Stock in Transit"] + row["Value of Stock in Quality Inspection"];
          row["Total Qty"]   = row["Unrestricted Stock"] + row["Stock in Transit"] + row["Stock in Quality Inspection"];
        });

        df = df.filter(r =>
          r["Unrestricted Stock"] > 0 ||
          r["Stock in Transit"] > 0 ||
          r["Stock in Quality Inspection"] > 0 ||
          r["Blocked Stock"] > 0
        );

        rawDf  = df;
        filtDf = df;

        // Apply material standardization mapping if already loaded
        if (mappingTable.size > 0) applyMaterialMapping();

        // ISL-MATCH: re-cross-match received goods against new inventory snapshot
        // (handles the case where incoming file was uploaded before inventory)
        recomputeIslMatch();

        // FIX BUG-3: clear stale page filters from the previous file
        resetPageFilters();
        // FIX-STFILTER: also reset transit-section filter state on new main file load
        // so stale PO/supplying-plant selections from the previous dataset don't persist
        stFilterState = { purDoc: "", supPlant: "" };

        // If transit file was already loaded, stamp phantom flags on the new dataset
        if (stockTransitRaw.length) recomputePhantomTransit();

        showSuccess(file.name, df.length);
        clearError();
        hideLanding();
        populateAllFilters();
        // Switch to dashboard after file load
        renderPage(currentPage === "home" ? "dashboard" : currentPage);
      } catch (err) {
        showError(`Could not read Excel file: ${err.message}`);
      }
    }, 30);
  };
  reader.readAsArrayBuffer(file);
}

// ── MULTI-SELECT DROPDOWN BUILDER ─────────────────────────────────────────
// Creates a searchable checkbox dropdown inside .ms-wrap elements.
// wrapId = id of the .ms-wrap container
// items  = array of string values
// onLabel = optional function(selectedArr) → button label string
function buildMultiSelect(wrapId, ddId, items, placeholder) {
  const wrap = document.getElementById(wrapId);
  const dd   = document.getElementById(ddId);
  if (!wrap || !dd) return;

  const btn  = wrap.querySelector(".ms-btn");

  // FIX-LABEL: use a mutable reference so updateLabel always targets the live
  // DOM button even after btn is replaced by freshBtn below.
  let activeBtn = btn;

  // Render options
  function renderItems(filter) {
    const filtered = filter ? items.filter(v => v.toLowerCase().includes(filter.toLowerCase())) : items;
    dd.querySelectorAll(".ms-item").forEach(el => el.remove());
    filtered.forEach(val => {
      const label = document.createElement("label");
      label.className = "ms-item";
      const cb = document.createElement("input");
      cb.type  = "checkbox";
      cb.value = val;
      // Restore checked state
      const page = wrap.dataset.page, key = wrap.dataset.key;
      if (page && key && pageFilters[page] && (pageFilters[page][key] || []).includes(val)) {
        cb.checked = true;
      }
      cb.addEventListener("change", updateLabel);
      label.appendChild(cb);
      label.appendChild(document.createTextNode(val));
      dd.appendChild(label);
    });
  }

  function updateLabel() {
    const checked = [...dd.querySelectorAll("input:checked")].map(c => c.value);
    if (checked.length === 0) {
      activeBtn.innerHTML = `${escHtml(placeholder)} <span class="ms-arrow">▾</span>`;
      activeBtn.classList.remove("ms-active");
    } else {
      const fullLabel = checked.join(", ");
      const display   = fullLabel.length > 32 ? fullLabel.slice(0, 30) + "…" : fullLabel;
      activeBtn.innerHTML = `<span class="ms-selected-names" title="${escHtml(fullLabel)}">${escHtml(display)}</span> <span class="ms-count-badge">${checked.length}</span> <span class="ms-arrow">▾</span>`;
      activeBtn.classList.add("ms-active");
    }
  }

  // Build search box + items
  dd.innerHTML = "";
  const searchInput = document.createElement("input");
  searchInput.className   = "ms-search";
  searchInput.placeholder = "Search…";
  searchInput.type        = "text";
  searchInput.addEventListener("input", e => renderItems(e.target.value));
  dd.appendChild(searchInput);
  renderItems("");

  // Toggle open/close
  // FIX-LISTENER: clone btn to strip any previously registered click listeners from
  // prior buildMultiSelect calls (e.g. when renderBranch rebuilds ms-branch-select).
  const freshBtn = btn.cloneNode(true);
  btn.parentNode.replaceChild(freshBtn, btn);
  // FIX-LABEL: update activeBtn to point at the now-live freshBtn so updateLabel
  // writes to the correct element (the old btn is detached from the DOM after replaceChild).
  activeBtn = freshBtn;
  freshBtn.addEventListener("click", e => {
    e.stopPropagation();
    // Close all others first
    document.querySelectorAll(".ms-wrap.open").forEach(w => { if (w !== wrap) w.classList.remove("open"); });
    wrap.classList.toggle("open");
    if (wrap.classList.contains("open")) searchInput.focus();
  });

  // Expose refresh function on the wrap element
  wrap._refreshOptions = function(newItems) {
    // BUG-MULTISELECT FIX: update the items array when newItems is provided
    if (Array.isArray(newItems)) items = newItems;
    renderItems(searchInput.value || "");
    updateLabel();
  };
  wrap._getSelected = function() {
    return [...dd.querySelectorAll("input:checked")].map(c => c.value);
  };
  wrap._clearSelected = function() {
    dd.querySelectorAll("input:checked").forEach(cb => { cb.checked = false; });
    updateLabel();
  };

  updateLabel();
}

// Close dropdowns when clicking outside
document.addEventListener("click", () => {
  document.querySelectorAll(".ms-wrap.open").forEach(w => w.classList.remove("open"));
});

// ── POPULATE FILTER DROPDOWNS ──────────────────────────────────────────────
function populateAllFilters() {
  const plants = [...new Set(rawDf.map(r => r["Plant Name"]))].filter(Boolean).sort();
  const mgs    = [...new Set(rawDf.map(r => r["Material Group Name"]))]
    .filter(Boolean)
    .filter(name => !isNonMedicalGroup(name))
    .sort();

  // Plant multi-selects
  const plantConfigs = [
    { wrapId:"ms-dash-plant",    ddId:"ms-dash-plant-dd",    page:"dashboard", key:"plants" },
    { wrapId:"ms-transit-plant", ddId:"ms-transit-plant-dd", page:"transit",   key:"plants" },
    { wrapId:"ms-expiry-plant",  ddId:"ms-expiry-plant-dd",  page:"expiry",    key:"plants" },
    { wrapId:"ms-qc-plant",      ddId:"ms-qc-plant-dd",      page:"qc",        key:"plants" },
    { wrapId:"ms-flow-plant",    ddId:"ms-flow-plant-dd",    page:"flow",      key:"plants" },
  ];
  plantConfigs.forEach(cfg => {
    const wrap = document.getElementById(cfg.wrapId);
    if (wrap) { wrap.dataset.page = cfg.page; wrap.dataset.key = "plants"; }
    buildMultiSelect(cfg.wrapId, cfg.ddId, plants, "All Plants");
  });

  // MG multi-selects
  const mgConfigs = [
    { wrapId:"ms-dash-mg",    ddId:"ms-dash-mg-dd",    page:"dashboard", key:"mgs" },
    { wrapId:"ms-transit-mg", ddId:"ms-transit-mg-dd", page:"transit",   key:"mgs" },
    { wrapId:"ms-expiry-mg",  ddId:"ms-expiry-mg-dd",  page:"expiry",    key:"mgs" },
    { wrapId:"ms-qc-mg",      ddId:"ms-qc-mg-dd",      page:"qc",        key:"mgs" },

    { wrapId:"ms-flow-mg",    ddId:"ms-flow-mg-dd",    page:"flow",      key:"mgs" },
  ];
  mgConfigs.forEach(cfg => {
    const wrap = document.getElementById(cfg.wrapId);
    if (wrap) { wrap.dataset.page = cfg.page; wrap.dataset.key = "mgs"; }
    buildMultiSelect(cfg.wrapId, cfg.ddId, mgs, "All Material Groups");
  });

  // Concentration page MG
  (() => {
    const wrap = document.getElementById("ms-conc-mg");
    if (wrap) { wrap.dataset.page = "concentration"; wrap.dataset.key = "mgs"; }
    buildMultiSelect("ms-conc-mg", "ms-conc-mg-dd", mgs, "All Material Groups");
  })();

  // Valuation Type multi-selects
  const valTypes = [...new Set(rawDf.map(r => getValuationType(r)))]
    .filter(v => v && v !== "(None)")
    .sort();

  const vtConfigs = [
    { wrapId:"ms-dash-vt",    ddId:"ms-dash-vt-dd",    page:"dashboard" },
    { wrapId:"ms-transit-vt", ddId:"ms-transit-vt-dd", page:"transit"   },
    { wrapId:"ms-expiry-vt",  ddId:"ms-expiry-vt-dd",  page:"expiry"    },
    { wrapId:"ms-qc-vt",      ddId:"ms-qc-vt-dd",      page:"qc"        },

    { wrapId:"ms-flow-vt",    ddId:"ms-flow-vt-dd",    page:"flow"      },
  ];
  vtConfigs.forEach(cfg => {
    const wrap = document.getElementById(cfg.wrapId);
    if (wrap) { wrap.dataset.page = cfg.page; wrap.dataset.key = "valTypes"; }
    buildMultiSelect(cfg.wrapId, cfg.ddId, valTypes, "All Material Types");
  });

  // Concentration page VT
  (() => {
    const wrap = document.getElementById("ms-conc-vt");
    if (wrap) { wrap.dataset.page = "concentration"; wrap.dataset.key = "valTypes"; }
    buildMultiSelect("ms-conc-vt", "ms-conc-vt-dd", valTypes, "All Material Types");
  })();

  // Material multi-selects — replaces the old free-text Material Lookup search
  // boxes on Transit / Expiry / QC / Flow with a proper filter-bar control.
  const materials = [...new Set(rawDf.map(r => {
    const code = String(r["Material"] || "").trim();
    if (!code) return "";
    const desc = String(r["Material Description"] || "").trim();
    return code + (desc && desc !== code ? " — " + desc : "");
  }))].filter(Boolean).sort();

  const matConfigs = [
    { wrapId:"ms-transit-mat", ddId:"ms-transit-mat-dd", page:"transit",   key:"materials" },
    { wrapId:"ms-expiry-mat",  ddId:"ms-expiry-mat-dd",  page:"expiry",    key:"materials" },
    { wrapId:"ms-qc-mat",      ddId:"ms-qc-mat-dd",      page:"qc",        key:"materials" },

    { wrapId:"ms-flow-mat",    ddId:"ms-flow-mat-dd",    page:"flow",      key:"materials" },
  ];
  matConfigs.forEach(cfg => {
    const wrap = document.getElementById(cfg.wrapId);
    if (wrap) { wrap.dataset.page = cfg.page; wrap.dataset.key = "materials"; }
    buildMultiSelect(cfg.wrapId, cfg.ddId, materials, "All Materials");
  });

}

// ── APPLY PAGE FILTER ──────────────────────────────────────────────────────
// Uses the memoised reconciled base for performance.
// Also re-enforces base exclusion rules so excluded rows never appear on any page
// even if rawDf somehow contains them (e.g. after reconciliation merges).
function applyPageFilter(page) {
  const f    = pageFilters[page] || {};
  const base = getReconciledBase();
  const plants    = f.plants    || [];
  const mgs       = f.mgs       || [];
  const valTypes  = f.valTypes  || [];
  // Material filter values are stored as "CODE — Description" (or bare CODE);
  // only the code portion is matched against each row's Material field.
  const materials = (f.materials || []).map(v => String(v).split(" — ")[0].trim().toLowerCase());
  return base.filter(r =>
    // Re-apply base exclusion rules (defence-in-depth)
    !isNonMedicalCode(r["Material"]) &&
    !isNonMedicalGroup(r["Material Group Name"]) &&
    !isProjectStockDescription(r["Special Stock Type Description"]) &&
    !isExcludedStorageLocation(r["Storage Location"]) &&
    (function(){ const s = String(r["Special Stock Type"] || "").trim().toUpperCase(); return s !== "Q" && s !== "W"; })() &&
    String(r["Inventory Valuation Type"] || "").trim() !== "" &&
    // Page-level plant / material group / valuation type / material filters
    (!plants.length    || plants.includes(r["Plant Name"])) &&
    (!mgs.length       || mgs.includes(r["Material Group Name"])) &&
    (!valTypes.length  || valTypes.includes(getValuationType(r))) &&
    (!materials.length || materials.includes(String(r["Material"] || "").trim().toLowerCase()))
  );
}

// ── UI HELPERS ─────────────────────────────────────────────────────────────
function showError(msg) {
  const el = document.getElementById("errorBanner");
  el.textContent = `⚠️ ${msg}`;
  el.style.display = "block";
}
function clearError() { document.getElementById("errorBanner").style.display = "none"; }
function showSuccess(name, n) {
  const el = document.getElementById("fileStatus");
  el.style.display = "block";
  el.innerHTML = `<div class="status-ok">✓ FILE LOADED</div><div class="status-name">${escHtml(name)} (${n.toLocaleString()} records)</div>`;
  document.getElementById("uploadBtnText").textContent = "📂 Change File";
}
function hideLanding() { document.getElementById("landingView").style.display = "none"; }

function kpiCard(label, value, sub, color) {
  return `<div class="kpi-card ${color}"><div class="kpi-label">${escHtml(label)}</div><div class="kpi-value">${escHtml(value)}</div><div class="kpi-sub">${escHtml(sub)}</div></div>`;
}
function setKpis(id, cards) {
  document.getElementById(id).innerHTML = cards.map(([l,v,s,c]) => kpiCard(l,v,s,c)).join("");
}

// ── GROUPBY HELPERS ────────────────────────────────────────────────────────
function groupBy(data, key, aggCols) {
  const map = {};
  data.forEach(row => {
    // FIX BUG-10: label blank keys clearly so charts don't show an invisible bar
    const k = row[key] || "(Blank)";
    if (!map[k]) { map[k] = { [key]: k }; aggCols.forEach(([c]) => { map[k][c] = 0; }); }
    aggCols.forEach(([c,src]) => { map[k][c] += row[src] || 0; });
  });
  return Object.values(map);
}
function sortBy(arr, key, asc=false) { return [...arr].sort((a,b) => asc ? a[key]-b[key] : b[key]-a[key]); }

// ── TABLE BUILDER ──────────────────────────────────────────────────────────
// Columns with raw:true may contain trusted HTML (badges etc.) — all others
// are escaped to prevent XSS from Excel data landing in the DOM.
function buildTable(rows, cols, rowClass, extraClass="") {
  if (!rows.length) return `<div class="alert-info">No data to display.</div>`;
  const thead = `<thead><tr>${cols.map(c => `<th>${escHtml(c.label)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows.map(row => {
    const cls = rowClass ? rowClass(row) : "";
    return `<tr class="${cls}">${cols.map(c => {
      // Pass both the cell value AND the full row so fmt functions can cross-check sibling fields
      const raw     = c.fmt ? c.fmt(row[c.key], row) : (row[c.key] ?? "");
      const val     = c.raw ? raw : escHtml(String(raw));
      const cellCls = c.cellClass || "";
      return `<td class="${cellCls}">${val}</td>`;
    }).join("")}</tr>`;
  }).join("")}</tbody>`;
  return `<div class="tbl-wrap"><table class="${extraClass}">${thead}${tbody}</table></div>`;
}

// ── EXCEL DOWNLOAD ─────────────────────────────────────────────────────────
function downloadExcel(data, cols, filename) {
  const header = cols.map(c => c.label);
  const rows   = data.map(row => cols.map(c => {
    const v   = row[c.key];
    const raw = c.rawKey ? (row[c.rawKey] ?? v) : v;
    if (c.fmt) return (typeof raw === "number") ? raw : (raw ?? "");
    return raw ?? "";
  }));
  const wsData = [header, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Data");
  XLSX.writeFile(wb, filename);
}

// ── CSV DOWNLOAD ───────────────────────────────────────────────────────────
function downloadCSV(data, cols, filename) {
  const header = cols.map(c => c.label).join(",");
  const rows   = data.map(row => cols.map(c => {
    let v = c.rawKey ? (row[c.rawKey] ?? row[c.key] ?? "") : (row[c.key] ?? "");
    v = String(v ?? "");
    // FIX-CSV-ORDER: quote first (handles commas/tabs/newlines/quotes), THEN
    // apply injection guard — but only on non-quoted values so the ' prefix stays
    // as the literal first character seen by spreadsheet apps.
    const needsQuote = v.includes(",") || v.includes('"') || v.includes("\n") || v.includes("\t");
    if (needsQuote) {
      v = `"${v.replace(/"/g, '""')}"`;
    } else if (/^[=+\-@]/.test(v)) {
      // BUG-FIX-7: removed \r from injection guard regex. A value beginning with
      // \r\n (Windows line ending) would get a spurious ' prefix producing garbage
      // like '\r\nsome text. Carriage returns are already handled by the needsQuote
      // path above via the \n check (they always appear together in Windows line
      // endings). Formula-injection characters =, +, -, @ still guarded.
      v = `'${v}`;
    }
    return v;
  }).join(","));
  const blob = new Blob(["\uFEFF" + header + "\n" + rows.join("\n")], { type: "text/csv;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── PLOTLY LAYOUT MERGE ────────────────────────────────────────────────────
function pl(extra={}) {
  const tc = getPlotlyThemeColors();
  const base = {
    ...PLOTLY_LAYOUT,
    font:   { ...PLOTLY_LAYOUT.font,   color: tc.muted },
    xaxis:  { ...PLOTLY_LAYOUT.xaxis,  gridcolor: tc.grid, zerolinecolor: tc.grid, tickfont: { color: tc.muted } },
    yaxis:  { ...PLOTLY_LAYOUT.yaxis,  gridcolor: tc.grid, zerolinecolor: tc.grid, tickfont: { color: tc.muted } },
    legend: { ...PLOTLY_LAYOUT.legend, font: { color: tc.muted } },
  };
  return Object.assign({}, base, extra, {
    xaxis:  Object.assign({}, base.xaxis,  extra.xaxis  || {}),
    yaxis:  Object.assign({}, base.yaxis,  extra.yaxis  || {}),
    legend: Object.assign({}, base.legend, extra.legend || {}),
    margin: Object.assign({}, base.margin, extra.margin || {}),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════
function renderDashboard() {
  const df = applyPageFilter("dashboard");

  renderPhantomAlert("dash-phantom-alert", df);

  // FIX-TRANSIT-NODOC: exclude transit items lacking both Purchasing Document
  // AND Supplying Plant — these are physically unconfirmed (phantom) and must
  // not inflate Dashboard totals.
  const transitVal = df.reduce((s,r) => s + getVerifiedTransitVal(r), 0);
  const transitQty = df.reduce((s,r) => s + getVerifiedTransitQty(r), 0);
  const qcVal      = df.reduce((s,r) => s + getMappedVal(r,"Value of Stock in Quality Inspection"), 0);
  const availVal   = df.reduce((s,r) => s + getMappedVal(r,"Value of Unrestricted Stock"), 0);
  const totalVal   = availVal + transitVal + qcVal;
  const totalQty   = df.reduce((s,r) => s + getMappedQty(r,"Unrestricted Stock"), 0) + transitQty + df.reduce((s,r) => s + getMappedQty(r,"Stock in Quality Inspection"), 0);

  setKpis("dash-kpis", [
    ["Total Inventory Value",    fmtETB(totalVal),   `${fmtQty(totalQty)} total units`,      "blue"],
    ["Stock in Transit Value",   fmtETB(transitVal), `${fmtQty(transitQty)} units`, "amber"],
    ["Value in QC",              fmtETB(qcVal),      `${fmtQty(df.reduce((s,r) => s+getMappedQty(r,"Stock in Quality Inspection"),0))} units`, "red"],
    ["Available (Unrestricted)", fmtETB(availVal),   `${fmtQty(df.reduce((s,r) => s+getMappedQty(r,"Unrestricted Stock"),0))} units`, "green"],
    ["Unique Materials",         new Set(df.map(r=>r._mappedMaterial||r["Material"])).size.toLocaleString(), `${new Set(df.map(r=>r["Plant"])).size} plants`, "purple"],
  ]);

  // Plant bar — stacked by stock status (Unrestricted / In Transit / In QC), matching
  // the Branch Comparison chart style. Uses getMappedVal/getVerifiedTransitVal so
  // unit-conversion mapping and the phantom-transit exclusion are respected, same
  // as everywhere else on the Dashboard.
  const plantAggMap = {};
  df.forEach(r => {
    const k = r["Plant Name"] || "(Blank)";
    if (!plantAggMap[k]) {
      plantAggMap[k] = { PlantName:k, Unrestricted:0, Transit:0, QC:0, UnrestrictedQty:0, TransitQty:0, QCQty:0, TotalValue:0 };
    }
    const unrestrictedVal = getMappedVal(r,"Value of Unrestricted Stock");
    const transitVal2     = getVerifiedTransitVal(r);
    const qcVal2          = getMappedVal(r,"Value of Stock in Quality Inspection");
    plantAggMap[k].Unrestricted    += unrestrictedVal;
    plantAggMap[k].Transit         += transitVal2;
    plantAggMap[k].QC              += qcVal2;
    plantAggMap[k].UnrestrictedQty += getMappedQty(r,"Unrestricted Stock");
    plantAggMap[k].TransitQty      += getVerifiedTransitQty(r);
    plantAggMap[k].QCQty           += getMappedQty(r,"Stock in Quality Inspection");
    plantAggMap[k].TotalValue      += unrestrictedVal + transitVal2 + qcVal2;
  });
  const plantAgg = sortBy(Object.values(plantAggMap), "TotalValue");
  Plotly.newPlot("chart-plant-val", [
    { type:"bar", name:"Unrestricted (ETB)", x:plantAgg.map(r=>r.PlantName), y:plantAgg.map(r=>r.Unrestricted),
      customdata:plantAgg.map(r=>r.UnrestrictedQty), marker:{color:"#3fb950"},
      hovertemplate:"<b>%{x}</b><br>ETB %{y:,.0f}<br>Qty: %{customdata:,.0f}<extra></extra>" },
    { type:"bar", name:"In Transit (ETB)", x:plantAgg.map(r=>r.PlantName), y:plantAgg.map(r=>r.Transit),
      customdata:plantAgg.map(r=>r.TransitQty), marker:{color:"#d29922"},
      hovertemplate:"<b>%{x}</b><br>ETB %{y:,.0f}<br>Qty: %{customdata:,.0f}<extra></extra>" },
    { type:"bar", name:"In QC (ETB)", x:plantAgg.map(r=>r.PlantName), y:plantAgg.map(r=>r.QC),
      customdata:plantAgg.map(r=>r.QCQty), marker:{color:"#f85149"},
      hovertemplate:"<b>%{x}</b><br>ETB %{y:,.0f}<br>Qty: %{customdata:,.0f}<extra></extra>" },
  ], pl({ height:280, barmode:"stack", margin:{l:20,r:20,t:20,b:80} }), PLOTLY_CONFIG);

  // ── Material Groups with Expiry Risk ──────────────────────────────────
  // For each material group, count how many distinct materials have
  // near-expiry unrestricted stock within the next 6 months.
  // Split into Critical (<3 months) and High (3–6 months) bands.
  const now        = new Date();
  const cut3mo     = new Date(now); cut3mo.setMonth(cut3mo.getMonth() + 3);
  const cut6mo     = new Date(now); cut6mo.setMonth(cut6mo.getMonth() + 6);

  // Build per-group risk counts using unique material codes (not row counts)
  // so a material stocked at multiple plants counts once per group.
  const mgRiskMap = {};
  df.forEach(r => {
    if (!(r._expiry instanceof Date) || isNaN(r._expiry)) return;
    if ((r["Unrestricted Stock"] || 0) <= 0) return;
    const grp = r["Material Group Name"] || "(Blank)";
    const mat = r._mappedMaterial || r["Material"];
    if (!mgRiskMap[grp]) mgRiskMap[grp] = { critical: new Set(), high: new Set() };
    if (r._expiry >= now && r._expiry <= cut3mo) {
      mgRiskMap[grp].critical.add(mat);
    } else if (r._expiry > cut3mo && r._expiry <= cut6mo) {
      mgRiskMap[grp].high.add(mat);
    }
  });

  // Only show groups that have at least one at-risk material; sort by total risk desc
  const mgRiskRows = Object.entries(mgRiskMap)
    .map(([grp, sets]) => ({
      grp,
      critical: sets.critical.size,
      high:     sets.high.size,
      total:    sets.critical.size + sets.high.size,
    }))
    .filter(r => r.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 12);

  const mgRiskEl = document.getElementById("chart-mg-expiry-risk");
  if (mgRiskRows.length) {
    // Count total unique groups with any risk exposure for the subtitle
    const totalRiskGroups = Object.values(mgRiskMap).filter(s => s.critical.size + s.high.size > 0).length;
    const totalGroups     = new Set(df.map(r => r["Material Group Name"]).filter(Boolean)).size;
    // Update subtitle in legend area
    const legendEl = document.getElementById("mg-expiry-risk-legend");
    if (legendEl) {
      legendEl.innerHTML = `
        <span class="mg-risk-summary"><b style="color:var(--red)">${totalRiskGroups}</b> of ${totalGroups} groups have near-expiry exposure</span>
        <span style="display:flex;gap:0.7rem;flex-wrap:wrap;margin-top:0.35rem">
          <span><span class="mg-risk-dot" style="background:#f85149"></span>Critical (&lt;3 mo)</span>
          <span><span class="mg-risk-dot" style="background:#ffa657"></span>High (3–6 mo)</span>
        </span>`;
    }

    const labels = mgRiskRows.map(r => r.grp.length > 26 ? r.grp.slice(0, 24) + "…" : r.grp);
    // FIX-XAXIS-READABILITY: dtick:1 forced a tick at every integer, which became
    // an unreadable wall of overlapping labels once any group's risk count grew
    // past ~15-20. Scale the tick step to the largest bar so there are at most
    // ~8 ticks, while tickformat keeps labels as whole numbers (counts of materials).
    const maxRisk = Math.max(1, ...mgRiskRows.map(r => r.total));
    const xDtick  = maxRisk <= 10 ? 1 : Math.ceil(maxRisk / 8);
    Plotly.newPlot("chart-mg-expiry-risk", [
      {
        type: "bar", orientation: "h", name: "Critical (<3 mo)",
        x: mgRiskRows.map(r => r.critical),
        y: labels,
        marker: { color: "#f85149" },
        hovertemplate: "<b>%{y}</b><br>Critical: %{x} material(s)<extra></extra>",
      },
      {
        type: "bar", orientation: "h", name: "High (3–6 mo)",
        x: mgRiskRows.map(r => r.high),
        y: labels,
        marker: { color: "#ffa657" },
        hovertemplate: "<b>%{y}</b><br>High: %{x} material(s)<extra></extra>",
      },
    ], pl({
      barmode: "stack",
      height: Math.max(220, mgRiskRows.length * 26 + 40),
      margin: { l: 10, r: 30, t: 10, b: 30 },
      xaxis: { title: { text: "Materials at risk", font: { size: 10, color: "#7a97b0" } }, dtick: xDtick, tickformat: ",d" },
      yaxis: { automargin: true, tickfont: { size: 10 } },
      legend: { orientation: "h", y: -0.18, x: 0, font: { size: 10 } },
      showlegend: true,
    }), PLOTLY_CONFIG);
  } else {
    mgRiskEl.innerHTML = `<div class="alert-info" style="margin:0.5rem 0;font-size:0.75rem">✓ No material groups have near-expiry stock within 6 months.</div>`;
  }

  // Near-expiry by plant (within 6 months)
  const nearCutoff = new Date(); nearCutoff.setMonth(nearCutoff.getMonth() + 6);
  const nearToday  = new Date();
  const nearExpiry = df.filter(r =>
    r._expiry instanceof Date && !isNaN(r._expiry) &&
    r._expiry >= nearToday && r._expiry <= nearCutoff &&
    (r["Unrestricted Stock"] || 0) > 0
  );
  const nearByPlant = sortBy(
    groupBy(nearExpiry, "Plant Name", [["val","Value of Unrestricted Stock"],["qty","Unrestricted Stock"]]),
    "val"
  );
  if (nearByPlant.length) {
    Plotly.newPlot("chart-mg-bar", [
      { type:"bar", name:"Value at Risk (ETB)", x:nearByPlant.map(r=>r["Plant Name"]), y:nearByPlant.map(r=>r.val), yaxis:"y",  marker:{color:"#d29922"}, hovertemplate:"<b>%{x}</b><br>ETB %{y:,.0f}<extra></extra>" },
      { type:"scatter", mode:"lines+markers", name:"Qty at Risk", x:nearByPlant.map(r=>r["Plant Name"]), y:nearByPlant.map(r=>r.qty), yaxis:"y2", marker:{color:"#f85149",size:8}, line:{color:"#f85149"}, hovertemplate:"<b>%{x}</b><br>Qty: %{y:,.0f}<extra></extra>" },
    ], pl({ height:420, margin:{l:20,r:60,t:20,b:100}, barmode:"group",
      yaxis2:{overlaying:"y",side:"right",gridcolor:"transparent",tickfont:{color:"#f85149"},title:{text:"Qty",font:{color:"#f85149"}}}
    }), PLOTLY_CONFIG);
  } else {
    document.getElementById("chart-mg-bar").innerHTML = `<div class="alert-info" style="margin:1rem 0">✓ No near-expiry stock (within 6 months) with quantity on hand.</div>`;
  }

  // Download
  const dlCols = [
    {key:"Plant Name",         label:"Plant"},
    {key:"Material Group Name",label:"Material Group"},
    {key:"Total Value",        label:"Total Value (ETB)", fmt:fmtETB, rawKey:"Total Value"},
    {key:"Total Qty",          label:"Total Qty",         fmt:fmtQty, rawKey:"Total Qty"},
  ];
  const aggForDl = groupBy(df, "Plant Name", [["Total Value","Total Value"],["Total Qty","Total Qty"]]);

}

// ═══════════════════════════════════════════════════════════════════════════
// STOCK IN TRANSIT FILE LOADER
// Loads the separate stock-in-transit Excel (columns: Material, Material
// Description, Plant, Name 1, Purchasing Document, Item, Supplying Plant,
// Special Stock, Quantity, Base Unit of Measure, …).
// Applies the same isNonMedicalCode / isNonMedicalGroup filters as the
// main inventory file so only medical items appear.
// ═══════════════════════════════════════════════════════════════════════════
function loadTransitFile(file) {
  const statusEl = document.getElementById("transitFileStatus");
  statusEl.style.display = "block";
  statusEl.innerHTML = `<div class="status-ok">⏳ LOADING…</div><div class="status-name">Parsing ${escHtml(file.name)}</div>`;

  const reader = new FileReader();
  reader.onload = e => {
    setTimeout(() => {
      try {
        const wb   = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(ws, { defval: "" });
        if (!data.length) {
          statusEl.innerHTML = `<div class="status-ok" style="color:var(--red)">✗ Empty file</div>`;
          return;
        }

        // Trim all column headers
        const trimmed = data.map(row => {
          const r = {};
          for (const [k, v] of Object.entries(row)) r[k.trim()] = v;
          return r;
        });

        // Normalise key column names (case-insensitive lookup)
        const colMap = {};
        if (trimmed.length) {
          Object.keys(trimmed[0]).forEach(k => { colMap[k.toLowerCase()] = k; });
        }
        const getCol = name => colMap[name.toLowerCase()] || name;

        // Apply the same medical filters as the main file
        // FIX-R8: also apply isNonMedicalGroup when the column is present
        let df = trimmed.filter(r => {
          const mat = String(r[getCol("Material")] ?? "").trim();
          if (!mat || isNonMedicalCode(mat)) return false;
          const grp = String(r[getCol("Material Group Name")] ?? "").trim();
          if (grp && isNonMedicalGroup(grp)) return false;
          return true;
        });

        // Normalise Purchasing Document (may come as scientific notation from Excel)
        df = df.map(r => {
          const raw = String(r[getCol("Purchasing Document")] ?? "").trim();
          let purDoc = raw;
          if (/e/i.test(raw)) purDoc = String(Math.round(Number(raw)));
          return {
            "_st_material":     String(r[getCol("Material")]             ?? "").trim(),
            "_st_desc":         String(r[getCol("Material Description")] ?? "").trim(),
            "_st_plant":        String(r[getCol("Plant")]                ?? "").trim(),
            "_st_plantName":    String(r[getCol("Name 1")]               ?? r[getCol("Plant Name")] ?? "").trim(),
            "_st_purDoc":       purDoc,
            "_st_supPlant":     String(r[getCol("Supplying Plant")]      ?? "").trim(),
            "_st_qty":          parseFloat(r[getCol("Quantity")] ?? r[getCol("Order Quantity")] ?? 0) || 0,
            "_st_uom":          String(r[getCol("Base Unit of Measure")] ?? r[getCol("Order Unit")] ?? "").trim(),
            "_st_item":         String(r[getCol("Item")]                 ?? "").trim(),
            "_st_specialStock": String(r[getCol("Special Stock")]        ?? "").trim(),
          };
        });

        // FIX-EXCL-SLOC: Remove any material from stockTransitRaw that was entirely
        // excluded from rawDf (e.g. all its rows fell under an excluded storage location
        // or other parse-time filter).  If the material has no presence in rawDf at all
        // it must not appear anywhere on the site, including the transit detail section.
        if (rawDf.length) {
          const allowedMaterials = new Set(rawDf.map(r => String(r["Material"] || "").trim()));
          df = df.filter(r => allowedMaterials.has(r._st_material));
        }

        stockTransitRaw = df;
        stFilterState   = { purDoc: "", supPlant: "" };

        // Recompute phantom flags now that transit detail is available
        recomputePhantomTransit();

        // Update status
        statusEl.innerHTML = `<div class="status-ok">✓ TRANSIT FILE LOADED</div><div class="status-name">${escHtml(file.name)} (${df.length.toLocaleString()} records)</div>`;
        document.getElementById("transitUploadBtnText").textContent = "📦 Change Transit File";

        // Re-render current page so phantom exclusions take effect immediately
        const reRender = { dashboard: renderDashboard, transit: () => { renderTransit(); renderStockTransitSection(); }, branch: renderBranch, flow: renderFlow };
        if (reRender[currentPage]) reRender[currentPage]();
        else if (currentPage === "transit") renderStockTransitSection();
      } catch (err) {
        statusEl.innerHTML = `<div class="status-ok" style="color:var(--red)">✗ ${escHtml(err.message)}</div>`;
      }
    }, 30);
  };
  reader.readAsArrayBuffer(file);
}

// ═══════════════════════════════════════════════════════════════════════════
// MATERIAL STANDARDIZATION MAPPING — File Loader & Core Logic
// ═══════════════════════════════════════════════════════════════════════════

/**
 * loadMappingFile(file)
 *   Parses the uploaded mapping Excel and populates mappingTable.
 *   Expected columns (case-insensitive):
 *     Material Code SORCE / Material Code Source → source code
 *     Material Description (source)              → source desc (informational)
 *     Conversion Factor                          → multiplier
 *     Material Code Target                       → target code
 *     Material Description (target)              → target desc
 *
 * After parsing, calls applyMaterialMapping() and re-renders the current page.
 */
function loadMappingFile(file) {
  const statusEl = document.getElementById("mappingFileStatus");
  statusEl.style.display = "block";
  statusEl.innerHTML = `<div class="status-ok">⏳ LOADING…</div><div class="status-name">Parsing ${escHtml(file.name)}</div>`;

  const reader = new FileReader();
  reader.onload = e => {
    setTimeout(() => {
      try {
        const wb   = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(ws, { defval: "" });
        if (!data.length) { statusEl.innerHTML = `<div class="status-ok" style="color:var(--red)">✗ Mapping file is empty.</div>`; return; }

        // Case-insensitive column lookup
        const colMap = {};
        Object.keys(data[0]).forEach(k => { colMap[k.toLowerCase().trim()] = k; });
        const gc = (...names) => {
          for (const n of names) {
            const k = colMap[n.toLowerCase()];
            if (k) return k;
          }
          return null;
        };

        const colSource  = gc(
          "material code sorce","material code source","material code (source)",
          "source material code","source code","mat code source","mat. code source",
          "source mat code","source material","material source","source"
        );
        const colTarget  = gc(
          "material code target","target material code","target code",
          "mat code target","mat. code target","target mat code",
          "target material","material target","target"
        );
        const colFactor  = gc(
          "conversion factor","factor","conv factor","conversion",
          "conv. factor","uom factor","unit factor","qty factor","quantity factor"
        );
        const colTgtDesc = gc(
          "material description (target)","target description","target desc",
          "material description target","target material description","desc target",
          "description (target)","description target"
        );

        if (!colSource || !colTarget || !colFactor) {
          const missing = [
            !colSource && "Material Code Source",
            !colTarget && "Material Code Target",
            !colFactor && "Conversion Factor",
          ].filter(Boolean);
          const actualCols = Object.keys(data[0]).map(k => k.trim()).join(", ");
          statusEl.innerHTML = `
            <div class="status-ok" style="color:var(--red)">✗ Missing required columns: ${missing.join(", ")}</div>
            <div style="font-size:0.65rem;margin-top:4px;color:var(--muted)">
              <b>Accepted names:</b><br>
              • Source: "Material Code Source" (or "Material Code Sorce", "Source Code")<br>
              • Target: "Material Code Target" (or "Target Material Code", "Target Code")<br>
              • Factor: "Conversion Factor" (or "Factor", "Conv Factor")<br>
              <b style="color:var(--amber)">Columns found in your file:</b> ${escHtml(actualCols)}
            </div>`;
          return;
        }

        // Build the mapping table — source → { targetCode, targetDesc, factor }
        const newMap = new Map();
        let skipped  = 0;
        data.forEach(row => {
          const src    = String(row[colSource]  ?? "").trim();
          const tgt    = String(row[colTarget]  ?? "").trim();
          const rawFac = String(row[colFactor]  ?? "").trim();
          const tDesc  = colTgtDesc ? String(row[colTgtDesc] ?? "").trim() : "";
          const factor = parseFloat(rawFac);

          if (!src || !tgt || isNaN(factor) || factor <= 0) { skipped++; return; }
          // Store with 9dp rounding to suppress float drift (consistent with existing reconciliation logic)
          newMap.set(src.toUpperCase(), { targetCode: tgt, targetDesc: tDesc, factor: parseFloat(factor.toFixed(9)) });
        });

        if (!newMap.size) {
          statusEl.innerHTML = `<div class="status-ok" style="color:var(--red)">✗ No valid mapping rows found (${skipped} skipped).</div>`;
          return;
        }

        mappingTable = newMap;

        // FIX-MAPPING-PERSIST: save mapping to sessionStorage so it survives
        // soft page navigations within the same browser session.
        try {
          const serialized = JSON.stringify([...newMap.entries()]);
          sessionStorage.setItem("pharmatrack_mapping", serialized);
        } catch (_) { /* quota exceeded or private mode — silent */ }

        // Apply to current inventory (if loaded)
        if (rawDf.length) applyMaterialMapping();

        statusEl.innerHTML = `
          <div class="status-ok">✓ MAPPING LOADED</div>
          <div class="status-name">${escHtml(file.name)}</div>
          <div class="status-stats">${newMap.size.toLocaleString()} mapping rules${skipped ? ` · ${skipped} rows skipped` : ""}</div>
          ${mappingStats ? `<div class="status-stats">${mappingStats.mapped.toLocaleString()} materials mapped · ${mappingStats.valuePct}% of stock value</div>` : ""}`;
        document.getElementById("mappingUploadBtnText").textContent = "🗺️ Change Mapping File";

        // Re-render current page with mapped data
        if (rawDf.length) {
          const reRender = {
            dashboard: renderDashboard, transit: () => { renderTransit(); renderStockTransitSection(); },
            expiry: renderExpiry, qc: renderQC, branch: renderBranch, flow: renderFlow,
            incoming: renderIncomingShelfLife,
          };
          if (reRender[currentPage]) reRender[currentPage]();
        }
      } catch (err) {
        statusEl.innerHTML = `<div class="status-ok" style="color:var(--red)">✗ ${escHtml(err.message)}</div>`;
      }
    }, 30);
  };
  reader.readAsArrayBuffer(file);
}

/**
 * applyMaterialMapping()
 *   Walks rawDf and stamps every row with:
 *     _mappedMaterial  — target material code (or original if no mapping)
 *     _mappedDesc      — target description   (or original)
 *     _mappingFactor   — conversion factor     (1.0 if no mapping)
 *     _isMapped        — boolean: true = this row has a mapping entry
 *     _origMaterial    — always the original Material code (for traceability)
 *     _origDesc        — always the original Material Description
 *
 *   Converted quantity / value fields on the row object are also stamped:
 *     _cvUnrestricted, _cvTransit, _cvQC, _cvBlocked
 *     _cvValUnrestricted, _cvValTransit, _cvValQC
 *     _cvTotalQty, _cvTotalValue
 *
 *   The "Material" and "Material Description" fields are NOT mutated here —
 *   rendering helpers use _mappedMaterial / _mappedDesc so the original SAP
 *   code is always recoverable.
 *
 *   mappedDf is a shallow copy of rawDf with the above extra fields; all
 *   downstream render functions call getReconciledBase() which returns mappedDf
 *   when a mapping is active.
 *
 *   Also computes mappingStats { mapped, total, valuePct }.
 *
 *   PHARMA BEST PRACTICE: batches with different expiry dates are NEVER merged.
 *   The row-level conversion only rescales quantities; aggregation at a higher
 *   level groups by _mappedMaterial (and expiry for watchlist purposes).
 */
function applyMaterialMapping() {
  if (!rawDf.length) return;

  let mappedCount = 0;
  let totalValue  = 0;
  let mappedValue = 0;

  mappedDf = rawDf.map(row => {
    const srcCode = String(row["Material"] || "").trim().toUpperCase();
    const entry   = mappingTable.get(srcCode);
    totalValue += row["Total Value"] || 0;

    if (!entry) {
      // No mapping → keep original, factor = 1
      return {
        ...row,
        _mappedMaterial: row["Material"],
        _mappedDesc:     row["Material Description"],
        _mappingFactor:  1.0,
        _isMapped:       false,
        _origMaterial:   row["Material"],
        _origDesc:       row["Material Description"],
        // Converted = original (factor 1)
        _cvUnrestricted:    row["Unrestricted Stock"],
        _cvTransit:         row["Stock in Transit"],
        _cvQC:              row["Stock in Quality Inspection"],
        _cvBlocked:         row["Blocked Stock"],
        _cvValUnrestricted: row["Value of Unrestricted Stock"],
        _cvValTransit:      row["Value of Stock in Transit"],
        _cvValQC:           row["Value of Stock in Quality Inspection"],
        _cvTotalQty:        row["Total Qty"],
        _cvTotalValue:      row["Total Value"],
      };
    }

    // Mapping found — apply conversion factor
    const f = entry.factor;
    const cvUnrestricted    = parseFloat(((row["Unrestricted Stock"]              || 0) * f).toFixed(9));
    const cvTransit         = parseFloat(((row["Stock in Transit"]                || 0) * f).toFixed(9));
    const cvQC              = parseFloat(((row["Stock in Quality Inspection"]     || 0) * f).toFixed(9));
    const cvBlocked         = parseFloat(((row["Blocked Stock"]                   || 0) * f).toFixed(9));
    const cvValUnrestricted = parseFloat(((row["Value of Unrestricted Stock"]     || 0) * f).toFixed(9));
    const cvValTransit      = parseFloat(((row["Value of Stock in Transit"]       || 0) * f).toFixed(9));
    const cvValQC           = parseFloat(((row["Value of Stock in Quality Inspection"] || 0) * f).toFixed(9));
    const cvTotalQty        = cvUnrestricted + cvTransit + cvQC;
    const cvTotalValue      = cvValUnrestricted + cvValTransit + cvValQC;

    mappedCount++;
    mappedValue += cvTotalValue;

    return {
      ...row,
      // Keep original SAP fields intact — render functions read _mapped* for display
      _mappedMaterial: entry.targetCode,
      _mappedDesc:     entry.targetDesc || row["Material Description"],
      _mappingFactor:  f,
      _isMapped:       true,
      _origMaterial:   row["Material"],
      _origDesc:       row["Material Description"],
      _cvUnrestricted:    cvUnrestricted,
      _cvTransit:         cvTransit,
      _cvQC:              cvQC,
      _cvBlocked:         cvBlocked,
      _cvValUnrestricted: cvValUnrestricted,
      _cvValTransit:      cvValTransit,
      _cvValQC:           cvValQC,
      _cvTotalQty:        cvTotalQty,
      _cvTotalValue:      cvTotalValue,
    };
  });

  // Compute stats
  const valuePct = totalValue > 0 ? Math.round((mappedValue / totalValue) * 100) : 0;
  mappingStats = { mapped: mappedCount, total: rawDf.length, valuePct };

  // Refresh sidebar status to show stats
  const statusEl = document.getElementById("mappingFileStatus");
  if (statusEl && statusEl.style.display !== "none") {
    const existing = statusEl.innerHTML;
    // Only update the stats line; don't re-write if mid-load
    const statsDiv = statusEl.querySelector(".status-stats:last-child");
    if (statsDiv) statsDiv.textContent = `${mappedCount.toLocaleString()} materials mapped · ${valuePct}% of stock value`;
  }
}

/**
 * renderMappingBanner(containerId)
 *   Injects a purple info banner into the given element showing mapping status.
 *   No-ops if no mapping is active.
 */
function renderMappingBanner(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!mappingTable.size || !mappingStats) { el.innerHTML = ""; return; }
  const { mapped, total, valuePct } = mappingStats;
  el.innerHTML = `
    <div class="mapping-active-banner">
      ⚗️ Material Standardization Active —
      <b>${mapped.toLocaleString()} materials mapped</b> ·
      <b>${valuePct}%</b> of total stock value standardized ·
      <span style="font-size:0.7rem;color:var(--muted)">${mappingTable.size.toLocaleString()} mapping rules loaded</span>
    </div>`;
}

// Aliases — full implementations are renderMappedMatCode_early / renderMappedMatDesc_early above.
const renderMappedMatCode = renderMappedMatCode_early;
const renderMappedMatDesc = renderMappedMatDesc_early;

/**
 * getMappedQty(row, field)
 * getMappedVal(row, field)
 *   Return the standardized (converted) value for a quantity/value column.
 *   When mapping is not active or row is not mapped, return the raw SAP value.
 *   This is the single point of truth used by all aggregate functions.
 */
function getMappedQty(row, field) {
  if (!row._isMapped) return row[field] || 0;
  const cv = { "Unrestricted Stock": "_cvUnrestricted", "Stock in Transit": "_cvTransit", "Stock in Quality Inspection": "_cvQC", "Blocked Stock": "_cvBlocked" };
  return (cv[field] !== undefined ? row[cv[field]] : row[field]) || 0;
}
function getMappedVal(row, field) {
  if (!row._isMapped) return row[field] || 0;
  const cv = { "Value of Unrestricted Stock": "_cvValUnrestricted", "Value of Stock in Transit": "_cvValTransit", "Value of Stock in Quality Inspection": "_cvValQC" };
  return (cv[field] !== undefined ? row[cv[field]] : row[field]) || 0;
}

/**
 * getVerifiedTransitQty(row, field)
 * getVerifiedTransitVal(row, field)
 *   Return transit qty/value MINUS any phantom (unverified) portion.
 *   A transit row is "phantom" when it has Stock in Transit > 0 but no
 *   matching entry with BOTH Purchasing Document AND Supplying Plant in
 *   the transit detail file.  These items are physically unconfirmed and
 *   must be excluded from every aggregate shown to the user.
 *
 *   FIX-TRANSIT-NODOC: applied to Dashboard, Home, and Flow KPIs so that
 *   transit items without a Purchasing Document AND Supplying Plant are
 *   excluded from ALL displayed totals, not just the Branch Comparison and
 *   Transit pages where the fix was previously applied.
 */
function getVerifiedTransitQty(row) {
  const raw     = getMappedQty(row, "Stock in Transit");
  const phantom = row._phantomTransitQty || 0;
  return Math.max(0, raw - phantom);
}
function getVerifiedTransitVal(row) {
  const raw     = getMappedVal(row, "Value of Stock in Transit");
  const phantom = row._phantomTransitVal || 0;
  return Math.max(0, raw - phantom);
}
/**
 * Returns true if the row has transit stock that is backed by at least one
 * stockTransitRaw entry with BOTH a Purchasing Document AND a Supplying Plant.
 * When no transit file is loaded, falls back to true (cannot judge).
 */
function _hasVerifiedTransit(row) {
  if (!stockTransitRaw.length) return true; // no transit file — cannot exclude
  const mat = String(row["Material"] || "").trim();
  const plt = String(row["Plant"]    || "").trim().toUpperCase();
  return stockTransitRaw.some(r =>
    r._st_material === mat &&
    (plt === "" || r._st_plant.toUpperCase() === plt) &&
    r._st_purDoc && r._st_supPlant
  );
}

/**
 * aggregateByMappedMaterial(df)
 *   Like aggregateByMaterial but groups by _mappedMaterial (or Material when
 *   no mapping active), uses converted quantities, and preserves original code
 *   traceability via _origMaterial.
 */
function aggregateByMappedMaterial(df) {
  const useMapped = mappingTable.size > 0;
  const QTY_FIELDS = ["Unrestricted Stock","Stock in Quality Inspection","Blocked Stock","Stock in Transit"];
  const VAL_FIELDS = ["Value of Unrestricted Stock","Value of Stock in Quality Inspection","Value of Stock in Transit"];

  const matMap = {};
  df.forEach(row => {
    const mat = useMapped ? (row._mappedMaterial || row["Material"]) : row["Material"];
    if (!mat) return;
    if (!matMap[mat]) {
      matMap[mat] = {
        ...row,
        "Material":             mat,
        "Material Description": useMapped ? (row._mappedDesc || row["Material Description"]) : row["Material Description"],
        _mappedMaterial:        mat,
        _allPlants:             [],
        _origCodes:             new Set(),
      };
      // FIX-AGG-FIRST-ROW: zero all fields first then add the first row's
      // converted values via the same getMappedQty/getMappedVal path used for
      // subsequent rows.  Previously the first row's raw values (spread above)
      // were kept but subsequent rows were accumulated with the converted values,
      // causing a mismatch when a mapping factor != 1 was active.
      QTY_FIELDS.forEach(c => { matMap[mat][c] = getMappedQty(row, c); });
      VAL_FIELDS.forEach(c => { matMap[mat][c] = getMappedVal(row, c); });
      if (row["Plant Name"]) matMap[mat]._allPlants.push(row["Plant Name"]);
      if (row._origMaterial)  matMap[mat]._origCodes.add(row._origMaterial);
    } else {
      const target = matMap[mat];
      QTY_FIELDS.forEach(c => { target[c] += getMappedQty(row, c); });
      VAL_FIELDS.forEach(c => { target[c] += getMappedVal(row, c); });
      // Keep earliest expiry across all batches (pharma best practice)
      const te = target["_expiry"], se = row["_expiry"];
      if (se instanceof Date && !isNaN(se)) {
        if (!(te instanceof Date) || isNaN(te) || se < te) target["_expiry"] = se;
      }
      if (row["Plant Name"] && !target._allPlants.includes(row["Plant Name"])) {
        target._allPlants.push(row["Plant Name"]);
      }
      if (row._origMaterial)  target._origCodes.add(row._origMaterial);
      if (!target["Material Group Name"] && row["Material Group Name"]) target["Material Group Name"] = row["Material Group Name"];
    }
  });

  Object.values(matMap).forEach(row => {
    row["Total Qty"]   = (row["Unrestricted Stock"] || 0) + (row["Stock in Transit"] || 0) + (row["Stock in Quality Inspection"] || 0);
    row["Total Value"] = (row["Value of Unrestricted Stock"] || 0) + (row["Value of Stock in Transit"] || 0) + (row["Value of Stock in Quality Inspection"] || 0);
    const plants = (row._allPlants || []).filter(Boolean).sort();
    row["_plantList"]  = plants.length ? plants.join(", ") : (row["Plant Name"] || "—");
    // Build traceability string for detail tables
    const origCodes    = [...(row._origCodes || [])].filter(c => c !== row["Material"]);
    row._traceCodes    = origCodes.length ? origCodes.join(", ") : "";
  });

  return Object.values(matMap);
}

// ─────────────────────────────────────────────────────────────────────────────
// END MATERIAL STANDARDIZATION MAPPING
// ─────────────────────────────────────────────────────────────────────────────

function renderStockTransitSection() {
  const noFileEl  = document.getElementById("stock-transit-no-file");
  const contentEl = document.getElementById("stock-transit-content");

  if (!noFileEl || !contentEl) return; // elements not in DOM yet

  if (!stockTransitRaw.length) {
    noFileEl.style.display  = "block";
    contentEl.style.display = "none";
    return;
  }

  noFileEl.style.display  = "none";
  contentEl.style.display = "block";

  // Populate Purchasing Document filter dropdown
  const purDocs = [...new Set(stockTransitRaw.map(r => r._st_purDoc).filter(Boolean))].sort();
  const supPlants = [...new Set(stockTransitRaw.map(r => r._st_supPlant).filter(Boolean))].sort();

  const purDocEl   = document.getElementById("st-filter-pur-doc");
  const supPlantEl = document.getElementById("st-filter-sup-plant");

  purDocEl.innerHTML   = `<option value="">All Purchasing Documents</option>` +
    purDocs.map(d => `<option value="${escHtml(d)}"${stFilterState.purDoc === d ? " selected" : ""}>${escHtml(d)}</option>`).join("");
  supPlantEl.innerHTML = `<option value="">All Supplying Plants</option>` +
    supPlants.map(p => `<option value="${escHtml(p)}"${stFilterState.supPlant === p ? " selected" : ""}>${escHtml(p)}</option>`).join("");

  // Apply active filters from stFilterState
  let df = stockTransitRaw.filter(r =>
    (!stFilterState.purDoc   || r._st_purDoc   === stFilterState.purDoc) &&
    (!stFilterState.supPlant || r._st_supPlant === stFilterState.supPlant)
  );

  // KPIs
  const uniqMats    = new Set(df.map(r => r._st_material)).size;
  const uniqPurDocs = new Set(df.map(r => r._st_purDoc).filter(Boolean)).size;
  const uniqSup     = new Set(df.map(r => r._st_supPlant).filter(Boolean)).size;
  const totalQty    = df.reduce((s, r) => s + r._st_qty, 0);
  setKpis("st-kpis", [
    ["Total Records",          df.length.toLocaleString(),    "After filter",           "blue"],
    ["Unique Materials",       uniqMats.toLocaleString(),     "Distinct SKUs",          "green"],
    ["Purchasing Documents",   uniqPurDocs.toLocaleString(),  "Distinct POs/STO docs",  "amber"],
    ["Supplying Plants",       uniqSup.toLocaleString(),      "Source locations",       "purple"],
    ["Total Qty in Transit",   fmtQty(totalQty),              "Units",                  "blue"],
  ]);

  // Table columns
  const stCols = [
    { key: "_st_material",  label: "Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap" },
    { key: "_st_desc",     label: "Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap" },
    { key: "_st_plant",     label: "Plant Code" },
    { key: "_st_plantName", label: "Plant Name" },
    { key: "_st_purDoc",    label: "Purchasing Document" },
    { key: "_st_item",      label: "Item" },
    { key: "_st_supPlant",  label: "Supplying Plant" },
    { key: "_st_qty",       label: "Quantity", fmt: fmtQty, rawKey: "_st_qty", cellClass: "col-qty" },
    { key: "_st_uom",       label: "UOM" },
  ];

  document.getElementById("st-table-wrap").innerHTML = buildTable(df, stCols);
  document.getElementById("btn-dl-st-csv").onclick  = () => downloadCSV(df,   stCols, "stock_in_transit_detail.csv");
  document.getElementById("btn-dl-st-xlsx").onclick = () => downloadExcel(df, stCols, "stock_in_transit_detail.xlsx");
}

// ─── Within-Plant Transit ─────────────────────────────────────────────────
// Shows rows from stockTransitRaw where Plant == Supplying Plant
// (i.e. movement within the same location).
function renderWithinPlantTransit() {
  const noFileEl  = document.getElementById("within-plant-no-file");
  const contentEl = document.getElementById("within-plant-content");
  if (!noFileEl || !contentEl) return;

  if (!stockTransitRaw.length) {
    noFileEl.style.display  = "block";
    contentEl.style.display = "none";
    return;
  }

  noFileEl.style.display  = "none";
  contentEl.style.display = "block";

  // Filter: plant code matches supplying plant code (same location)
  const df = stockTransitRaw.filter(r =>
    r._st_plant && r._st_supPlant &&
    r._st_plant.trim().toUpperCase() === r._st_supPlant.trim().toUpperCase()
  );

  const uniqMats = new Set(df.map(r => r._st_material)).size;
  const totalQty = df.reduce((s, r) => s + r._st_qty, 0);
  const uniqPlants = new Set(df.map(r => r._st_plant).filter(Boolean)).size;

  setKpis("wp-kpis", [
    ["Within-Plant Records",  df.length.toLocaleString(),  "Same plant & supplying plant", "blue"],
    ["Unique Materials",      uniqMats.toLocaleString(),   "Distinct SKUs",                "green"],
    ["Plants Involved",       uniqPlants.toLocaleString(), "Locations",                    "purple"],
    ["Total Quantity",        fmtQty(totalQty),            "Units",                        "amber"],
  ]);

  const cols = [
    { key: "_st_material",  label: "Material Code",        fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap" },
    { key: "_st_desc",      label: "Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap" },
    { key: "_st_plant",     label: "Plant Code" },
    { key: "_st_plantName", label: "Plant Name" },
    { key: "_st_supPlant",  label: "Supplying Plant" },
    { key: "_st_purDoc",    label: "Purchasing Document" },
    { key: "_st_item",      label: "Item" },
    { key: "_st_qty",       label: "Quantity", fmt: fmtQty, rawKey: "_st_qty", cellClass: "col-qty" },
    { key: "_st_uom",       label: "UOM" },
  ];

  document.getElementById("wp-table-wrap").innerHTML = df.length
    ? buildTable(df, cols, () => "row-amber")
    : `<div class="alert-info">No within-plant transit movements found — no rows where Plant equals Supplying Plant.</div>`;

  document.getElementById("btn-dl-wp-csv").onclick  = () => downloadCSV(df,   cols, "within_plant_transit.csv");
  document.getElementById("btn-dl-wp-xlsx").onclick = () => downloadExcel(df, cols, "within_plant_transit.xlsx");
}

// ─── Lookup helper: get Purchasing Document(s) and Supplying Plant(s) ─────
// For a given material code + plant code, scans stockTransitRaw and returns
// deduplicated comma-separated values. Falls back to "—" when no transit file
// is loaded or no matching rows exist.
function getTransitInfo(material, plantCode) {
  if (!stockTransitRaw.length) return { purDoc: "—", supPlant: "—" };
  const mat  = String(material  || "").trim();
  const plt  = String(plantCode || "").trim().toUpperCase();
  const hits = stockTransitRaw.filter(r =>
    r._st_material === mat &&
    (plt === "" || r._st_plant.toUpperCase() === plt)
  );
  if (!hits.length) return { purDoc: "—", supPlant: "—" };
  const purDocs  = [...new Set(hits.map(r => r._st_purDoc).filter(Boolean))];
  const supPlants= [...new Set(hits.map(r => r._st_supPlant).filter(Boolean))];
  return {
    purDoc:   purDocs.length   ? purDocs.join(", ")   : "—",
    supPlant: supPlants.length ? supPlants.join(", ") : "—",
  };
}

// ─── Phantom Transit Detection ────────────────────────────────────────────
// A transit row is "phantom" (not physically available / unverifiable) when:
//   • The main data has Stock in Transit > 0, AND
//   • The transit detail file is loaded, AND
//   • No matching row in the transit detail has BOTH a Purchasing Document
//     AND a Supplying Plant for that material+plant combo.
//
// Phantom rows are EXCLUDED from all aggregate values (Total Value, Total Qty,
// Value of Stock in Transit, Stock in Transit) on Dashboard, Branch Comparison,
// and Inventory Flow. They are flagged with a warning badge on the Transit page.

function isPhantomTransit(row) {
  // If no transit file is loaded, we cannot judge — treat as valid
  if (!stockTransitRaw.length) return false;
  // Only relevant for rows that actually have transit stock
  if (!(row["Stock in Transit"] > 0)) return false;

  const mat = String(row["Material"] || "").trim();
  const plt = String(row["Plant"]    || "").trim().toUpperCase();
  const hits = stockTransitRaw.filter(r =>
    r._st_material === mat &&
    (plt === "" || r._st_plant.toUpperCase() === plt)
  );
  // No matching entry at all → phantom
  if (!hits.length) return true;
  // Has at least one row with BOTH purchasing doc AND supplying plant → valid
  const hasFullDoc = hits.some(r => r._st_purDoc && r._st_supPlant);
  return !hasFullDoc;
}

// Called after transit file loads OR after main file loads (when transit already exists).
// Stamps each rawDf row with _phantomTransitQty / _phantomTransitVal and
// recomputes Total Value / Total Qty to exclude phantom transit amounts.
// FIX-EXCL-SLOC: also re-purges stockTransitRaw entries whose material was entirely
// excluded from rawDf (defence-in-depth for the case where main file loads after transit).
function recomputePhantomTransit() {
  if (rawDf.length && stockTransitRaw.length) {
    const allowedMaterials = new Set(rawDf.map(r => String(r["Material"] || "").trim()));
    stockTransitRaw = stockTransitRaw.filter(r => allowedMaterials.has(r._st_material));
  }
  rawDf.forEach(row => {
    if (isPhantomTransit(row)) {
      row._phantomTransitQty = row["Stock in Transit"];
      row._phantomTransitVal = row["Value of Stock in Transit"];
    } else {
      row._phantomTransitQty = 0;
      row._phantomTransitVal = 0;
    }
    // Recompute derived totals excluding phantom transit
    row["Total Value"] = row["Value of Unrestricted Stock"]
                       + (row["Value of Stock in Transit"] - row._phantomTransitVal)
                       + row["Value of Stock in Quality Inspection"];
    row["Total Qty"]   = row["Unrestricted Stock"]
                       + (row["Stock in Transit"] - row._phantomTransitQty)
                       + row["Stock in Quality Inspection"];
  });
}

// Returns an object { count, qty, val } for phantom transit rows in a given df slice
function getPhantomSummary(df) {
  const rows = df.filter(r => r._phantomTransitQty > 0);
  return {
    count: rows.length,
    qty:   rows.reduce((s,r) => s + r._phantomTransitQty, 0),
    val:   rows.reduce((s,r) => s + r._phantomTransitVal, 0),
  };
}

// Renders a dismissible alert banner into the element with given id.
// Does nothing (clears el) if there are no phantom rows.
// FIX-PHANTOM-VISIBLE: the alert now includes an expand/collapse button so users
// can view the unverified items directly inline without navigating away.
// A unique alertId is derived from containerId so multiple alerts (dash, branch,
// flow) each have independent expand state.
function renderPhantomAlert(containerId, df) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const { count, qty, val } = getPhantomSummary(df);
  if (!count || !stockTransitRaw.length) {
    el.innerHTML = "";
    return;
  }

  // Collect the actual phantom rows from this df slice for the inline table
  const phantomRows = df.filter(r => r._phantomTransitQty > 0);
  const tableId = containerId + "-inline-tbl";

  const phantomCols = [
    {key:"Material", label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
    {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
    {key:"Material Group Name", label:"Material Group"},
    {key:"Plant Name",          label:"Plant"},
    {key:"_phantomTransitQty",  label:"Unverified Qty",        fmt:fmtQty, rawKey:"_phantomTransitQty", cellClass:"col-qty"},
    {key:"_phantomTransitVal",  label:"Unverified Value (ETB)", fmt:fmtETB, rawKey:"_phantomTransitVal", cellClass:"col-val"},
  ];

  const isTransitPage = (containerId === "transit-phantom-alert");
  // On transit page, the full phantom section is rendered separately via
  // renderPhantomTable — so the alert only needs a short "jump to section" link.
  const actionHtml = isTransitPage
    ? `<a class="phantom-alert-link" style="white-space:nowrap" onclick="document.querySelector('.transit-tab-btn[data-tab=unverified]').click()">View unverified items →</a>`
    : `<button class="phantom-alert-toggle" id="${tableId}-btn" onclick="(function(){
        var tbl=document.getElementById('${tableId}');
        var btn=document.getElementById('${tableId}-btn');
        var open=tbl.style.display!=='none';
        tbl.style.display=open?'none':'block';
        btn.textContent=open?'Show unverified items ▾':'Hide unverified items ▴';
      })()" style="background:none;border:1px solid var(--amber);color:var(--amber);border-radius:4px;padding:3px 10px;font-size:0.72rem;cursor:pointer;white-space:nowrap">Show unverified items ▾</button>
      <a class="phantom-alert-link" style="white-space:nowrap" onclick="renderPage('transit')">Transit page →</a>
      <div id="${tableId}" style="display:none;margin-top:0.75rem;max-height:320px;overflow-y:auto">${buildTable(phantomRows, phantomCols, () => "row-amber")}</div>`;

  el.innerHTML = `
    <div class="phantom-transit-alert">
      <span class="phantom-alert-icon">⚠️</span>
      <div class="phantom-alert-body">
        <strong>Unverified Transit Stock Excluded</strong>
        <span>${count.toLocaleString()} item${count!==1?"s":""} (${fmtQty(qty)} units · ${fmtETB(val)}) have <em>Stock in Transit</em> but
        lack a <em>Purchasing Document</em> and <em>Supplying Plant</em> in the transit detail file.
        These items are <strong>excluded from all totals</strong> — verify first.</span>
        <div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;margin-top:0.35rem">
          ${actionHtml}
        </div>
      </div>
    </div>`;
}

// ─── Phantom Transit Dedicated Section (Transit page only) ────────────────
// Renders the full unverified-items table with KPI summary and download into
// the #transit-phantom-section container on the Transit page.
// Called from renderTransit() whenever phantom rows exist.
function renderPhantomTable(df) {
  const sectionEl = document.getElementById("transit-phantom-section");
  if (!sectionEl) return;

  const phantomRows = df.filter(r => r._phantomTransitQty > 0);
  if (!phantomRows.length || !stockTransitRaw.length) {
    sectionEl.style.display = "none";
    sectionEl.innerHTML = "";
    return;
  }

  const totalPhantomQty = phantomRows.reduce((s,r) => s + r._phantomTransitQty, 0);
  const totalPhantomVal = phantomRows.reduce((s,r) => s + r._phantomTransitVal, 0);
  const uniqMats        = new Set(phantomRows.map(r => r._mappedMaterial || r["Material"])).size;
  const uniqPlants      = new Set(phantomRows.map(r => r["Plant Name"])).size;

  const phantomCols = [
    {key:"Material", label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
    {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
    {key:"Material Group Name",  label:"Material Group"},
    {key:"Plant",                label:"Plant Code"},
    {key:"Plant Name",           label:"Plant Name"},
    {key:"Storage Location",     label:"Storage Location"},
    {key:"_phantomTransitQty",   label:"Unverified Qty",         fmt:fmtQty, rawKey:"_phantomTransitQty", cellClass:"col-qty"},
    {key:"_phantomTransitVal",   label:"Unverified Value (ETB)",  fmt:fmtETB, rawKey:"_phantomTransitVal", cellClass:"col-val"},
  ];

  // Sort by value descending so highest-risk items are at the top
  const sorted = sortBy(phantomRows, "_phantomTransitVal");

  const dlId = "btn-dl-phantom-transit";
  sectionEl.style.display = "block";
  sectionEl.innerHTML = `
    <div class="phantom-transit-section-wrap" style="
      border:1px solid #d29922;border-radius:8px;padding:1rem 1.2rem;
      background:rgba(210,153,34,0.06);margin-bottom:1.5rem">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.8rem">
        <div>
          <div class="section-header" style="margin:0;color:#d29922">⚠️ Unverified Transit Items — No Purchasing Document &amp; Supplying Plant</div>
          <div style="font-size:0.76rem;color:var(--muted);margin-top:3px">
            These items appear in the SAP <em>Stock in Transit</em> column but have <strong>no matching entry</strong> in the
            transit detail file with both a Purchasing Document and Supplying Plant.
            They are <strong>excluded from all inventory totals</strong> until verified.
          </div>
        </div>
        <button class="dl-btn" id="${dlId}">⬇ Download CSV</button>
      </div>
      <div class="kpi-row" style="margin-bottom:0.9rem">
        ${[
          ["Unverified Items",    sorted.length.toLocaleString(),    "SAP rows without PO/plant",      "amber"],
          ["Unique Materials",    uniqMats.toLocaleString(),          "Distinct SKUs",                  "amber"],
          ["Affected Plants",     uniqPlants.toLocaleString(),        "Locations with unverified stock","amber"],
          ["Unverified Qty",      fmtQty(totalPhantomQty),           "Units not confirmed",            "amber"],
          ["Unverified Value",    fmtETB(totalPhantomVal),           "Excluded from totals",           "amber"],
        ].map(([l,v,s]) => `
          <div class="kpi-card amber">
            <div class="kpi-label">${escHtml(l)}</div>
            <div class="kpi-value">${escHtml(v)}</div>
            <div class="kpi-sub">${escHtml(s)}</div>
          </div>`).join("")}
      </div>
      <div id="phantom-transit-table-wrap">${buildTable(sorted, phantomCols, () => "row-amber")}</div>
    </div>`;

  document.getElementById(dlId).onclick = () => downloadCSV(sorted, phantomCols, "unverified_transit_items.csv");
}


// ═══════════════════════════════════════════════════════════════════════════
// TRANSIT
// ═══════════════════════════════════════════════════════════════════════════

// Holds the full transit rows (pre-built) so the search filter can re-slice them.
let _transitRowsCache = [];
let _transitColsCache = [];
// _ho01RowsCache removed — was declared but never populated or read (dead code)

function renderTransit() {
  // rawDf is pre-filtered at parse time — no need to re-apply isNonMedical* guards here.
  // Simply restrict to rows with positive transit qty and value.
  // FIX-PHANTOM-HIDE: phantom transit rows (no PO / no supplying plant) are excluded
  // from the main table entirely; they only appear in the transit detail file section.
  const df = applyPageFilter("transit").filter(r =>
    r["Stock in Transit"] > 0 &&
    r["Value of Stock in Transit"] > 0 &&
    !(r._phantomTransitQty > 0)   // exclude phantom rows from this table
  );

  const totalTV = df.reduce((s,r) => s + getMappedVal(r,"Value of Stock in Transit"), 0);
  const totalTQ = df.reduce((s,r) => s + getMappedQty(r,"Stock in Transit"), 0);
  const uniqMat = new Set(df.map(r => r._mappedMaterial||r["Material"])).size;

  // FIX-PHANTOM-VISIBLE: render the alert banner AND the dedicated unverified-items
  // table section on the Transit page so users can see and download phantom items.
  const allTransitDf = applyPageFilter("transit").filter(r => r["Stock in Transit"] > 0 && r["Value of Stock in Transit"] > 0);
  renderPhantomAlert("transit-phantom-alert", allTransitDf);
  renderPhantomTable(allTransitDf);

  // FIX-MAPPED-COUNT: count unique target materials for phantom KPI
  const phantomRows  = allTransitDf.filter(r => r._phantomTransitQty > 0);
  const phantomCount = new Set(phantomRows.map(r => r._mappedMaterial || r["Material"])).size;
  const phantomKpiExtra = phantomCount > 0 && stockTransitRaw.length
    ? [[`Unverified Transit Items`, String(phantomCount), "No PO & Supplying Plant — see bottom of page ↓", "amber"]]
    : [];

  setKpis("transit-kpis", [
    ["Total Transit Value",        fmtETB(totalTV), "Verified items only",  "amber"],
    ["Total Transit Quantity",     fmtQty(totalTQ), "Verified items only",  "blue"],
    ["Unique Materials in Transit",String(uniqMat), "Distinct SKUs",        "green"],
    ...phantomKpiExtra,
  ]);

  const transitCols = [
    {key:"Material", label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
    {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
    {key:"Material Group Name",       label:"Material Group"},
    {key:"Plant Name",                label:"Plant"},
    {key:"_purDoc",                   label:"Purchasing Document"},
    {key:"_supPlant",                 label:"Supplying Plant"},
    {key:"Stock in Transit",          label:"Transit Qty",       fmt:fmtQty, rawKey:"Stock in Transit",          cellClass:"col-qty"},
    {key:"Value of Stock in Transit", label:"Transit Value (ETB)",fmt:fmtETB, rawKey:"Value of Stock in Transit", cellClass:"col-val"},
    {key:"_status",                   label:"Status", raw:true},
  ];
  const transitRows = sortBy([...df], "Value of Stock in Transit").map(r => {
    const info = getTransitInfo(r["Material"], r["Plant"]);
    // BUG-FIX-3: removed dead isPhantom branch — df already filters out phantom rows
    // (!(r._phantomTransitQty > 0) above), so the badge-phantom branch could never
    // execute here. Status is now purely value-based.
    return {
      ...r,
      _purDoc:   info.purDoc,
      _supPlant: info.supPlant,
      _status: r["Value of Stock in Transit"] > 100000 ? "<span class='badge badge-red'>Critical</span>"
        : r["Value of Stock in Transit"] > 50000  ? "<span class='badge badge-amber'>High</span>"
        : r["Value of Stock in Transit"] > 10000  ? "<span class='badge badge-amber'>Medium</span>"
        : "<span class='badge badge-green'>Low</span>",
    };
  });

  // Cache rows for search filtering
  _transitRowsCache = transitRows;
  _transitColsCache = transitCols;

  // Wire chart
  if (df.length) {
    const plantAgg = sortBy(groupBy(df, "Plant Name", [["val","Value of Stock in Transit"],["qty","Stock in Transit"]]), "val");
    Plotly.newPlot("chart-transit-plant", [
      {type:"bar",  name:"Value (ETB)", x:plantAgg.map(r=>r["Plant Name"]), y:plantAgg.map(r=>r.val), yaxis:"y",  marker:{color:"#d29922"}, hovertemplate:"<b>%{x}</b><br>ETB %{y:,.0f}<extra></extra>"},
      {type:"scatter", mode:"lines+markers", name:"Qty", x:plantAgg.map(r=>r["Plant Name"]), y:plantAgg.map(r=>r.qty), yaxis:"y2", marker:{color:"#3fb950",size:8}, line:{color:"#3fb950"}, hovertemplate:"<b>%{x}</b><br>Qty: %{y:,.0f}<extra></extra>"},
    ], pl({height:280,margin:{l:20,r:60,t:20,b:80},yaxis2:{overlaying:"y",side:"right",gridcolor:"transparent",tickfont:{color:"#3fb950"}}}), PLOTLY_CONFIG);
  } else {
    document.getElementById("chart-transit-plant").innerHTML = "";
  }

  injectDlButtons("transit-dl-row",
    () => downloadCSV(_transitRowsCache,   transitCols.slice(0,-1), "transit_analysis.csv"),
    () => downloadExcel(_transitRowsCache, transitCols.slice(0,-1), "transit_analysis.xlsx"));

  // Show all filtered transit items directly (no search gate)
  document.getElementById("transit-table-wrap").innerHTML = transitRows.length
    ? buildTable(transitRows, transitCols, r => r._phantomTransitQty > 0 ? "row-red" : "")
    : `<div class="alert-info">No pharmaceutical transit items found.</div>`;
}

// NOTE: Transit material lookup is now handled via the Material filter-bar
// control (see ms-transit-mat) feeding applyPageFilter("transit") — the table
// above already reflects the current filter selection directly.

// ═══════════════════════════════════════════════════════════════════════════
// EXPIRY
// ═══════════════════════════════════════════════════════════════════════════
function renderExpiry() {
  const baseDf  = applyPageFilter("expiry");
  const months  = parseInt(document.querySelector('input[name="expWin"]:checked')?.value || 6);
  const today   = new Date();
  const cutoff  = new Date(today); cutoff.setMonth(cutoff.getMonth() + months);
  const valid   = baseDf.filter(r => r._expiry instanceof Date && !isNaN(r._expiry));

  const expiring     = valid.filter(r => r._expiry >= today && r._expiry <= cutoff && (r["Unrestricted Stock"]||0) > 0 && (r["Value of Unrestricted Stock"]||0) > 0);
  const expired      = valid.filter(r => r._expiry < today);
  // FIX BUG-4: filter zero-qty BEFORE the KPI count so KPI matches the table
  const expiredWithStock = expired.filter(r => (r["Unrestricted Stock"] || 0) > 0);
  const expiredZeroQty   = expired.length - expiredWithStock.length;

  // FIX-MAPPED-COUNT: count unique target materials so that multiple source codes
  // mapping to the same target material are counted as one item, not many.
  const getMatKey = r => r._mappedMaterial || r["Material"];
  const expiringUniq      = new Set(expiring.map(getMatKey)).size;
  const expiredStockUniq  = new Set(expiredWithStock.map(getMatKey)).size;

  setKpis("expiry-kpis", [
    ["Expiring in Window", String(expiringUniq),      `Items within next ${months} months`,             "amber"],
    // FIX BUG-4: use expiredWithStock count; FIX-MAPPED-COUNT: unique target materials
    ["Already Expired",   String(expiredStockUniq),  "Items with stock on hand requiring action",      "red"],
    ["At-Risk Value",     fmtETB(expiring.reduce((s,r) => s+getMappedVal(r,"Value of Unrestricted Stock"),0)), "Unrestricted stock value","purple"],
    ["At-Risk Quantity",  fmtQty(expiring.reduce((s,r) => s+getMappedQty(r,"Unrestricted Stock"),0)),          "Units expiring soon",     "amber"],
  ]);

  if (expiring.length) {
    const monthMap = {}, valMap = {};
    expiring.forEach(r => {
      const key = `${r._expiry.getFullYear()}-${String(r._expiry.getMonth()+1).padStart(2,"0")}`;
      monthMap[key] = (monthMap[key] || 0) + 1;
      valMap[key]   = (valMap[key]   || 0) + r["Value of Unrestricted Stock"];
    });
    const ms = Object.keys(monthMap).sort();
    Plotly.newPlot("chart-expiry-timeline", [
      {type:"bar",   name:"Items Count",   x:ms, y:ms.map(m=>monthMap[m]), marker:{color:"#d29922"}, hovertemplate:"<b>%{x}</b><br>%{y} items<extra></extra>"},
      {type:"scatter",mode:"lines+markers",name:"Value at Risk", x:ms, y:ms.map(m=>valMap[m]), yaxis:"y2", marker:{color:"#f85149",size:8}, line:{color:"#f85149"}, hovertemplate:"<b>%{x}</b><br>ETB %{y:,.0f}<extra></extra>"},
    ], pl({height:260,margin:{l:20,r:60,t:20,b:60},yaxis2:{overlaying:"y",side:"right",gridcolor:"transparent",tickfont:{color:"#f85149"}}}), PLOTLY_CONFIG);

    document.getElementById("chart-expiry-timeline").on("plotly_click", function(data) {
      const pt = data.points[0];
      const monthKey = pt.x;
      const [yr, mo] = monthKey.split("-").map(Number);
      const monthItems = expiring.filter(r => r._expiry.getFullYear() === yr && r._expiry.getMonth() + 1 === mo);
      const drillCols = [
        {key:"Material", label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
        {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
        {key:"Material Group Name",         label:"Material Group"},
        {key:"Plant Name",                  label:"Plant"},
        {key:"Description of Storage Location", label:"Storage Location"},
        {key:"_expiryStr",                  label:"Expiry Date"},
        {key:"Unrestricted Stock",          label:"Qty",        fmt:fmtQty, rawKey:"Unrestricted Stock",       cellClass:"col-qty"},
        {key:"Value of Unrestricted Stock", label:"Value (ETB)",fmt:fmtETB, rawKey:"Value of Unrestricted Stock",cellClass:"col-val"},
        {key:"_daysLeft",                   label:"Days Left"},
      ];
      const drillRows = sortBy(
        monthItems.map(r => ({
          ...r,
          _expiryStr: r._expiry ? fmtLocalDate(r._expiry) : "",
          _daysLeft:  r._expiry ? Math.floor((r._expiry - new Date()) / 86400000) : 9999,
        })),
        "_daysLeft", true
      );
      const totalVal   = monthItems.reduce((s,r) => s+r["Value of Unrestricted Stock"], 0);
      const totalQty   = monthItems.reduce((s,r) => s+r["Unrestricted Stock"], 0);
      const monthLabel = new Date(yr, mo-1, 1).toLocaleString("default", {month:"long", year:"numeric"});
      document.getElementById("expiry-drill-title").textContent = "📅 " + monthLabel;
      document.getElementById("expiry-drill-meta").textContent  = `${drillRows.length} items · ${fmtQty(totalQty)} units · ${fmtETB(totalVal)}`;
      document.getElementById("expiry-drill-table").innerHTML   = drillRows.length
        ? buildTable(drillRows, drillCols, r => r._daysLeft <= 30 ? "row-red" : r._daysLeft <= 90 ? "row-amber" : "")
        : '<div class="alert-info">No items for this month.</div>';
      const drillEl = document.getElementById("expiry-drilldown");
      drillEl.style.display = "block";
      drillEl.scrollIntoView({ behavior:"smooth", block:"nearest" });
      document.getElementById("expiry-drill-dl-csv").onclick  = () => downloadCSV(drillRows,  drillCols, `expiry_${monthKey}.csv`);
      document.getElementById("expiry-drill-dl-xlsx").onclick = () => downloadExcel(drillRows, drillCols, `expiry_${monthKey}.xlsx`);
    });
    document.getElementById("expiry-drill-close").onclick = () => {
      document.getElementById("expiry-drilldown").style.display = "none";
    };
  } else {
    document.getElementById("chart-expiry-timeline").innerHTML = "";
    document.getElementById("expiry-drilldown").style.display  = "none";
  }

  // Detailed batch/location table — driven by the Material filter in the
  // filter bar (replaces the old free-text Material Lookup search box).
  renderExpiryDetailTable(baseDf, today);

  if (expiredWithStock.length) {
    document.getElementById("expired-section").style.display = "block";
    const zeroNote = expiredZeroQty
      ? ` <span style="font-size:0.72rem;color:var(--muted);font-weight:400">(${expiredZeroQty} zero-qty records hidden)</span>`
      : "";
    document.getElementById("expired-header").innerHTML = `🔴 Already Expired Items (${expiredWithStock.length})${zeroNote}`;
    const expiredRows = expiredWithStock.map(r => ({...r, _expiryStr: r._expiry ? fmtLocalDate(r._expiry) : ""}));
    const expiredCols = [
      {key:"Material", label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
      {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
      {key:"Material Group Name",            label:"Material Group"},
      {key:"Plant Name",                     label:"Plant"},
      {key:"Description of Storage Location",label:"Storage Location"},
      {key:"_expiryStr",                     label:"Expiry Date"},
      {key:"Unrestricted Stock",             label:"Qty", fmt:fmtQty, rawKey:"Unrestricted Stock", cellClass:"col-qty"},
    ];
    document.getElementById("expired-table-wrap").innerHTML = buildTable(expiredRows, expiredCols);
    document.getElementById("btn-dl-expired-csv").onclick  = () => downloadCSV(expiredRows,   expiredCols, "expired_items.csv");
    document.getElementById("btn-dl-expired-xlsx").onclick = () => downloadExcel(expiredRows, expiredCols, "expired_items.xlsx");
  } else {
    document.getElementById("expired-section").style.display = "none";
  }
}

// ── MATERIAL-FILTERED EXPIRY DETAIL TABLE ─────────────────────────────────
// Replaces the old free-text "Material Lookup" search box. The Material
// filter in the filter bar narrows baseDf via applyPageFilter("expiry");
// this renders the resulting batch/location-level detail. Left blank with a
// prompt when no material is selected, so the page doesn't dump every batch
// row by default.
function renderExpiryDetailTable(baseDf, today) {
  const wrap = document.getElementById("expiry-table-wrap");
  const selectedMaterials = pageFilters.expiry.materials || [];

  if (!selectedMaterials.length) {
    wrap.innerHTML = `<div class="alert-info">🔍 Select one or more materials in the filter bar above to view detailed batch/location-level expiry data.</div>`;
    document.getElementById("expiry-dl-row").innerHTML = "";
    return;
  }

  const matches = baseDf.filter(r => (r["Unrestricted Stock"] || 0) > 0 && (r["Value of Unrestricted Stock"] || 0) > 0);
  if (!matches.length) {
    wrap.innerHTML = `<div class="alert-info">No batch/location records found for the selected material(s).</div>`;
    document.getElementById("expiry-dl-row").innerHTML = "";
    return;
  }

  const annotated = matches.map(r => {
    const expiryStr = r._expiry ? fmtLocalDate(r._expiry) : "—";
    let daysLeft = null, statusLabel = "No Expiry Date", statusClass = "";
    if (r._expiry instanceof Date && !isNaN(r._expiry)) {
      daysLeft = Math.floor((r._expiry - today) / 86400000);
      if      (daysLeft < 0)   { statusLabel = `Expired ${Math.abs(daysLeft)}d ago`; statusClass = "row-red";   }
      else if (daysLeft <= 30)  { statusLabel = `${daysLeft}d left`;                  statusClass = "row-red";   }
      else if (daysLeft <= 180) { statusLabel = `${daysLeft}d left`;                  statusClass = "row-amber"; }
      else                      { statusLabel = `${daysLeft}d left`;                  statusClass = "";          }
    }
    return { ...r, _expiryStr: expiryStr, _daysLeft: daysLeft ?? 99999, _statusLabel: statusLabel, _statusClass: statusClass };
  });

  const sorted     = annotated.sort((a,b) => a._daysLeft - b._daysLeft);
  const uniqueMats = [...new Set(sorted.map(r => r["Material"]))];
  const summary    = `<div style="font-size:0.78rem;color:var(--muted);margin-bottom:0.5rem">
    Showing <b style="color:var(--text)">${sorted.length}</b> batch/location record(s) across
    <b style="color:var(--text)">${uniqueMats.length}</b> material code(s)
  </div>`;

  const cols = [
    {key:"Material", label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
    {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
    {key:"Plant Name",                     label:"Plant"},
    {key:"Description of Storage Location",label:"Storage Location"},
    {key:"Batch",                          label:"Batch"},
    {key:"_expiryStr",                     label:"Expiry Date"},
    {key:"_statusLabel",                   label:"Status"},
    {key:"Unrestricted Stock",             label:"Avail Qty",   fmt:fmtQty, rawKey:"Unrestricted Stock",          cellClass:"col-qty"},
    {key:"Value of Unrestricted Stock",    label:"Value (ETB)", fmt:fmtETB, rawKey:"Value of Unrestricted Stock", cellClass:"col-val"},
  ];

  wrap.innerHTML = summary + buildTable(sorted, cols, r => r._statusClass);

  // Export buttons
  injectDlButtons("expiry-dl-row",
    () => downloadCSV(sorted,   cols, "expiry_detail.csv"),
    () => downloadExcel(sorted, cols, "expiry_detail.xlsx"));
}

// NOTE: QC and Flow material lookup are now handled via the Material
// filter-bar control (ms-qc-mat / ms-flow-mat) feeding applyPageFilter() —
// renderQC() and renderFlow() below already reflect the current selection.


function renderQC() {
  // FIX BUG-6: removed "&& r["Value of Stock in Quality Inspection"] > 0"
  // SAP sometimes records QC qty > 0 with zero ETB value (non-valuated batches,
  // consignment stock) — these must still appear for physical count audits.
  // RECONCILIATION: aggregate all source codes into their target canonical code
  // so each material appears exactly once (e.g. three ASA variants → one total).
  const rawFiltered = applyPageFilter("qc").filter(r => r["Stock in Quality Inspection"] > 0);
  const df          = aggregateByMappedMaterial(rawFiltered).filter(r => r["Stock in Quality Inspection"] > 0);

  const totalQCVal = df.reduce((s,r) => s + r["Value of Stock in Quality Inspection"], 0);
  const totalQCQty = df.reduce((s,r) => s + r["Stock in Quality Inspection"], 0);
  setKpis("qc-kpis", [
    ["Total Value in QC", fmtETB(totalQCVal), "Across all plants",      "red"],
    ["Total QC Quantity", fmtQty(totalQCQty), "Units under inspection", "amber"],
    ["Unique Materials",  String(new Set(df.map(r=>r["Material"])).size),"Distinct SKUs","blue"],
  ]);

  if (!df.length) { document.getElementById("qc-table-wrap").innerHTML = `<div class="alert-info">✓ No items in quality inspection.</div>`; return; }

  const plantQC = sortBy(groupBy(rawFiltered, "Plant Name", [["val","Value of Stock in Quality Inspection"],["qty","Stock in Quality Inspection"]]), "val");
  Plotly.newPlot("chart-qc-plant", [
    {type:"bar",     name:"Value (ETB)", x:plantQC.map(r=>r["Plant Name"]), y:plantQC.map(r=>r.val), yaxis:"y",  marker:{color:"#f85149"}, hovertemplate:"<b>%{x}</b><br>ETB %{y:,.0f}<extra></extra>"},
    {type:"scatter", mode:"lines+markers", name:"Qty", x:plantQC.map(r=>r["Plant Name"]), y:plantQC.map(r=>r.qty), yaxis:"y2", marker:{color:"#3fb950",size:8}, line:{color:"#3fb950"}, hovertemplate:"<b>%{x}</b><br>Qty: %{y:,.0f}<extra></extra>"},
  ], pl({height:280,margin:{l:20,r:60,t:20,b:80},yaxis2:{overlaying:"y",side:"right",gridcolor:"transparent",tickfont:{color:"#3fb950"}}}), PLOTLY_CONFIG);

  const qcCols = [
    {key:"Material", label:"Material Code", fmt:(val,r)=>renderMappedMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
    {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMappedMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
    {key:"Material Group Name",                  label:"Material Group"},
    {key:"_plantList",                           label:"Plant(s)"},
    {key:"_expiryStr",                           label:"Shelf Life Expiry"},
    {key:"Stock in Quality Inspection",          label:"QC Qty",        fmt:fmtQty, rawKey:"Stock in Quality Inspection", cellClass:"col-qty"},
    {key:"Value of Stock in Quality Inspection", label:"QC Value (ETB)",fmt:fmtETB, rawKey:"Value of Stock in Quality Inspection", cellClass:"col-val"},
  ];

  const qcRows = sortBy(
    [...df].map(r => ({
      ...r,
      _expiryStr: r._expiry ? fmtLocalDate(r._expiry) : "",
    })),
    "Value of Stock in Quality Inspection"
  );
  document.getElementById("qc-table-wrap").innerHTML = buildTable(qcRows, qcCols, r => r["Value of Stock in Quality Inspection"] > 10000 ? "row-red" : "");
  injectDlButtons("qc-dl-row",
    () => downloadCSV(qcRows,   qcCols, "qc_inspection.csv"),
    () => downloadExcel(qcRows, qcCols, "qc_inspection.xlsx"));

  // ── DAYS IN QUALITY PANEL ─────────────────────────────────────────────────
  // For each QC item at HO01, look up the matching posting date from the
  // received goods file (_incomingRawAll) using Material + Batch as the key.
  // Days in QC = today − posting date (calendar days).
  _renderQCDaysPanel(qcRows);
}

/**
 * Builds the "Days in Quality — HO01" side panel.
 *
 * Logic:
 *  1. Filter qcRows to HO01 plant ONLY — this panel is not meaningful for
 *     other plants because receipt data (_incomingRawAll) is HO01-scoped.
 *  2. Build a lookup map from _incomingRawAll keyed by "MATERIAL||BATCH"
 *     → latest posting date across all receipts for that pair.
 *  3. For each HO01 QC row, find its matching posting date.
 *  4. daysInQC = floor((today − postingDate) / 86400000)
 *  5. Render a compact table sorted descending by days (oldest first).
 *
 * Only rows with a matched posting date are shown; rows with no receipt
 * record show "—" in the days column but are still listed so the analyst
 * can see the gap.
 */
function _renderQCDaysPanel(qcRows) {
  const wrap = document.getElementById("qc-days-wrap");
  if (!wrap) return;

  // ── Step 0: restrict to HO01 plant ONLY ─────────────────────────────────
  // qcRows come from aggregateByMaterial() which collapses all plants into one
  // row per material. We use rawDf to get the true HO01-only QC rows so the
  // days calculation is accurate and not mixed with other branches.
  const ho01QCRaw = (rawDf || []).filter(r => {
    const plant = String(r["Plant"] || "").trim().toUpperCase();
    const qcQty = Number(r["Stock in Quality Inspection"]) || 0;
    return plant === "HO01" && qcQty > 0;
  });

  // If there are no HO01 QC items, say so and exit.
  if (!ho01QCRaw.length) {
    wrap.innerHTML = `<div class="alert-info" style="font-size:0.78rem">
      ℹ️ No Quality Inspection stock found for <strong>HO01</strong>.
      This panel only shows HO01 items — other plants are excluded.
    </div>`;
    const dlRow = document.getElementById("qc-days-dl-row");
    if (dlRow) dlRow.innerHTML = "";
    return;
  }

  // ── Step 1: build posting-date lookup from received goods data ──────────
  // _incomingRawAll holds every HO01 receipt row (ungrouped, all ZME/ZMS/ZLC).
  // We want the LATEST posting date per Material+Batch pair.
  const postingMap = new Map(); // key: "MAT||BATCH" → latest Date
  (_incomingRawAll || []).forEach(r => {
    const mat   = String(r["Material"] || "").trim().toUpperCase();
    const batch = String(r["Batch"]    || "").trim().toUpperCase();
    if (!mat || !batch) return;
    const key  = `${mat}||${batch}`;
    const date = r._postingDate instanceof Date && !isNaN(r._postingDate) ? r._postingDate : null;
    if (!date) return;
    const existing = postingMap.get(key);
    if (!existing || date.getTime() > existing.getTime()) {
      postingMap.set(key, date);
    }
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const MS_PER_DAY = 86400000;

  // ── Step 2: annotate each HO01 QC row with days-in-QC ──────────────────
  // Use raw HO01 rows directly — each row has its own Batch field so the
  // posting-date lookup is accurate per batch, not per aggregated material.
  const daysRows = ho01QCRaw.map(r => {
    const mat   = String(r["Material"] || r._mappedMaterial || "").trim().toUpperCase();
    const batch = String(r["Batch"]    || "").trim().toUpperCase();

    let postingDate = null;

    // Direct match on material + batch
    if (batch) {
      const key = `${mat}||${batch}`;
      postingDate = postingMap.get(key) || null;
    }

    // If no direct batch hit, try every source batch in _sourceBatches (mapped rows)
    if (!postingDate && Array.isArray(r._sourceBatches)) {
      for (const sb of r._sourceBatches) {
        const sbKey = `${mat}||${String(sb || "").trim().toUpperCase()}`;
        const d = postingMap.get(sbKey);
        if (d) { postingDate = d; break; }
      }
    }

    // Also try original material code if the row was standardized
    if (!postingDate && r._origMaterial) {
      const origMat = String(r._origMaterial).trim().toUpperCase();
      const key2 = `${origMat}||${batch}`;
      postingDate = postingMap.get(key2) || null;
    }

    let daysInQC = null;
    if (postingDate instanceof Date && !isNaN(postingDate)) {
      daysInQC = Math.floor((today.getTime() - postingDate.getTime()) / MS_PER_DAY);
      if (daysInQC < 0) daysInQC = null; // posting date in the future → data error
    }

    return {
      ...r,
      _postingDate: postingDate,
      _daysInQC:    daysInQC,
    };
  });

  // Sort: rows with a known days count first (oldest = most days at top),
  // then rows with no match (posting date unknown) at the bottom.
  daysRows.sort((a, b) => {
    if (a._daysInQC !== null && b._daysInQC !== null) return b._daysInQC - a._daysInQC;
    if (a._daysInQC !== null) return -1;
    if (b._daysInQC !== null) return  1;
    return 0;
  });

  // ── Step 3: render ───────────────────────────────────────────────────────
  if (!daysRows.length) {
    wrap.innerHTML = `<div class="alert-info" style="font-size:0.78rem">No QC items to display.</div>`;
    const dlRow = document.getElementById("qc-days-dl-row");
    if (dlRow) dlRow.innerHTML = "";
    return;
  }

  const hasAnyMatch = daysRows.some(r => r._daysInQC !== null);
  if (!hasAnyMatch && !(_incomingRawAll || []).length) {
    wrap.innerHTML = `<div class="alert-info" style="font-size:0.78rem">
      Upload a <b>Received Goods Excel</b> file to calculate days in quality inspection.
    </div>`;
    const dlRow = document.getElementById("qc-days-dl-row");
    if (dlRow) dlRow.innerHTML = "";
    return;
  }

  // Badge colour helper: green ≤14d, amber 15–30d, red >30d
  function daysBadge(days) {
    if (days === null) return `<span style="color:var(--dim);font-size:0.8rem">—</span>`;
    const color = days <= 14 ? "var(--green)" : days <= 30 ? "var(--amber)" : "var(--red)";
    return `<span style="
      display:inline-block;
      background:${color}22;
      color:${color};
      border:1px solid ${color}66;
      border-radius:4px;
      padding:1px 7px;
      font-size:0.78rem;
      font-weight:600;
      font-family:'IBM Plex Mono',monospace;
      min-width:40px;
      text-align:center;
    ">${days}d</span>`;
  }

  let html = `
    <div style="font-size:0.68rem;color:var(--muted);margin-bottom:0.5rem;display:flex;gap:0.8rem;flex-wrap:wrap">
      <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--green);margin-right:3px"></span>≤14 days</span>
      <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--amber);margin-right:3px"></span>15–30 days</span>
      <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--red);margin-right:3px"></span>&gt;30 days</span>
    </div>
    <div class="tbl-wrap" style="max-height:520px;overflow-y:auto">
    <table style="font-size:0.76rem;width:100%">
      <thead>
        <tr>
          <th style="text-align:left;padding:5px 8px;white-space:nowrap">Material</th>
          <th style="text-align:left;padding:5px 8px;white-space:nowrap">Batch</th>
          <th style="text-align:left;padding:5px 8px;white-space:nowrap">Posting Date</th>
          <th style="text-align:center;padding:5px 8px;white-space:nowrap">Days in QC</th>
        </tr>
      </thead>
      <tbody>`;

  daysRows.forEach(r => {
    const mat   = escHtml(String(r["Material"] || r._mappedMaterial || "").trim());
    const batch = escHtml(String(r["Batch"]    || "").trim() || "—");
    const pd    = r._postingDate ? fmtLocalDate(r._postingDate) : "—";
    const badge = daysBadge(r._daysInQC);
    html += `<tr>
      <td style="padding:5px 8px;font-family:'IBM Plex Mono',monospace;font-size:0.73rem;color:var(--purple)">${mat}</td>
      <td style="padding:5px 8px;font-size:0.73rem;color:var(--muted)">${batch}</td>
      <td style="padding:5px 8px;font-size:0.73rem;color:var(--muted);white-space:nowrap">${pd}</td>
      <td style="padding:5px 8px;text-align:center">${badge}</td>
    </tr>`;
  });

  html += `</tbody></table></div>`;

  // Summary line
  const matched  = daysRows.filter(r => r._daysInQC !== null).length;
  const total    = daysRows.length;
  const avgDays  = matched
    ? Math.round(daysRows.filter(r => r._daysInQC !== null).reduce((s,r) => s + r._daysInQC, 0) / matched)
    : null;

  html += `<div style="margin-top:0.5rem;font-size:0.68rem;color:var(--muted);display:flex;gap:1rem;flex-wrap:wrap">
    <span>Matched: <strong style="color:var(--text)">${matched}/${total}</strong></span>
    ${avgDays !== null ? `<span>Avg days: <strong style="color:var(--amber)">${avgDays}d</strong></span>` : ""}
  </div>`;

  wrap.innerHTML = html;

  // ── Export wiring ────────────────────────────────────────────────────────
  const exportRows = daysRows.map(r => ({
    Material:     String(r["Material"] || r._mappedMaterial || "").trim(),
    Batch:        String(r["Batch"] || "").trim(),
    PostingDate:  r._postingDate ? fmtLocalDate(r._postingDate) : "",
    DaysInQC:     r._daysInQC !== null ? r._daysInQC : "",
  }));
  const exportCols = [
    {key:"Material",    label:"Material"},
    {key:"Batch",       label:"Batch"},
    {key:"PostingDate", label:"Posting Date"},
    {key:"DaysInQC",    label:"Days in QC"},
  ];
  injectDlButtons("qc-days-dl-row",
    () => downloadCSV(exportRows,   exportCols, "days_in_quality_inspection.csv"),
    () => downloadExcel(exportRows, exportCols, "days_in_quality_inspection.xlsx"),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// BRANCH COMPARISON
// ═══════════════════════════════════════════════════════════════════════════
function renderBranch() {
  // BUG-BRANCH-1 FIX: Use baseDf (pre-aggregation, one row per plant per material)
  // for branch totals and matPlantMap. aggregateByMaterial collapses all plants into
  // a single row per material so it CANNOT be used for per-branch breakdowns.
  // aggregateByMaterial is still used for the material tab (Tab 2) display only.
  const baseDf = applyPageFilter("branch");


  const plants = [...new Set(baseDf.map(r => String(r["Plant"]).toUpperCase()))];
  // BUG-FIX-6: centralCode was computed but never read anywhere — removed dead variable.
  // All downstream logic uses centralName (the display name).
  let centralName;
  if (plants.includes("HO01")) {
    centralName = baseDf.find(r => String(r["Plant"]).toUpperCase() === "HO01")?.["Plant Name"] || "HO01";
    document.getElementById("branch-central-info").style.display = "none";
  } else {
    const totals = {};
    baseDf.forEach(r => { const p = r["Plant Name"]; totals[p] = (totals[p] || 0) + r["Total Value"]; });
    centralName = Object.entries(totals).sort((a,b) => b[1]-a[1])[0]?.[0] || "";
    document.getElementById("branch-central-info").style.display = "block";
    document.getElementById("branch-central-info").innerHTML = `ℹ️ HO01 not found — using <b>${escHtml(centralName)}</b> as central branch (highest inventory value).`;
  }

  const aggMap = {};
  const aggMatSets = {}; // separate Sets to count unique materials without mutating aggMap
  baseDf.forEach(r => {
    const k = r["Plant Name"];
    if (!aggMap[k]) { aggMap[k] = {PlantName:k,Plant:r["Plant"],TotalValue:0,Unrestricted:0,Transit:0,QC:0,UnrestrictedQty:0,TransitQty:0,QCQty:0,Items:0}; aggMatSets[k] = new Set(); }
    aggMap[k].TotalValue      += getMappedVal(r,"Value of Unrestricted Stock") + getMappedVal(r,"Value of Stock in Transit") + getMappedVal(r,"Value of Stock in Quality Inspection");
    aggMap[k].Unrestricted    += getMappedVal(r,"Value of Unrestricted Stock");
    // FIX-PHANTOM-BRANCH: exclude phantom (no PO/supplying plant) transit from branch totals
    const phantomVal = r._phantomTransitVal || 0;
    const phantomQty = r._phantomTransitQty || 0;
    aggMap[k].Transit         += getMappedVal(r,"Value of Stock in Transit") - phantomVal;
    aggMap[k].QC              += getMappedVal(r,"Value of Stock in Quality Inspection");
    aggMap[k].UnrestrictedQty += getMappedQty(r,"Unrestricted Stock");
    aggMap[k].TransitQty      += getMappedQty(r,"Stock in Transit") - phantomQty;
    aggMap[k].QCQty           += getMappedQty(r,"Stock in Quality Inspection");
    const matKey = (mappingTable.size > 0 ? r._mappedMaterial : null) || r["Material"];
    aggMatSets[k].add(String(matKey));
  });
  // Assign correct unique-material counts after accumulation
  Object.keys(aggMap).forEach(k => { aggMap[k].Items = aggMatSets[k].size; });
  const branchAgg = Object.values(aggMap);
  const others    = branchAgg.map(r => r.PlantName).filter(b => b !== centralName);

  // BUG-BRANCH-1 FIX: Build matPlantMap from baseDf so every (material, plant) pair
  // is a separate bucket. Using aggregated df would give only one plant per material.
  const matPlantMap = {};
  baseDf.forEach(r => {
    const mat = (mappingTable.size > 0 ? r._mappedMaterial : null) || r["Material"];
    const pln = r["Plant Name"];
    if (!matPlantMap[mat]) {
      matPlantMap[mat] = {
        desc:    (mappingTable.size > 0 ? r._mappedDesc : null) || r["Material Description"],
        group:   r["Material Group Name"],
        valType: getValuationType(r),
      };
    }
    if (!matPlantMap[mat][pln]) matPlantMap[mat][pln] = {Unrestricted:0,Transit:0,QC:0,TotalValue:0,TotalQty:0,UnrestrictedQty:0,TransitQty:0,QCQty:0};
    matPlantMap[mat][pln].Unrestricted    += getMappedVal(r,"Value of Unrestricted Stock");
    // FIX-PHANTOM-BRANCH: exclude phantom transit from per-material-per-branch data
    const phantomVal = r._phantomTransitVal || 0;
    const phantomQty = r._phantomTransitQty || 0;
    matPlantMap[mat][pln].Transit         += getMappedVal(r,"Value of Stock in Transit") - phantomVal;
    matPlantMap[mat][pln].QC             += getMappedVal(r,"Value of Stock in Quality Inspection");
    matPlantMap[mat][pln].TotalValue      += getMappedVal(r,"Value of Unrestricted Stock") + getMappedVal(r,"Value of Stock in Transit") - phantomVal + getMappedVal(r,"Value of Stock in Quality Inspection");
    // BUG-BRANCH-2 FIX: TotalQty is derived — recompute rather than accumulate
    matPlantMap[mat][pln].UnrestrictedQty += getMappedQty(r,"Unrestricted Stock");
    matPlantMap[mat][pln].TransitQty      += getMappedQty(r,"Stock in Transit") - phantomQty;
    matPlantMap[mat][pln].QCQty           += getMappedQty(r,"Stock in Quality Inspection");
    matPlantMap[mat][pln].TotalQty        = matPlantMap[mat][pln].UnrestrictedQty
                                          + matPlantMap[mat][pln].TransitQty
                                          + matPlantMap[mat][pln].QCQty;
  });
  // aggregated df is still needed for the material-level Tab 2 table display
  const df = aggregateByMappedMaterial(baseDf);

  const tabsHtml = `
    <div id="branch-tab-material"></div>`;
  document.getElementById("branch-tabs-wrap").innerHTML = tabsHtml;

  // FIX-R7: replaced native <select multiple> with buildMultiSelect for UX consistency.
  const branchWrapId = "ms-branch-select";
  const branchDdId   = "ms-branch-select-dd";
  buildMultiSelect(branchWrapId, branchDdId, others, "All Branches");
  // Pre-select all branches so the chart renders immediately without requiring user interaction.
  // FIX-BRANCH-PRESELECT: buildMultiSelect leaves checkboxes unchecked by default.
  // We must explicitly check them so _getSelected() returns all branches on first render.
  const branchWrap = document.getElementById(branchWrapId);
  setTimeout(() => {
    const branchDd = document.getElementById(branchDdId);
    if (branchDd) {
      branchDd.querySelectorAll("input[type=checkbox]").forEach(cb => { cb.checked = true; });
      // Trigger label update if the buildMultiSelect exposed it (call the internal updateLabel via change event)
      branchDd.querySelectorAll("input[type=checkbox]").forEach(cb => cb.dispatchEvent(new Event("change")));
    }
  }, 0);

  function getSelectedBranches() {
    if (!branchWrap || !branchWrap._getSelected) return others;
    const sel = branchWrap._getSelected();
    // FIX-BRANCH-DEFAULT: if nothing is checked (e.g. before user interaction), show all branches
    return sel.length > 0 ? sel : others;
  }

  // Wire Clear button — deselects all branches and re-renders showing all branches
  const branchClearBtn = document.getElementById("branch-select-clear");
  if (branchClearBtn) {
    branchClearBtn.addEventListener("click", () => {
      if (branchWrap && branchWrap._clearSelected) branchWrap._clearSelected();
      updateBranchCharts();
    });
  }

  // ── TAB 1: Total Value ──
  function updateBranchCharts() {
    const selected = getSelectedBranches();
    const wrap     = document.getElementById("branch-tab-value");
    if (!selected.length) { wrap.innerHTML = `<div class="alert-warning">⚠️ Select at least one branch.</div>`; return; }
    const compareNames = [centralName, ...selected];
    const compareDf    = branchAgg.filter(r => compareNames.includes(r.PlantName));

    const bCols = [
      {key:"PlantName",       label:"Plant Name"},
      {key:"TotalValue",      label:"Total Value (ETB)",    fmt:fmtETB, rawKey:"TotalValue"},
      {key:"Unrestricted",    label:"Unrestricted (ETB)",   fmt:fmtETB, rawKey:"Unrestricted"},
      {key:"UnrestrictedQty", label:"Avail Qty",            fmt:fmtQty, rawKey:"UnrestrictedQty", cellClass:"col-qty"},
      {key:"Transit",         label:"Transit (ETB)",        fmt:fmtETB, rawKey:"Transit"},
      {key:"TransitQty",      label:"Transit Qty",          fmt:fmtQty, rawKey:"TransitQty",      cellClass:"col-qty"},
      {key:"QC",              label:"QC (ETB)",             fmt:fmtETB, rawKey:"QC"},
      {key:"QCQty",           label:"QC Qty",               fmt:fmtQty, rawKey:"QCQty",           cellClass:"col-qty"},
      {key:"Items",           label:"# Unique Materials"},
    ];
    wrap.innerHTML = `
      <div id="branch-chart-wrap" style="margin-bottom:1.2rem"></div>
      <div id="branch-table-wrap-inner" style="margin-bottom:1rem">${buildTable(compareDf, bCols, r => r.PlantName === centralName ? "row-blue" : "")}</div>`;
    document.getElementById("btn-dl-branch-csv").onclick  = () => downloadCSV(compareDf,   bCols, "branch_comparison.csv");
    document.getElementById("btn-dl-branch-xlsx").onclick = () => downloadExcel(compareDf, bCols, "branch_comparison.xlsx");

    // BUG-BRANCH-CHART FIX: render a grouped bar chart comparing branches by value category
    const sorted = [...compareDf].sort((a,b) => {
      if (a.PlantName === centralName) return -1;
      if (b.PlantName === centralName) return 1;
      return b.TotalValue - a.TotalValue;
    });
    Plotly.newPlot("branch-chart-wrap", [
      { type:"bar", name:"Unrestricted (ETB)", x:sorted.map(r=>r.PlantName), y:sorted.map(r=>r.Unrestricted), marker:{color:"#3fb950"}, hovertemplate:"<b>%{x}</b><br>ETB %{y:,.0f}<extra></extra>" },
      { type:"bar", name:"In Transit (ETB)",   x:sorted.map(r=>r.PlantName), y:sorted.map(r=>r.Transit),      marker:{color:"#d29922"}, hovertemplate:"<b>%{x}</b><br>ETB %{y:,.0f}<extra></extra>" },
      { type:"bar", name:"In QC (ETB)",        x:sorted.map(r=>r.PlantName), y:sorted.map(r=>r.QC),           marker:{color:"#f85149"}, hovertemplate:"<b>%{x}</b><br>ETB %{y:,.0f}<extra></extra>" },
    ], pl({ height:300, barmode:"stack", margin:{l:20,r:20,t:30,b:100},
      title:{text:"Inventory Value by Branch", font:{color:"#8b949e",size:13}} }), PLOTLY_CONFIG);
  }

  // ── TAB 2: Material Across Branches ──
  // FIX-BRANCH-TAB2-FILTER: matTabInitialized only guards the one-time UI scaffold build.
  // It must NOT block re-render when the MG filter in Tab 1 changes; we reset it on
  // every renderBranch() call (renderMaterialTab is called fresh each time the tab is opened).
  let matTabInitialized = false;
  function renderMaterialTab() {
    const wrap         = document.getElementById("branch-tab-material");
    // BUG-BRANCH-3 FIX: use baseDf to enumerate plant names — df (aggregated) may
    // collapse multi-plant materials to a single plant, hiding some branch columns.
    const allPlantNames = [...new Set(baseDf.map(r => r["Plant Name"]))].sort((a,b) => {
      if (a === centralName) return -1; if (b === centralName) return 1; return a.localeCompare(b);
    });

    if (!matTabInitialized) {
      matTabInitialized = true;
      // FIX-BRANCH-MG: use baseDf (not aggregated df) so all material groups are available
      const mgNamesForFilter = [...new Set(baseDf.map(r => r["Material Group Name"]))].filter(Boolean).filter(name => !isNonMedicalGroup(name)).sort();
      // Build list of all materials for the multi-select
      const allMatOptions = [...new Set(baseDf.map(r => {
        const code = String(r["Material"] || "").trim();
        const desc = String(r["Material Description"] || "").trim();
        return code + (desc && desc !== code ? " — " + desc : "");
      }))].filter(Boolean).sort();

      wrap.innerHTML = `
        <div style="display:flex;gap:0.8rem;flex-wrap:wrap;align-items:flex-end;margin-bottom:1rem;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:0.8rem">
          <div>
            <div class="nav-label" style="font-size:0.65rem;margin-bottom:3px">Material</div>
            <div class="ms-wrap" id="mat-ms-wrap" style="min-width:260px"><button class="ms-btn" type="button">All Materials <span class="ms-arrow">▾</span></button><div class="ms-dropdown" id="mat-ms-dd"></div></div>
          </div>
          <div>
            <div class="nav-label" style="font-size:0.65rem;margin-bottom:3px">Material Group</div>
            <div class="ms-wrap" id="mat-mg-ms-wrap" style="min-width:220px"><button class="ms-btn" type="button">All Material Groups <span class="ms-arrow">▾</span></button><div class="ms-dropdown" id="mat-mg-ms-dd"></div></div>
          </div>
          <div>
            <div class="nav-label" style="font-size:0.65rem;margin-bottom:3px">Metric</div>
            <select id="mat-metric" style="background:var(--surface2);border:1px solid var(--border2);color:var(--text);padding:6px 10px;border-radius:6px;font-size:13px">
              <option value="TotalValue">Total Value (ETB)</option>
              <option value="Unrestricted">Unrestricted Value (ETB)</option>
              <option value="Transit">Transit Value (ETB)</option>
              <option value="QC">Stock in Quality Inspection Value (ETB)</option>
              <option value="TotalQty">Total Quantity</option>
              <option value="UnrestrictedQty">Unrestricted Stock Quantity</option>
              <option value="TransitQty">Transit Quantity</option>
              <option value="QCQty">Stock in Quality Inspection Quantity</option>
            </select>
          </div>
          <div>
            <div class="nav-label" style="font-size:0.65rem;margin-bottom:3px">Material Type</div>
            <select id="mat-mgfilter" style="background:var(--surface2);border:1px solid var(--border2);color:var(--text);padding:6px 10px;border-radius:6px;font-size:13px">
              <option value="">All Material Types</option>
              <option value="ZME">ZME</option>
              <option value="ZMS">ZMS</option>
              <option value="ZLC">ZLC</option>
              <option value="ZMD">ZMD</option>
            </select>
          </div>
          <div>
            <div class="nav-label" style="font-size:0.65rem;margin-bottom:3px">Sort By</div>
            <select id="mat-sort" style="background:var(--surface2);border:1px solid var(--border2);color:var(--text);padding:6px 10px;border-radius:6px;font-size:13px">
              <option value="total_desc">Highest Total ↓</option>
              <option value="total_asc">Lowest Total ↑</option>
              <option value="desc_asc">Description A–Z</option>
              <option value="spread_desc">Most Branches ↓</option>
            </select>
          </div>
          <button id="mat-apply" class="apply-btn">Apply</button>
          <button id="mat-clear" class="apply-btn secondary">Clear</button>
        </div>
        <div id="mat-chart-wrap" style="margin-bottom:1rem"></div>
        <div id="mat-dl-row" style="display:flex;gap:0.6rem;justify-content:flex-end;margin-bottom:0.5rem"></div>
        <div id="mat-table-wrap"></div>`;
      document.getElementById("mat-apply").addEventListener("click", refreshMaterialView);
      document.getElementById("mat-clear").addEventListener("click", () => {
        const matWrap2 = document.getElementById("mat-ms-wrap");
        const mgWrap2  = document.getElementById("mat-mg-ms-wrap");
        if (matWrap2 && matWrap2._clearSelected) matWrap2._clearSelected();
        if (mgWrap2  && mgWrap2._clearSelected)  mgWrap2._clearSelected();
        document.getElementById("mat-metric").value    = "TotalValue";
        document.getElementById("mat-mgfilter").value  = "";
        document.getElementById("mat-sort").value      = "total_desc";
        refreshMaterialView();
      });
      // Build the material multi-select after HTML is in DOM
      buildMultiSelect("mat-ms-wrap", "mat-ms-dd", allMatOptions, "All Materials");
      // Material Group multi-select — lets users narrow the comparison to one or
      // more material groups (e.g. only "Antibiotics" or "Vaccines") in addition
      // to / instead of picking individual materials.
      buildMultiSelect("mat-mg-ms-wrap", "mat-mg-ms-dd", mgNamesForFilter, "All Material Groups");
    }

    // ── Spread-chart drilldown: auto-select materials from the clicked group ──
    // _lastSpreadDrilldown is set by the Branch Spread bar-click handler in
    // renderConcentration(). We consume it once here and clear it so a manual
    // page-revisit doesn't re-apply a stale selection.
    if (_lastSpreadDrilldown) {
      const { plantCount, matCodes } = _lastSpreadDrilldown;
      _lastSpreadDrilldown = null;   // consume — one-shot

      const matWrapEl = document.getElementById("mat-ms-wrap");
      const matDdEl   = document.getElementById("mat-ms-dd");
      if (matWrapEl && matDdEl) {
        // Clear any existing selection first
        if (matWrapEl._clearSelected) matWrapEl._clearSelected();

        // The multi-select options are formatted as "CODE — DESC" or just "CODE".
        // We need to tick every checkbox whose value starts with one of our codes.
        const codeSet = new Set(matCodes.map(c => String(c).trim().toUpperCase()));
        let matched = 0;
        matDdEl.querySelectorAll("input[type=checkbox]").forEach(cb => {
          const cbCode = cb.value.split(" — ")[0].trim().toUpperCase();
          if (codeSet.has(cbCode)) {
            cb.checked = true;
            cb.dispatchEvent(new Event("change"));
            matched++;
          }
        });

        // Show a transient toast so the user knows why the filter changed
        const label = plantCount === 1
          ? "1 plant (sole branch)"
          : `${plantCount} plant${plantCount > 1 ? "s" : ""}`;
        showSpreadDrilldownToast(matched, label);
      }
    }

    refreshMaterialView();

    function refreshMaterialView() {
      const matWrap   = document.getElementById("mat-ms-wrap");
      const selected  = (matWrap && matWrap._getSelected) ? matWrap._getSelected() : [];
      // selected values are "CODE — DESC" or just "CODE"; extract the code part before " — "
      const selCodes  = selected.map(v => v.split(" — ")[0].trim().toLowerCase());
      const mgWrap      = document.getElementById("mat-mg-ms-wrap");
      const selectedMgs = (mgWrap && mgWrap._getSelected) ? mgWrap._getSelected() : [];
      const metric    = document.getElementById("mat-metric").value;
      const sortMode  = document.getElementById("mat-sort").value;
      const mgFilter  = document.getElementById("mat-mgfilter").value;
      const isQty     = metric.includes("Qty");
      const fmtFn     = isQty ? fmtQty : fmtETB;

      let materials = Object.entries(matPlantMap)
        .filter(([mat, info]) => {
          if (mgFilter && info.valType !== mgFilter) return false;
          if (selectedMgs.length > 0 && !selectedMgs.includes(info.group)) return false;
          if (selCodes.length > 0) {
            // Multi-select: match if material code is one of the selected codes
            return selCodes.includes(mat.toLowerCase());
          }
          return true;
        })
        .map(([mat, info]) => {
          const plantData = {};
          let grandTotal = 0, branchCount = 0;
          allPlantNames.forEach(pn => {
            const v = info[pn] ? info[pn][metric] : 0;
            plantData[pn] = v || 0;
            grandTotal   += plantData[pn];
            if (plantData[pn] > 0) branchCount++;
          });
          return {mat, desc:info.desc, group:info.group, valType:info.valType, plantData, grandTotal, branchCount};
        });

      if (sortMode === "total_desc") materials.sort((a,b) => b.grandTotal - a.grandTotal);
      if (sortMode === "total_asc")  materials.sort((a,b) => a.grandTotal - b.grandTotal);
      if (sortMode === "desc_asc")   materials.sort((a,b) => a.desc.localeCompare(b.desc));
      if (sortMode === "spread_desc")materials.sort((a,b) => b.branchCount - a.branchCount);

      const top      = materials.slice(0, 30);
      const chartWrap = document.getElementById("mat-chart-wrap");
      if (!top.length) {
        chartWrap.innerHTML = "";
        document.getElementById("mat-table-wrap").innerHTML = `<div class="alert-info">No materials found.</div>`;
        const matDlRow = document.getElementById("mat-dl-row");
        if (matDlRow) matDlRow.innerHTML = "";
        return;
      }
      chartWrap.innerHTML = "";

      const colDefs = [
        {key:"mat",  label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
        {key:"desc", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
        {key:"group",label:"Material Group"},
        ...allPlantNames.map(pn => ({key:`__p__${pn}`, label:pn, fmt:fmtFn, rawKey:`__r__${pn}`, cellClass:isQty?"col-qty":"col-val"})),
        {key:"grandTotal",  label:"Grand Total", fmt:fmtFn, rawKey:"grandTotal", cellClass:isQty?"col-qty":"col-val"},
        {key:"branchCount", label:"# Branches"},
      ];
      const tableRows = materials.slice(0, 200).map(m => {
        const row = {mat:m.mat, desc:m.desc, group:m.group, grandTotal:m.grandTotal, branchCount:m.branchCount};
        allPlantNames.forEach(pn => { row[`__p__${pn}`] = m.plantData[pn] || 0; row[`__r__${pn}`] = m.plantData[pn] || 0; });
        row["__r__grandTotal"] = m.grandTotal;
        return row;
      });

      const centralKey = `__p__${centralName}`;
      const thead = `<thead><tr>${colDefs.map(c =>
        `<th${c.key === centralKey ? ' style="color:#58a6ff;background:#0d2035"' : ""}>${escHtml(c.label)}</th>`
      ).join("")}</tr></thead>`;
      const tbody = tableRows.map(r => {
        const cells = colDefs.map(c => {
          const v       = r[c.key];
          const raw     = c.raw ? v : null;           // raw HTML — don't escape
          const display = raw != null ? (raw ?? "")
                        : c.fmt ? c.fmt(v)
                        : (v == null ? "" : escHtml(String(v)));
          const isZero  = typeof v === "number" && v === 0;
          const style   = c.key === centralKey ? 'style="color:#58a6ff;background:#0d2035"' : isZero ? 'style="color:#484f58"' : "";
          const cls     = c.cellClass || "";
          return `<td class="${cls}" ${style}>${display}</td>`;
        }).join("");
        return `<tr>${cells}</tr>`;
      }).join("");
      document.getElementById("mat-table-wrap").innerHTML = `
        <div style="color:var(--muted);font-size:12px;margin-bottom:6px">Showing ${tableRows.length} of ${materials.length} materials · Blue = Central (${escHtml(centralName)})</div>
        <div class="tbl-wrap"><table>${thead}<tbody>${tbody}</tbody></table></div>
        ${materials.length > 200 ? `<div class="alert-info">Showing first 200 of ${materials.length}. Refine search.</div>` : ""}`;

      const exportCols = [
        {key:"mat",  label:"Material Code"},
        {key:"desc", label:"Material Description"},
        {key:"group",label:"Material Group"},
        ...allPlantNames.map(pn => ({key:`__p__${pn}`, label:pn, rawKey:`__r__${pn}`})),
        {key:"grandTotal", label:"Grand Total", rawKey:"grandTotal"},
        {key:"branchCount", label:"# Branches"},
      ];
      // tableRows entries only carry mat/desc/group plus __p__/__r__ plant keys and
      // grandTotal/branchCount — already exactly what exportCols needs, so export
      // directly from tableRows (no HTML-formatting fns involved).
      injectDlButtons("mat-dl-row",
        () => downloadCSV(tableRows,   exportCols, "branch_material_comparison.csv"),
        () => downloadExcel(tableRows, exportCols, "branch_material_comparison.xlsx"),
      );
    }
  }

  renderMaterialTab();
}

// ═══════════════════════════════════════════════════════════════════════════
// INVENTORY FLOW
// ═══════════════════════════════════════════════════════════════════════════
function renderFlow() {
  const df = applyPageFilter("flow");

  // FIX-TRANSIT-NODOC: exclude transit items lacking both Purchasing Document
  // AND Supplying Plant from Flow page KPIs and totals.
  const transitVal = df.reduce((s,r) => s + getVerifiedTransitVal(r), 0);
  const transitQty = df.reduce((s,r) => s + getVerifiedTransitQty(r), 0);
  const qcVal      = df.reduce((s,r) => s + getMappedVal(r,"Value of Stock in Quality Inspection"), 0);
  const availVal   = df.reduce((s,r) => s + getMappedVal(r,"Value of Unrestricted Stock"), 0);
  const totalVal   = availVal + transitVal + qcVal;
  const totalQty   = df.reduce((s,r) => s + getMappedQty(r,"Unrestricted Stock"), 0) + transitQty + df.reduce((s,r) => s + getMappedQty(r,"Stock in Quality Inspection"), 0);
  const availQty   = df.reduce((s,r) => s + getMappedQty(r,"Unrestricted Stock"), 0);

  // FIX-PHANTOM-FLOW: for reorder alerts, only count non-phantom transit as "incoming"
  // Also exclude rows that have transit qty but no purchasing doc AND no supplying plant
  const reorderItems = df.filter(r => getMappedQty(r,"Unrestricted Stock") === 0 && (
    (getMappedQty(r,"Stock in Transit") > 0 && !(r._phantomTransitQty > 0) && _hasVerifiedTransit(r)) ||
    getMappedQty(r,"Stock in Quality Inspection") > 0
  ));

  setKpis("flow-kpis", [
    ["Total Inventory",      fmtETB(totalVal),   `${fmtQty(totalQty)} units`,               "blue"],
    ["Available Stock",      fmtETB(availVal),   `${fmtQty(availQty)} units unrestricted`,   "green"],
    ["In Transit (Inbound)", fmtETB(transitVal), `${fmtQty(transitQty)} units`, "amber"],
    ["In QC",                fmtETB(qcVal),      `${fmtQty(df.reduce((s,r) => s+getMappedQty(r,"Stock in Quality Inspection"),0))} units`, "red"],
    ["Reorder Alerts",       String(reorderItems.length), "Zero unrestricted stock", "red"],
  ]);

  const reorderCols = [
    {key:"Material", label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
    {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
    {key:"Material Group Name",       label:"Material Group"},
    {key:"Plant Name",                label:"Plant"},
    {key:"Unrestricted Stock",        label:"Avail Qty",          fmt:(v,r)=>fmtQty(getMappedQty(r,"Unrestricted Stock")),          rawKey:"Unrestricted Stock",        cellClass:"col-qty"},
    {key:"Stock in Transit",          label:"In Transit",          fmt:(v,r)=>fmtQty(getVerifiedTransitQty(r)),                       rawKey:"Stock in Transit",          cellClass:"col-qty"},
    {key:"Stock in Quality Inspection",label:"In QC",             fmt:(v,r)=>fmtQty(getMappedQty(r,"Stock in Quality Inspection")), rawKey:"Stock in Quality Inspection",cellClass:"col-qty"},
    {key:"Value of Stock in Transit", label:"Transit Value (ETB)", fmt:(v,r)=>fmtETB(getVerifiedTransitVal(r)),                       rawKey:"Value of Stock in Transit",  cellClass:"col-val"},
    {key:"_purDoc",                   label:"Purchasing Document"},
    {key:"_supPlant",                 label:"Supplying Plant"},
    {key:"_alert",                    label:"Alert", raw:true},
  ];
  const reorderRows = reorderItems.map(r => {
    const info = getTransitInfo(r["Material"], r["Plant"]);
    return {
      ...r,
      _purDoc:   info.purDoc,
      _supPlant: info.supPlant,
      _alert: getVerifiedTransitQty(r) > 0 && getMappedQty(r,"Stock in Quality Inspection") > 0
        ? "<span class='badge badge-red'>Transit+QC</span>"
        : getVerifiedTransitQty(r) > 0
        ? "<span class='badge badge-amber'>Awaiting Transit</span>"
        : "<span class='badge badge-amber'>Awaiting QC Release</span>",
    };
  });
  document.getElementById("reorder-table-wrap").innerHTML = reorderRows.length
    ? buildTable(reorderRows, reorderCols, () => "row-amber")
    : `<div class="alert-info">✓ No reorder alerts — all materials have available unrestricted stock.</div>`;

  // Reorder export buttons
  injectDlButtons("reorder-dl-row",
    () => downloadCSV(reorderRows,   reorderCols, "reorder_alerts.csv"),
    () => downloadExcel(reorderRows, reorderCols, "reorder_alerts.xlsx"));

  // Stock levels chart — use converted quantities
  const plantStockMap = {};
  df.forEach(r => {
    const k = r["Plant Name"] || "(Blank)";
    if (!plantStockMap[k]) plantStockMap[k] = { "Plant Name": k, avail:0, transit:0, qc:0 };
    plantStockMap[k].avail   += getMappedQty(r,"Unrestricted Stock");
    plantStockMap[k].transit += getVerifiedTransitQty(r);
    plantStockMap[k].qc      += getMappedQty(r,"Stock in Quality Inspection");
  });
  const plantAgg = sortBy(Object.values(plantStockMap), "avail");
  Plotly.newPlot("chart-stock-levels", [
    {type:"bar", name:"Available",  x:plantAgg.map(r=>r["Plant Name"]), y:plantAgg.map(r=>r.avail),  marker:{color:"#3fb950"}},
    {type:"bar", name:"In Transit", x:plantAgg.map(r=>r["Plant Name"]), y:plantAgg.map(r=>r.transit), marker:{color:"#d29922"}},
    {type:"bar", name:"In QC",      x:plantAgg.map(r=>r["Plant Name"]), y:plantAgg.map(r=>r.qc),     marker:{color:"#f85149"}},
  ], pl({height:300,barmode:"stack",margin:{l:20,r:20,t:20,b:80}}), PLOTLY_CONFIG);

  // Inter-location transfers
  const transferCols = [
    {key:"Material", label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
    {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
    {key:"Plant Name",                label:"Receiving Plant"},
    {key:"_purDoc",                   label:"Purchasing Document"},
    {key:"_supPlant",                 label:"Supplying Plant"},
    {key:"Stock in Transit",          label:"Transit Qty",          fmt:(v,r)=>fmtQty(getMappedQty(r,"Stock in Transit")),           rawKey:"Stock in Transit",          cellClass:"col-qty"},
    {key:"Value of Stock in Transit", label:"Transit Value (ETB)",  fmt:(v,r)=>fmtETB(getMappedVal(r,"Value of Stock in Transit")),  rawKey:"Value of Stock in Transit",  cellClass:"col-val"},
  ];
  // FIX-PHANTOM-FLOW: exclude phantom transit (no PO/supplying plant) from transfer table
  const transferRows = sortBy(df.filter(r => r["Stock in Transit"] > 0 && !(r._phantomTransitQty > 0) && _hasVerifiedTransit(r)), "Value of Stock in Transit").map(r => {
    const info = getTransitInfo(r["Material"], r["Plant"]);
    return { ...r, _purDoc: info.purDoc, _supPlant: info.supPlant };
  });
  document.getElementById("transfer-table-wrap").innerHTML = transferRows.length
    ? buildTable(transferRows, transferCols)
    : `<div class="alert-info">No inter-location transfers currently in progress.</div>`;

  // Transfer export buttons
  injectDlButtons("transfer-dl-row",
    () => downloadCSV(transferRows,   transferCols, "inter_location_transfers.csv"),
    () => downloadExcel(transferRows, transferCols, "inter_location_transfers.xlsx"));

  // Inbound vs available chart — exclude unverified transit rows
  const inboundAgg = sortBy(
    groupBy(df.filter(r => r["Stock in Transit"] > 0 && _hasVerifiedTransit(r)), "Plant Name", [["avail","Unrestricted Stock"],["inbound","Stock in Transit"]]),
    "inbound"
  );
  if (inboundAgg.length) {
    Plotly.newPlot("chart-inbound-outbound", [
      {type:"bar", name:"Available Stock", x:inboundAgg.map(r=>r["Plant Name"]), y:inboundAgg.map(r=>r.avail),   marker:{color:"#3fb950"}},
      {type:"bar", name:"Inbound Transit", x:inboundAgg.map(r=>r["Plant Name"]), y:inboundAgg.map(r=>r.inbound), marker:{color:"#d29922"}},
    ], pl({height:280,barmode:"group",margin:{l:20,r:20,t:20,b:80}}), PLOTLY_CONFIG);
  } else {
    document.getElementById("chart-inbound-outbound").innerHTML = `<div class="alert-info">No transit data to chart.</div>`;
  }

  const flowDlCols = [
    {key:"Material", label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
    {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
    {key:"Plant Name",                        label:"Plant"},
    {key:"Material Group Name",               label:"Material Group"},
    {key:"Unrestricted Stock",                label:"Available Qty",      rawKey:"Unrestricted Stock"},
    {key:"Stock in Transit",                  label:"Transit Qty",        rawKey:"Stock in Transit"},
    {key:"Stock in Quality Inspection",       label:"QC Qty",             rawKey:"Stock in Quality Inspection"},
    {key:"Value of Unrestricted Stock",       label:"Available Value (ETB)",rawKey:"Value of Unrestricted Stock"},
    {key:"Value of Stock in Transit",         label:"Transit Value (ETB)",rawKey:"Value of Stock in Transit"},
  ];

}

// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// AGGREGATE BY MATERIAL (used by QC and Branch Comparison)
// ═══════════════════════════════════════════════════════════════════════════
// Collapses multiple rows with the same material code into ONE row per
// material, summing all qty and value columns and keeping the earliest expiry.
// Also builds a "_plantList" string of all plants stocking the material.

function aggregateByMaterial(df) {
  // NOTE: Total Qty is intentionally excluded from QTY_COLS — it is a derived
  // sum (Unrestricted + Transit + QC) and must be recomputed after aggregation,
  // not accumulated directly (which would double-count it).
  const QTY_COLS = [
    "Unrestricted Stock", "Stock in Quality Inspection",
    "Blocked Stock",      "Stock in Transit",
  ];
  const VAL_COLS = [
    "Value of Unrestricted Stock",
    "Value of Stock in Quality Inspection",
    "Value of Stock in Transit",
    // BUG-FIX-4: "Total Value" removed — it is recomputed from components below
    // (line ~2081). Accumulating it here then overwriting it was wasted work and
    // would double-count if the recompute step were ever skipped.
  ];

  // Group all rows by Material code
  const matMap = {}; // materialCode → aggregated row

  df.forEach(row => {
    const mat = row["Material"];
    if (!mat) return;

    if (!matMap[mat]) {
      matMap[mat] = {
        ...row,
        _allPlants: [],
      };
      if (row["Plant Name"]) matMap[mat]._allPlants.push(row["Plant Name"]);
    } else {
      const target = matMap[mat];
      QTY_COLS.forEach(c => { target[c] = (target[c] || 0) + (row[c] || 0); });
      VAL_COLS.forEach(c => { target[c] = (target[c] || 0) + (row[c] || 0); });
      // Keep earliest expiry
      const te = target["_expiry"], se = row["_expiry"];
      if (se instanceof Date && !isNaN(se)) {
        if (!(te instanceof Date) || isNaN(te) || se < te) target["_expiry"] = se;
      }
      if (row["Plant Name"] && !target._allPlants.includes(row["Plant Name"])) {
        target._allPlants.push(row["Plant Name"]);
      }
      if (!target["Material Group Name"] && row["Material Group Name"]) target["Material Group Name"] = row["Material Group Name"];
    }
  });

  // Recompute derived totals AFTER aggregation to prevent double-counting.
  // Total Qty / Total Value are sums of components — never accumulate directly.
  Object.values(matMap).forEach(row => {
    row["Total Qty"]   = (row["Unrestricted Stock"] || 0) + (row["Stock in Transit"] || 0) + (row["Stock in Quality Inspection"] || 0);
    row["Total Value"] = (row["Value of Unrestricted Stock"] || 0) + (row["Value of Stock in Transit"] || 0) + (row["Value of Stock in Quality Inspection"] || 0);
    const plants = (row._allPlants || []).filter(Boolean).sort();
    row["_plantList"] = plants.length ? plants.join(", ") : (row["Plant Name"] || "—");
  });

  return Object.values(matMap);
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE SWITCHING
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// INCOMING SHELF LIFE — Received Goods File Loader
// Only HO01 plant, only ZME / ZMS / ZLC valuation types. ZMD excluded.
// ═══════════════════════════════════════════════════════════════════════════
function loadIncomingFile(file) {
  const statusEl = document.getElementById("incomingFileStatus");
  statusEl.style.display = "block";
  statusEl.innerHTML = `<div class="status-ok">⏳ LOADING…</div><div class="status-name">Parsing ${escHtml(file.name)}</div>`;

  const reader = new FileReader();
  reader.onload = e => {
    setTimeout(() => {
      try {
        const wb   = XLSX.read(new Uint8Array(e.target.result), { type: "array", cellDates: true });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(ws, { defval: "" });
        if (!data.length) { statusEl.innerHTML = `<div class="status-ok" style="color:var(--red)">⚠ File empty</div>`; return; }

        const trimmed = data.map(row => {
          const r = {};
          for (const [k, v] of Object.entries(row)) r[k.trim()] = v;
          return r;
        });

        // Filter: HO01 plant only, ZME/ZMS/ZLC only
        const ALLOWED_VT = ["ZME","ZMS","ZLC"];
        let rows = trimmed.filter(r => {
          const plant = String(r["Plant"] || "").trim().toUpperCase();
          if (plant !== "HO01") return false;
          // Extract suffix from Valuation Type (e.g. "51490_ZME" → "ZME")
          const vt = _islExtractVT(r);
          return ALLOWED_VT.includes(vt);
        });

        // Parse fields from received goods file.
        // ISSUE-1 FIX: Expiry Date comes from inventory (SAP master) during
        // _islCrossMatchInventory(). Posting Date and Valuation Type are
        // sourced from this file.
        rows.forEach(r => {
          r._postingDate = _islParseDate(r["Posting Date"]);
          r._vt          = _islExtractVT(r);
          // SL metrics computed in _islCrossMatchInventory once inventory
          // expiry dates are resolved; initialise to grey for safety
          r._slAtReceiptDays = null;
          r._receiptFlag     = "grey";
          r._remainingSL     = null;
          r._ratio           = null;
          r._flag            = "grey";
          r._isExpired       = false;
          r._dataError       = false;
          // Inventory enrichment fields — populated by _islCrossMatchInventory
          r._inv_plants   = "—";
          r._inv_slocs    = "—";
          r._inv_totalQty = 0;
          r._inv_expiryDate = null;
          r._inv_materialGroup = "—";
          r._inInventory    = null;
        });

        // Store all parsed HO01/ZME+ZMS+ZLC rows before cross-match
        incomingRaw = rows;
        // ISSUE-7 NOTE: .slice() is a shallow copy — the row objects
        // themselves are shared between incomingRaw and _incomingRawAll.
        // This is intentional/fine: _islCrossMatchInventory() mutates those
        // shared objects (_inv_*, _flag, etc.) in place, and _incomingRawAll
        // is fully reassigned (not appended to) on the next loadIncomingFile()
        // call, so stale references never leak across file loads.
        _incomingRawAll = rows.slice(); // preserve full list for re-matching

        // ISL-MATCH: cross-match against inventory — keep only rows whose
        // Material + Batch combination exists somewhere in rawDf (any branch),
        // enrich with inventory expiry/plant/qty, compute SL metrics, and
        // group duplicate receipts by Material+Batch (ISSUE-2).
        // Always run — even without inventory loaded yet — so grouping is
        // applied; re-matched again once inventory is uploaded (see
        // recomputeIslMatch).
        _islCrossMatchInventory();

        const n = incomingRaw.length;
        const loadedTotal = rows.length;
        const matchNote = rawDf.length
          ? ` · ${n.toLocaleString()} matched in inventory`
          : ` · Upload inventory to cross-match`;
        statusEl.innerHTML = `<div class="status-ok">✓ LOADED</div><div class="status-name">${escHtml(file.name)}</div><div class="status-name" style="color:var(--green)">${loadedTotal.toLocaleString()} records (HO01 / ZME+ZMS+ZLC)${matchNote}</div>`;
        document.getElementById("incomingUploadBtnText").textContent = `📥 ${file.name}`;

        // Populate filters
        _islPopulateFilters();

        document.getElementById("incoming-no-file").style.display = "none";
        document.getElementById("incoming-content").style.display = "block";

        // ISSUE-8 FIX: always go through renderPage so currentPage is set
        // consistently, regardless of which page we're currently on.
        renderPage("incoming");
      } catch(err) {
        statusEl.innerHTML = `<div class="status-ok" style="color:var(--red)">⚠ Error: ${escHtml(err.message)}</div>`;
      }
    }, 30);
  };
  reader.readAsArrayBuffer(file);
}

// =============================================================================
// ISL-MATCH: Cross-match received-goods rows against the main inventory.
//
// Business rule:
//   • Received goods file = HO01 receipts only (company's receiving plant).
//   • Inventory file      = all branches (HO01 + all distribution branches).
//   • A received row is valid only when its Material code AND Batch both
//     appear in at least one inventory row (any plant/branch).
//
// This ensures the shelf-life page shows only batches that are actually
// trackable in the current inventory snapshot — not historical receipts that
// have already been fully distributed and consumed.
//
// incomingRaw is mutated in-place: rows that have no matching inventory
// Material+Batch pair are removed.  The full pre-match list is preserved in
// _incomingRawAll so the match can be re-run after a fresh inventory upload.
// =============================================================================

let _incomingRawAll = [];   // full parsed HO01 list, unfiltered by inventory

/**
 * Builds a lookup from rawDf (all branches) keyed by "material||batch",
 * enriches each received-goods row with inventory-derived fields
 * (_inv_expiryDate, _inv_plants, _inv_slocs, _inv_totalQty), computes the
 * shelf-life metrics via _islCompute(), stamps r._inInventory, and finally
 * groups rows by Material+Batch (ISSUE-2 FIX) so duplicate/partial-delivery
 * receipts collapse into a single reference row per batch.
 *
 * incomingRaw ends up holding the GROUPED, matched rows used for display.
 * _incomingRawAll retains the full ungrouped list (for KPIs/match counts).
 */
function _islCrossMatchInventory() {
  if (!rawDf.length) {
    // Inventory not yet loaded — show everything, mark unknown
    _incomingRawAll.forEach(r => { r._inInventory = null; });
    incomingRaw = _islGroupByMaterialBatch(_incomingRawAll);
    return;
  }

  // Build lookup map from inventory (all branches): key -> { expiry, plants:Set, slocs:Set, totalQty }
  const invMap = new Map();
  // Material Group is a property of the material itself (not plant/batch-specific),
  // so it's looked up by Material code alone.
  const matGroupMap = new Map();
  rawDf.forEach(r => {
    const mat   = String(r["Material"] || "").trim().toUpperCase();
    const batch = String(r["Batch"]    || "").trim().toUpperCase();
    if (mat && !matGroupMap.has(mat) && r["Material Group Name"]) {
      matGroupMap.set(mat, r["Material Group Name"]);
    }
    if (!mat || !batch) return;
    const key = `${mat}||${batch}`;
    let entry = invMap.get(key);
    if (!entry) {
      entry = { expiry: null, plants: new Set(), slocs: new Set(), totalQty: 0 };
      invMap.set(key, entry);
    }
    if (r._expiry instanceof Date && !entry.expiry) entry.expiry = r._expiry;
    const plant = String(r["Plant"] || "").trim().toUpperCase();
    if (plant) entry.plants.add(plant);
    const sloc = String(r["Storage Location"] || "").trim();
    if (sloc) entry.slocs.add(sloc);
    entry.totalQty += (Number(r["Total Qty"]) || 0);
  });

  // Stamp, enrich, and compute SL metrics
  _incomingRawAll.forEach(r => {
    const mat   = String(r["Material"] || "").trim().toUpperCase();
    const batch = String(r["Batch"]    || "").trim().toUpperCase();
    const key   = `${mat}||${batch}`;
    const entry = (mat && batch) ? invMap.get(key) : undefined;
    r._inInventory = !!entry;
    r._inv_materialGroup = matGroupMap.get(mat) || "—";

    if (entry) {
      r._inv_expiryDate = entry.expiry;
      r._inv_plants     = entry.plants.size ? [...entry.plants].sort().join(" · ") : "—";
      r._inv_slocs      = entry.slocs.size  ? [...entry.slocs].sort().join(" · ")  : "—";
      r._inv_totalQty   = entry.totalQty;
    } else {
      r._inv_expiryDate = null;
      r._inv_plants     = "—";
      r._inv_slocs      = "—";
      r._inv_totalQty   = 0;
    }

    const sl = _islCompute(r._inv_expiryDate, r._postingDate);
    r._slAtReceiptDays = sl.slAtReceiptDays;
    r._receiptFlag     = sl.receiptFlag;
    r._remainingSL     = sl.remainingSLDays;
    r._ratio           = sl.ratio;
    r._flag            = sl.flag;
    r._isExpired       = sl.isExpired;
    r._dataError       = sl.dataError;
  });

  const matched = _incomingRawAll.filter(r => r._inInventory === true);
  incomingRaw = _islGroupByMaterialBatch(matched);
}

/**
 * ISSUE-2 FIX: group received-goods rows by Material+Batch.
 *   • The row with the LATEST Posting Date becomes the reference receipt
 *     (its dates/flags/SL metrics are shown).
 *   • _groupedQty = sum of received quantities across all rows in the group.
 *   • _receiptCount = number of GR postings collapsed into this row.
 * Rows without a usable quantity column contribute 0 to _groupedQty.
 */
function _islGetRowQty(r) {
  const candidates = ["Quantity", "Posted Quantity", "Quantity in Unit of Entry",
    "GR Quantity", "Order Quantity", "Total Qty"];
  for (const c of candidates) {
    if (r[c] !== undefined && r[c] !== "") {
      const n = parseFloat(r[c]);
      if (!isNaN(n)) return n;
    }
  }
  return 0;
}

function _islGroupByMaterialBatch(rows) {
  const groups = new Map();
  rows.forEach(r => {
    const mat   = String(r["Material"] || "").trim().toUpperCase();
    const batch = String(r["Batch"]    || "").trim().toUpperCase();
    const key   = `${mat}||${batch}`;
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); }
    g.push(r);
  });

  const result = [];
  groups.forEach(g => {
    // Pick the row with the latest posting date as the reference
    let ref = g[0];
    for (const r of g) {
      const a = ref._postingDate ? ref._postingDate.getTime() : -Infinity;
      const b = r._postingDate   ? r._postingDate.getTime()   : -Infinity;
      if (b > a) ref = r;
    }
    const totalQty = g.reduce((sum, r) => sum + _islGetRowQty(r), 0);
    result.push({ ...ref, _groupedQty: totalQty, _receiptCount: g.length });
  });
  return result;
}

/**
 * Called by loadFile() after rawDf is refreshed so any already-loaded
 * received-goods data is re-matched against the new inventory snapshot.
 */
function recomputeIslMatch() {
  if (!_incomingRawAll.length) return; // no received goods uploaded yet
  _islCrossMatchInventory();
  if (currentPage === "incoming") renderIncomingShelfLife();
  // Update the status line to reflect new match count
  const statusEl = document.getElementById("incomingFileStatus");
  if (statusEl && statusEl.style.display !== "none") {
    const total   = _incomingRawAll.length;
    const matched = incomingRaw.length;
    const existing = statusEl.innerHTML;
    // Replace the last status-name line (match note) or append it
    if (existing.includes("matched in inventory") || existing.includes("Upload inventory")) {
      statusEl.innerHTML = existing.replace(
        / · [\d,]+ matched in inventory| · Upload inventory to cross-match/,
        ` · ${matched.toLocaleString()} matched in inventory`
      );
    }
  }
  // Re-populate ISL filters since the dataset changed
  if (_incomingRawAll.length) _islPopulateFilters();
}

function _islExtractVT(row) {
  // Works for both inventory format "50833_ZME" and export format "50833_ZME"
  const raw = String(row["Valuation Type"] || row["Inventory Valuation Type"] || "").trim();
  if (!raw) return "";
  const i = raw.lastIndexOf("_");
  if (i === -1 || i === raw.length - 1) return raw.toUpperCase();
  return raw.substring(i + 1).toUpperCase();
}

function _islParseDate(v) {
  if (!v) return null;
  // Already a JS Date (cellDates:true path)
  if (v instanceof Date) return isNaN(v.getTime()) ? null : new Date(v.getFullYear(), v.getMonth(), v.getDate());
  const s = String(v).trim();
  if (!s) return null;
  // yyyy-mm-dd string — treat as local midnight (BUG-ISL-3 / BUG-8 consistent)
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const dt = new Date(+isoMatch[1], +isoMatch[2] - 1, +isoMatch[3]);
    return isNaN(dt.getTime()) ? null : dt;
  }
  // BUG-ISL-3 FIX: SAP Excel serial dates use the Lotus 1900 leap-year bug
  // offset, so the correct formula is n - 2 (not n - 1).
  // XLSX.js with cellDates:true should have already converted these, but guard
  // against raw numeric values that bypass that path.
  const n = Number(s);
  if (!isNaN(n) && n > 1000 && n < 2958466) {  // 2958466 = 31-Dec-9999
    const d = new Date(Date.UTC(1900, 0, n - 2));
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  // Generic fallback
  const d = new Date(s);
  if (!isNaN(d.getTime())) return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return null;
}

// ISSUE-1 FIX: There are now TWO distinct shelf-life metrics:
//   • SL at Receipt   = Expiry Date − Posting Date (supplier compliance check,
//                        evaluated at the moment goods were received)
//   • SL Remaining    = Expiry Date − TODAY (distribution urgency, what's
//                        actually left right now)
// "flag" (used for KPIs, chart, and the bar in the table) is driven by
// SL Remaining (Today), since that's what matters operationally.
// "receiptFlag" classifies SL at Receipt using year-based thresholds:
//   < 1.5 yr  → red     (supplier delivered with inadequate shelf life)
//   1.5-2 yr  → yellow  (borderline, watch)
//   > 2 yr    → green   (adequate)
const _ISL_YEAR_DAYS = 365.25;

function _islCompute(expiryDate, postingDate) {
  // BUG-ISL-2 FIX: cleaned up duplicate grey branch; distinct cases handled:
  //   • no expiryDate  → grey (cannot calculate anything)
  //   • no postingDate → grey for SL-at-receipt only (no receipt event date)
  if (!expiryDate) {
    return {
      slAtReceiptDays: null, receiptFlag: "grey",
      remainingSLDays: null, ratio: null, flag: "grey", isExpired: false,
      dataError: false,
    };
  }

  const MS_PER_DAY = 86400000;
  const today = new Date();
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  // ── SL Remaining (Today): Expiry Date − Today ──────────────────────────
  const remainingSLDays = Math.round((expiryDate - todayMidnight) / MS_PER_DAY);
  const isExpired = remainingSLDays < 0;

  let flag;
  if (isExpired) {
    flag = "expired"; // ISSUE-3 FIX: explicit expired state, not a 0% red bar
  } else {
    // Ratio of remaining SL to a 2-year (730-day) reference window, used only
    // for the progress bar fill so the "today" view also has a visual scale.
    const refWindow = _ISL_YEAR_DAYS * 2;
    const r = remainingSLDays / refWindow;
    flag = r > 0.5 ? "green" : r >= 0.375 ? "yellow" : "red"; // >1yr / 9mo-1yr / <9mo left
  }
  const ratio = isExpired ? null : Math.max(0, Math.min(1, remainingSLDays / (_ISL_YEAR_DAYS * 2)));

  // ── SL at Receipt: Expiry Date − Posting Date ──────────────────────────
  let slAtReceiptDays = null;
  let receiptFlag = "grey";
  let dataError = false;
  if (postingDate) {
    slAtReceiptDays = Math.round((expiryDate - postingDate) / MS_PER_DAY);
    if (slAtReceiptDays <= 0) {
      // ISSUE-4 FIX: production/posting date after expiry is a SAP data
      // quality issue — flag separately, don't silently fold into "red".
      dataError = true;
      receiptFlag = "data_error";
    } else {
      const years = slAtReceiptDays / _ISL_YEAR_DAYS;
      if (years < 1.5)      receiptFlag = "red";
      else if (years <= 2)  receiptFlag = "yellow";
      else                  receiptFlag = "green";
    }
  }

  return { slAtReceiptDays, receiptFlag, remainingSLDays, ratio, flag, isExpired, dataError };
}

function _islPopulateFilters() {
  // BUG-ISL-5 FIX: use fmtLocalDate() (local date parts) not toISOString()
  // which shifts UTC midnight dates by one day in UTC+3 (Ethiopia).

  // Posting dates — sorted descending (most recent first)
  // FIX-ISL-TODAY: always include today's date (system/network date) in the
  // list, even if no received-goods row has been posted for it yet — so the
  // filter option exists in advance of today's document being uploaded.
  const dateSet = new Set(
    incomingRaw
      .map(r => r._postingDate)
      .filter(d => d instanceof Date)
      .map(d => fmtLocalDate(d))
  );
  dateSet.add(fmtLocalDate(new Date()));
  const dates = [...dateSet].sort().reverse();

  const dateEl = document.getElementById("isl-filter-date");
  if (dateEl) {
    dateEl.innerHTML = `<option value="">All Posting Dates</option>` +
      dates.map(d => `<option value="${escHtml(d)}">${escHtml(d)}</option>`).join("");
  }

  // Storage locations from received data (HO01 receiving sloc)
  const slocs = [...new Set(incomingRaw.map(r => String(r["Storage Location"] || "").trim()).filter(Boolean))].sort();
  const slocEl = document.getElementById("isl-filter-sloc");
  if (slocEl) {
    slocEl.innerHTML = `<option value="">All Storage Locations</option>` +
      slocs.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join("");
  }

  // Material Group filter — populated from inventory-derived material group
  // (each material's group looked up from the main inventory file)
  const mgs = [...new Set(incomingRaw.map(r => r._inv_materialGroup).filter(g => g && g !== "—"))].sort();
  const mgEl = document.getElementById("isl-filter-mg");
  if (mgEl) {
    mgEl.innerHTML = `<option value="">All Material Groups</option>` +
      mgs.map(g => `<option value="${escHtml(g)}">${escHtml(g)}</option>`).join("");
  }

  // Material multi-select — replaces the old free-text Material Search box
  const matWrap = document.getElementById("ms-isl-mat");
  if (matWrap) {
    const materials = [...new Set(incomingRaw.map(r => {
      const code = String(r["Material"] || "").trim();
      if (!code) return "";
      const desc = String(r["Material Description"] || "").trim();
      return code + (desc && desc !== code ? " — " + desc : "");
    }))].filter(Boolean).sort();
    buildMultiSelect("ms-isl-mat", "ms-isl-mat-dd", materials, "All Materials");
  }
}

function _islGetFiltered() {
  const { date, valType, sloc, mg, materials } = islFilterState;
  const matCodes = (materials || []).map(v => String(v).split(" — ")[0].trim().toLowerCase());
  return incomingRaw.filter(r => {
    // BUG-ISL-5 FIX: compare using local date string (not toISOString)
    if (date) {
      const rd = r._postingDate ? fmtLocalDate(r._postingDate) : "";
      if (rd !== date) return false;
    }
    if (valType && r._vt !== valType) return false;
    if (sloc) {
      const rs = String(r["Storage Location"] || "").trim();
      if (rs !== sloc) return false;
    }
    if (mg && r._inv_materialGroup !== mg) return false;
    // Material filter — replaces the old free-text Material Search box
    if (matCodes.length && !matCodes.includes(String(r["Material"] || "").trim().toLowerCase())) return false;
    return true;
  });
}

function _islFmtDays(d) {
  if (d === null || d === undefined) return "—";
  return `${d.toLocaleString()} days`;
}

// ISSUE-1: separate small badge for "SL at Receipt" classification
// (< 1.5yr red, 1.5-2yr yellow, > 2yr green; data_error if posting after expiry)
function _islReceiptFlagLabel(flag) {
  if (flag === "green")      return `<span class="isl-flag-green">🟢 &gt;2yr</span>`;
  if (flag === "yellow")     return `<span class="isl-flag-yellow">🟡 1.5-2yr</span>`;
  if (flag === "red")        return `<span class="isl-flag-red">🔴 &lt;1.5yr</span>`;
  if (flag === "data_error") return `<span style="background:#a371f7;color:#fff;padding:1px 6px;border-radius:4px;font-weight:700;font-size:0.72rem">⚠ Data Error</span>`;
  return `<span class="isl-flag-grey">—</span>`;
}

// NOTE: ISL material lookup is now handled via the Material filter-bar
// control (ms-isl-mat) feeding _islGetFiltered() — renderIncomingShelfLife()
// below already reflects the current selection directly.

function renderIncomingShelfLife() {
  if (!incomingRaw.length) {
    document.getElementById("incoming-no-file").style.display = "";
    document.getElementById("incoming-content").style.display = "none";
    return;
  }
  document.getElementById("incoming-no-file").style.display = "none";
  document.getElementById("incoming-content").style.display = "block";

  const rows = _islGetFiltered();

  // KPIs — based on SL at Receipt Flag (_receiptFlag)
  const total      = rows.length;
  const green      = rows.filter(r => r._receiptFlag === "green").length;
  const yellow     = rows.filter(r => r._receiptFlag === "yellow").length;
  const red        = rows.filter(r => r._receiptFlag === "red").length;
  const dataErrors = rows.filter(r => r._receiptFlag === "data_error").length;
  const grey       = rows.filter(r => r._receiptFlag === "grey").length;

  const totalMatched  = incomingRaw.length;
  const totalReceived = _incomingRawAll.length;
  const matchNote = totalReceived > totalMatched
    ? `${totalMatched.toLocaleString()} batches / ${totalReceived.toLocaleString()} receipts`
    : `${totalMatched.toLocaleString()} batches`;

  setKpis("isl-kpis", [
    ["Matched Batches",    total.toLocaleString(),      `HO01 · ZME/ZMS/ZLC · ${matchNote}`,  "blue"],
    ["🟢 Green (>2yr)",    green.toLocaleString(),      "Adequate SL at receipt",              "green"],
    ["🟡 Yellow (1.5–2yr)", yellow.toLocaleString(),   "Borderline SL at receipt",            "amber"],
    ["🔴 Red (<1.5yr)",    red.toLocaleString(),        "Short SL at receipt",                 "red"],
    ["⚠ Data Errors",      dataErrors.toLocaleString(),"Posting date after expiry (SAP)",     "purple"],
    ["⚪ No Expiry Date",   grey.toLocaleString(),      "Cannot calculate SL at receipt",      "muted"],
  ]);

  // CHART UPDATE: Shelf Life at Receipt Flag distribution by HO01 Storage
  // Location — uses _receiptFlag (Expiry − Posting Date, supplier compliance)
  // grouped by the storage location the goods were received into.
  const slocMap = {};
  rows.forEach(r => {
    const sloc = String(r["Storage Location"] || "").trim() || "(Blank)";
    if (!slocMap[sloc]) slocMap[sloc] = { green:0, yellow:0, red:0, data_error:0, grey:0 };
    const bucket = slocMap[sloc][r._receiptFlag] !== undefined ? r._receiptFlag : "grey";
    slocMap[sloc][bucket]++;
  });
  const slocs = Object.keys(slocMap).sort();
  Plotly.newPlot("isl-chart-sloc", [
    { name:"🟢 Green (>2yr)",        x: slocs, y: slocs.map(s => slocMap[s].green),      type:"bar", marker:{ color:"#3fb950" } },
    { name:"🟡 Yellow (1.5-2yr)",    x: slocs, y: slocs.map(s => slocMap[s].yellow),     type:"bar", marker:{ color:"#d29922" } },
    { name:"🔴 Red (<1.5yr)",        x: slocs, y: slocs.map(s => slocMap[s].red),        type:"bar", marker:{ color:"#f85149" } },
    { name:"⚠ Data Error",          x: slocs, y: slocs.map(s => slocMap[s].data_error), type:"bar", marker:{ color:"#a371f7" } },
    { name:"⚪ No Expiry Date",      x: slocs, y: slocs.map(s => slocMap[s].grey),       type:"bar", marker:{ color:"#6e7681" } },
  ], { ...pl(), barmode:"stack", height:280, title:"Shelf Life at Receipt Flag Distribution by Storage Location" }, PLOTLY_CONFIG);


  // Count info
  const countEl = document.getElementById("isl-count");
  countEl.style.display = "block";
  countEl.textContent = `Showing ${rows.length.toLocaleString()} record${rows.length !== 1 ? "s" : ""}`;

  // BUG-ISL-6 FIX: table columns reflect correct data sources —
  //   • Expiry Date → from inventory (SAP master via _inv_*)
  //   • Posting Date & Document Number → from received goods data (latest receipt = reference)
  //   • Plants in Inventory / Inventory Slocs → enriched from rawDf all branches
  // ISSUE-1: two SL columns (SL at Receipt vs SL Remaining Today)
  // ISSUE-2: grouped quantity / receipt count columns
  const COLS = [
    { key:"Material",             label:"Material Code" },
    { key:"Material Description", label:"Material Description" },
    { key:"Batch",                label:"Batch" },
    { key:"_vt",                  label:"Val. Type" },
    // ── From received goods data (HO01 receipt event, latest of group) ──
    { key:"Storage Location",     label:"HO01 Receipt Sloc",
      fmt: v => v ? escHtml(String(v)) : "—", raw: true },
    { key:"_postingDate",         label:"Latest Posting Date",
      fmt: v => v ? fmtLocalDate(v) : "—" },
    { key:"_groupedQty",          label:"Total Qty Received",
      fmt: v => fmtQty(v) },
    { key:"_receiptCount",        label:"# GR Postings",
      fmt: v => v ? v.toLocaleString() : "1" },
    { key:"Material Document",    label:"GR Document No. (latest)",
      fmt: v => v ? escHtml(String(v)) : "—", raw: true },
    // ── From inventory (authoritative SAP master) ──
    { key:"_inv_expiryDate",      label:"Expiry Date (Inv)",
      fmt: v => v instanceof Date ? fmtLocalDate(v) : (v ? String(v) : "—") },
    // SL at Receipt: Expiry − Posting Date (supplier compliance)
    { key:"_slAtReceiptDays",     label:"SL at Receipt (days)",  fmt: v => _islFmtDays(v) },
    { key:"_receiptFlag",         label:"SL at Receipt Flag",
      fmt: v => _islReceiptFlagLabel(v), raw: true },
    // SL Remaining Today: Expiry − Today (distribution urgency)
    { key:"_remainingSL",         label:"SL Remaining Today (days)",  fmt: v => _islFmtDays(v) },
    // ── Current inventory distribution (all branches) ──
    { key:"_inv_plants",          label:"Plants in Inventory",
      fmt: v => v ? `<span style="font-size:0.7rem;white-space:nowrap">${escHtml(String(v))}</span>` : "—", raw: true },
    { key:"_inv_slocs",           label:"Storage Location",
      fmt: v => v ? `<span style="font-size:0.68rem;color:var(--muted);white-space:nowrap">${escHtml(String(v))}</span>` : "—", raw: true },
    { key:"_inv_totalQty",        label:"Total Inv. Qty",
      fmt: v => (v !== undefined && v !== null) ? fmtQty(v) : "—" },
  ];

  const wrap = document.getElementById("isl-table-wrap");
  if (!rows.length) { wrap.innerHTML = '<p class="alert-info">No records match the current filters.</p>'; return; }

  let html = '<div class="tbl-wrap"><table><thead><tr>';
  COLS.forEach(c => { html += `<th>${escHtml(c.label)}</th>`; });
  html += "</tr></thead><tbody>";

  const LIMIT = 2000;
  rows.slice(0, LIMIT).forEach(r => {
    html += "<tr>";
    COLS.forEach(c => {
      const raw = r[c.key] ?? "";
      const disp = c.fmt ? c.fmt(raw, r) : raw;
      const val  = c.raw ? disp : escHtml(String(disp ?? ""));
      html += `<td>${val}</td>`;
    });
    html += "</tr>";
  });
  html += "</tbody></table></div>";
  if (rows.length > LIMIT) html += `<div class="alert-info" style="margin-top:0.5rem">Showing first ${LIMIT.toLocaleString()} of ${rows.length.toLocaleString()} records. Download Excel/CSV for full data.</div>`;
  wrap.innerHTML = html;

  // ── Download helpers ────────────────────────────────────────────────────────
  // Flatten a row for export: strip HTML from raw columns, format dates/ratios
  const RECEIPT_FLAG_LABEL = { green:">2yr", yellow:"1.5-2yr", red:"<1.5yr", data_error:"Data Error (posting after expiry)", grey:"—" };

  function _islFlatRow(r) {
    return {
      "Material Code":            r["Material"]          || "",
      "Material Description":     r["Material Description"] || "",
      "Batch":                    r["Batch"]             || "",
      "Val. Type":                r._vt                  || "",
      "HO01 Receipt Sloc":        String(r["Storage Location"] || ""),
      "Latest Posting Date":      r._postingDate ? fmtLocalDate(r._postingDate) : "",
      "Total Qty Received":       r._groupedQty   !== undefined ? r._groupedQty   : "",
      "# GR Postings":            r._receiptCount !== undefined ? r._receiptCount : 1,
      "GR Document No. (latest)": String(r["Material Document"] || r["GR Document"] || ""),
      "Expiry Date (Inv)":        r._inv_expiryDate instanceof Date ? fmtLocalDate(r._inv_expiryDate) : (r._inv_expiryDate ? String(r._inv_expiryDate) : ""),
      "SL at Receipt (days)":     r._slAtReceiptDays !== null && r._slAtReceiptDays !== undefined ? r._slAtReceiptDays : "",
      "SL at Receipt Flag":       RECEIPT_FLAG_LABEL[r._receiptFlag] || r._receiptFlag || "",
      "SL Remaining Today (days)": r._remainingSL !== null && r._remainingSL !== undefined ? r._remainingSL : "",
      "Plants in Inventory":      r._inv_plants  || "",
      "Storage Location":          r._inv_slocs   || "",
      "Total Inv. Qty":           r._inv_totalQty !== undefined ? r._inv_totalQty : "",
    };
  }

  // ISSUE-5 FIX: static export key list — doesn't depend on rows[0], so
  // headers are always correct even when the filtered set is empty.
  const EXPORT_KEYS = [
    "Material Code","Material Description","Batch","Val. Type",
    "HO01 Receipt Sloc","Latest Posting Date","Total Qty Received","# GR Postings",
    "GR Document No. (latest)","Expiry Date (Inv)",
    "SL at Receipt (days)","SL at Receipt Flag",
    "SL Remaining Today (days)",
    "Plants in Inventory","Storage Location","Total Inv. Qty",
  ];
  const exportColDefs = EXPORT_KEYS.map(k => ({ key: k, label: k }));
  const exportRows    = rows.map(_islFlatRow);

  injectDlButtons("isl-dl-row",
    () => {
      const header = EXPORT_KEYS.join(",");
      const lines  = exportRows.map(r => EXPORT_KEYS.map(k => {
        let v = String(r[k] ?? "");
        if (v.includes(",") || v.includes('"') || v.includes("\n")) v = `"${v.replace(/"/g,'""')}"`;
        return v;
      }).join(","));
      const blob = new Blob(["\uFEFF" + header + "\n" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a"); a.href = url; a.download = "shelf_life_lookup.csv"; a.click();
      URL.revokeObjectURL(url);
    },
    () => downloadExcel(exportRows, exportColDefs, "shelf_life_lookup.xlsx")
  );

}

// ═══════════════════════════════════════════════════════════════════════════
// STOCK CONCENTRATION
// ═══════════════════════════════════════════════════════════════════════════
function renderConcentration() {
  // ── Build filtered dataset (no plant filter — concentration is cross-plant) ──
  const f           = pageFilters["concentration"] || {};
  const base        = getReconciledBase();
  const mgs         = f.mgs      || [];
  const valTypes    = f.valTypes || [];
  // FIX-CONC-MAP: honour mapping table state — only use _mappedMaterial as key
  // when a mapping file is actually loaded, otherwise fall back to raw Material.
  // Without this guard, unmapped rows (where _mappedMaterial === original code)
  // would be counted correctly, but the intent is unclear and inconsistent with
  // aggregateByMappedMaterial which is the canonical pattern across all pages.
  const useMapped   = mappingTable.size > 0;

  const df = base.filter(r =>
    !isNonMedicalCode(r["Material"]) &&
    !isNonMedicalGroup(r["Material Group Name"]) &&
    !isProjectStockDescription(r["Special Stock Type Description"]) &&
    !isExcludedStorageLocation(r["Storage Location"]) &&
    (function(){ const s = String(r["Special Stock Type"] || "").trim().toUpperCase(); return s !== "Q" && s !== "W"; })() &&
    String(r["Inventory Valuation Type"] || "").trim() !== "" &&
    (!mgs.length      || mgs.includes(r["Material Group Name"])) &&
    (!valTypes.length || valTypes.includes(getValuationType(r)))
  );



  if (!df.length) {
    document.getElementById("conc-kpis").innerHTML = "";
    document.getElementById("conc-analysis-cards").innerHTML = `<div class="alert-info">No data after filters.</div>`;
    document.getElementById("conc-table-wrap").innerHTML = "";
    document.getElementById("conc-dl-row").innerHTML = "";
    document.getElementById("chart-conc-pie").innerHTML = "";
    document.getElementById("chart-conc-spread").innerHTML = "";
    return;
  }

  // ── 1. Plant-level aggregation (value basis) ──
  const plantValMap = {};
  df.forEach(r => {
    const k = r["Plant Name"] || "(Blank)";
    if (!plantValMap[k]) plantValMap[k] = 0;
    plantValMap[k] += getMappedVal(r, "Value of Unrestricted Stock")
                    + getVerifiedTransitVal(r)
                    + getMappedVal(r, "Value of Stock in Quality Inspection");
  });
  const totalVal = Object.values(plantValMap).reduce((s, v) => s + v, 0);
  const plantValArr = Object.entries(plantValMap)
    .map(([name, val]) => ({ name, val, pct: totalVal > 0 ? (val / totalVal) * 100 : 0 }))
    .sort((a, b) => b.val - a.val);

  // ── 2. Per-material, per-plant aggregation (unrestricted qty + value) ──
  // FIX-CONC-MAP: key by _mappedMaterial only when mapping is active — this is
  // the single change that makes two SAP codes mapping to the same target drug
  // collapse into one row. Without useMapped guard they stayed separate because
  // unmapped rows' _mappedMaterial equals their original code (no merger).
  const matPlantMap = {};
  df.forEach(r => {
    const mat   = useMapped ? (r._mappedMaterial || r["Material"]) : r["Material"];
    const desc  = useMapped ? (r._mappedDesc    || r["Material Description"] || "") : (r["Material Description"] || "");
    const plant = r["Plant Name"] || "(Blank)";
    const orig  = r._origMaterial || r["Material"];
    if (!mat) return;
    if (!matPlantMap[mat]) {
      matPlantMap[mat] = {
        desc,
        plants:    {},
        totalQty:  0,
        totalVal:  0,
        origCodes: new Set(),   // FIX-CONC-MAP: track all original SAP codes merged here
      };
    }
    const qty = getMappedQty(r, "Unrestricted Stock");
    const val = getMappedVal(r, "Value of Unrestricted Stock");
    if (!matPlantMap[mat].plants[plant]) matPlantMap[mat].plants[plant] = { qty: 0, val: 0 };
    matPlantMap[mat].plants[plant].qty += qty;
    matPlantMap[mat].plants[plant].val += val;
    matPlantMap[mat].totalQty += qty;
    matPlantMap[mat].totalVal += val;
    if (orig && orig !== mat) matPlantMap[mat].origCodes.add(orig);
  });

  // ── 3. Concentration classification ──
  // For each material find the dominant plant
  const matConcentration = Object.entries(matPlantMap).map(([mat, info]) => {
    const plantCount = Object.keys(info.plants).length;
    const topPlant   = Object.entries(info.plants)
      .sort((a, b) => b[1].qty - a[1].qty)[0];
    const topPlantName = topPlant ? topPlant[0] : "—";
    const topQty       = topPlant ? topPlant[1].qty : 0;
    const topVal       = topPlant ? topPlant[1].val : 0;
    const pctQty       = info.totalQty > 0 ? (topQty / info.totalQty) * 100 : 0;
    const pctVal       = info.totalVal > 0 ? (topVal / info.totalVal) * 100 : 0;
    const origCodes    = [...info.origCodes].sort().join(", ");
    return { mat, desc: info.desc, plantCount, topPlantName, topQty, topVal, pctQty, pctVal, totalQty: info.totalQty, totalVal: info.totalVal, origCodes };
  }).filter(r => r.totalQty > 0); // only materials with unrestricted stock

  // Band classification
  const sole   = matConcentration.filter(r => r.pctQty >= 80);  // >80% in one plant
  const few    = matConcentration.filter(r => r.pctQty < 80 && r.plantCount >= 2 && r.plantCount <= 4);
  const spread = matConcentration.filter(r => r.pctQty < 80 && r.plantCount >= 5 && r.plantCount <= 8);
  const wide   = matConcentration.filter(r => r.pctQty < 80 && r.plantCount > 8);

  // ── KPIs ──
  const topPlantPct = plantValArr.length > 0 ? plantValArr[0].pct : 0;
  const totalMats   = matConcentration.length;
  // FIX-CONC-MAP: count unique materials by mapped code when mapping is active
  const uniqueMatCount = useMapped
    ? new Set(df.map(r => r._mappedMaterial || r["Material"])).size
    : new Set(df.map(r => r["Material"])).size;
  setKpis("conc-kpis", [
    ["Total Unique Plants",      new Set(df.map(r => r["Plant Name"])).size.toLocaleString(),        "With unrestricted stock",       "blue"],
    ["Sole-Branch Materials",    sole.length.toLocaleString(),   `${totalMats > 0 ? ((sole.length/totalMats)*100).toFixed(0) : 0}% of materials`,  "red"],
    ["Few-Branch Materials",     few.length.toLocaleString(),    "Held in 2–4 plants",               "amber"],
    ["Top Plant Share",          topPlantPct.toFixed(1) + "%",   plantValArr[0]?.name || "—",        "purple"],
    ["Unique Materials Tracked", uniqueMatCount.toLocaleString(), useMapped ? "Standardized (merged)" : "Unrestricted stock only", "green"],
  ]);

  // ── Pie chart: value by plant ──
  const pieLabels = plantValArr.map(r => r.name);
  const pieVals   = plantValArr.map(r => r.val);
  const pieText   = plantValArr.map(r => `${r.pct.toFixed(1)}%`);
  Plotly.newPlot("chart-conc-pie", [{
    type: "pie",
    labels: pieLabels,
    values: pieVals,
    text:   pieText,
    textinfo: "label+percent",
    hovertemplate: "<b>%{label}</b><br>ETB %{value:,.0f}<br>%{percent}<extra></extra>",
    hole: 0.38,
    marker: { colors: COLORWAY },
    textfont: { size: 11 },
  }], pl({
    height: 300,
    margin: { l: 10, r: 10, t: 10, b: 10 },
    showlegend: false,
  }), PLOTLY_CONFIG);

  // ── Concentration Analysis Cards ──
  function bandCard(cls, icon, count, label, desc) {
    return `<div class="conc-band-card ${cls}">
      <div class="conc-band-icon">${icon}</div>
      <div class="conc-band-count">${count}</div>
      <div class="conc-band-label">${label}</div>
      <div class="conc-band-desc">${desc}</div>
    </div>`;
  }
  document.getElementById("conc-analysis-cards").innerHTML = `
    <div class="conc-analysis-grid">
      ${bandCard("sole",   "🔴", sole.length,   "Sole Branch",   ">80% of stock in a single plant — high supply-chain risk")}
      ${bandCard("few",    "🟠", few.length,    "Few Branches",  "Spread across 2–4 plants — limited redundancy")}
      ${bandCard("spread", "🟡", spread.length, "Moderate Spread","Across 5–8 plants — reasonable distribution")}
      ${bandCard("wide",   "🟢", wide.length,   "Wide Spread",   "Across 9+ plants — well distributed")}
    </div>
    <div style="margin-top:0.85rem;font-size:0.7rem;color:var(--dim);line-height:1.5">
      Classification based on <b>% of total unrestricted quantity</b> held by the top plant per material.
      <br>Sole Branch threshold: ≥80% in one plant.
    </div>`;

  // ── Highly Concentrated Table (all sole-branch materials, sorted by total value) ──
  const topConcentrated = [...sole]
    .sort((a, b) => b.totalVal - a.totalVal);

  if (topConcentrated.length === 0) {
    document.getElementById("conc-table-wrap").innerHTML = `<div class="alert-info">✓ No materials with &gt;80% concentration in a single plant.</div>`;
    document.getElementById("conc-dl-row").innerHTML = "";
  } else {
    const cols = [
      { key: "mat",         label: "Material Code",    fmt: (v, r) => renderMatCode(r.Material, r), raw: true, cellClass: "col-mat-code-wrap" },
      { key: "desc",        label: "Description",      fmt: (v)    => `<span class="col-mat-desc">${escHtml(String(v||""))}</span>`, raw: true, cellClass: "col-mat-desc-wrap" },
      { key: "topPlantName",label: "Dominant Plant",   fmt: (v)    => `<span class="conc-plant-pill" title="${escHtml(String(v||""))}">${escHtml(String(v||""))}</span>`, raw: true },
      { key: "topQty",      label: "Qty in Plant",     fmt: fmtQty, rawKey: "topQty",   cellClass: "col-qty" },
      { key: "totalQty",    label: "Total Qty",        fmt: fmtQty, rawKey: "totalQty", cellClass: "col-qty" },
      { key: "totalVal",    label: "Total Value (ETB)",fmt: fmtETB, rawKey: "totalVal", cellClass: "col-val" },
      {
        key: "pctQty",
        label: "% of Qty in Top Plant",
        fmt: (v) => {
          const cls = v >= 95 ? "critical" : "high";
          return `<span class="conc-pct-badge ${cls}">${Number(v).toFixed(1)}%</span>`;
        },
        raw: true,
      },
    ];

    // Build plain objects for buildTable
    // FIX-CONC-STD: attach mapping fields so renderMatCode delegates to
    // renderMappedMatCode_early and shows the STD badge just like every other page.
    // A row is "mapped" when mapping is active AND it has at least one original
    // SAP code that differs from the target (i.e. it merged ≥1 source code).
    const rows = topConcentrated.map(r => {
      const hasMergedCodes = useMapped && r.origCodes && r.origCodes.length > 0;
      return {
        mat:             r.mat,
        // The "Material" key is what renderMatCode reads as `val` (first arg)
        Material:        r.mat,
        desc:            r.desc,
        origCodes:       r.origCodes || "",
        topPlantName:    r.topPlantName,
        topQty:          r.topQty,
        totalQty:        r.totalQty,
        totalVal:        r.totalVal,
        pctQty:          r.pctQty,
        // Mapping display fields — mirror what applyMaterialMapping stamps on rows
        _isMapped:       hasMergedCodes,
        _mappedMaterial: r.mat,
        _origMaterial:   hasMergedCodes ? r.origCodes.split(", ")[0] : r.mat,
        _mappedDesc:     r.desc,
        _origDesc:       "",
      };
    });
    document.getElementById("conc-table-wrap").innerHTML = buildTable(rows, cols,
      (row) => row.pctQty >= 95 ? "row-critical" : "row-warning"
    );

    // Export buttons — use plain exportable cols (strip raw HTML formatters)
    const exportCols = [
      { key:"mat",          label:"Material Code" },
      { key:"desc",         label:"Description" },
      { key:"topPlantName", label:"Dominant Plant" },
      { key:"topQty",       label:"Qty in Plant",        fmt:fmtQty, rawKey:"topQty" },
      { key:"totalQty",     label:"Total Qty",            fmt:fmtQty, rawKey:"totalQty" },
      { key:"totalVal",     label:"Total Value (ETB)",    fmt:fmtETB, rawKey:"totalVal" },
      { key:"pctQty",       label:"% in Top Plant",       fmt: v => Number(v).toFixed(1) + "%" },
    ];
    injectDlButtons("conc-dl-row",
      () => downloadCSV(rows,   exportCols, "concentrated_items.csv"),
      () => downloadExcel(rows, exportCols, "concentrated_items.xlsx"));
  }

  // ── Branch Spread Bar Chart ──
  // Count materials by number of plants they occupy
  const spreadCountMap = {};
  matConcentration.forEach(r => {
    const k = r.plantCount;
    spreadCountMap[k] = (spreadCountMap[k] || 0) + 1;
  });
  const spreadKeys  = Object.keys(spreadCountMap).map(Number).sort((a, b) => a - b);
  const spreadCounts = spreadKeys.map(k => spreadCountMap[k]);
  const spreadColors = spreadKeys.map(k =>
    k === 1 ? "#f85149" : k <= 4 ? "#ffa657" : k <= 8 ? "#d29922" : "#3fb950"
  );

  const spreadLabels = spreadKeys.map(k =>
    k === 1 ? "1 plant\n(sole)" : `${k} plant${k > 1 ? "s" : ""}`
  );

  // Build a lookup: plantCount → array of material codes (used by click handler)
  const _spreadByPlantCount = {};
  matConcentration.forEach(r => {
    if (!_spreadByPlantCount[r.plantCount]) _spreadByPlantCount[r.plantCount] = [];
    _spreadByPlantCount[r.plantCount].push(r.mat);
  });

  Plotly.newPlot("chart-conc-spread", [{
    type: "bar",
    x: spreadLabels,
    y: spreadCounts,
    marker: {
      color: spreadColors,
      line: { color: "rgba(255,255,255,0.15)", width: 1 },
    },
    hovertemplate: "<b>%{x}</b><br>%{y} material(s)<br><i>Click to explore in Branch Comparison →</i><extra></extra>",
    text: spreadCounts,
    textposition: "outside",
    textfont: { size: 10 },
    customdata: spreadKeys,   // parallel array: raw plant-count number for each bar
  }], pl({
    height: 300,
    margin: { l: 20, r: 20, t: 30, b: 70 },
    xaxis: { title: { text: "Number of plants stocking the material  ·  Click a bar to explore in Branch Comparison →", font: { size: 10 } }, tickfont: { size: 10 } },
    yaxis: { title: { text: "Materials", font: { size: 10 } }, tickformat: ",d" },
    showlegend: false,
  }), PLOTLY_CONFIG);

  // ── Drilldown: clicking a bar navigates to Branch Comparison ──────────────
  // We attach the listener to the Plotly div directly; the handler is replaced on
  // every renderConcentration() call so stale closures over old data never fire.
  const spreadDiv = document.getElementById("chart-conc-spread");
  // Plotly sets cursor to 'pointer' on bar hover automatically but we make it
  // explicit so users see the affordance even before hovering over a bar.
  spreadDiv.style.cursor = "pointer";

  spreadDiv.on("plotly_click", function(eventData) {
    const pt = eventData && eventData.points && eventData.points[0];
    if (!pt) return;

    // pt.customdata is the raw plantCount number we stored above
    const clickedCount = pt.customdata;
    const mats = _spreadByPlantCount[clickedCount];
    if (!mats || !mats.length) return;

    // Stash drilldown payload so renderBranch can read it after navigation
    _lastSpreadDrilldown = { plantCount: clickedCount, matCodes: mats };

    // Navigate to Branch Comparison — renderPage calls renderBranch() which
    // rebuilds the DOM; we hook in once the tab/filter UI is ready.
    renderPage("branch");
  });
}

const PAGE_RENDERERS = {
  dashboard:     renderDashboard,
  transit:       renderTransit,
  expiry:        renderExpiry,
  qc:            renderQC,
  branch:        renderBranch,
  flow:          renderFlow,
  incoming:      renderIncomingShelfLife,
  concentration: renderConcentration,
};

function renderPage(id) {
  // Home page removed — redirect to dashboard
  if (id === "home") id = "dashboard";
  if (id !== "incoming" && !rawDf.length) return;
  if (id === "incoming" && !rawDf.length && !incomingRaw.length) {
    // Show the page shell but with the "no file" message
    currentPage = id;
    document.getElementById("landingView").style.display = "none";
    document.querySelectorAll(".page").forEach(el => { el.style.display = "none"; });
    const pg = document.getElementById("page-incoming");
    if (pg) pg.style.display = "block";
    document.querySelectorAll(".nav-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.page === id));
    return;
  }
  currentPage = id;
  // Hide the pre-data landing splash whenever any page is shown
  document.getElementById("landingView").style.display = "none";
  document.querySelectorAll(".page").forEach(el => { el.style.display = "none"; });
  const pg = document.getElementById(`page-${id}`);
  if (pg) pg.style.display = "block";
  document.querySelectorAll(".nav-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.page === id));
  try {
    PAGE_RENDERERS[id]?.();
  } catch(e) {
    console.error(`Error rendering ${id}:`, e);
    // Show a friendly in-page error rather than a blank page
    if (pg) pg.innerHTML = `<div class="alert-danger" style="margin-top:2rem">
      ⚠️ An error occurred while rendering this page: <b>${escHtml(e.message)}</b>
      <br><small style="opacity:0.7">Check the browser console for details.</small>
    </div>`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EVENT LISTENERS
// ═══════════════════════════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", () => {
  // Dashboard is the default page (Home removed)

  // Nav
  document.querySelectorAll(".nav-btn[data-page]").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.page;
      // Incoming Shelf Life can be navigated to without the main inventory file
      if (target === "incoming") { renderPage("incoming"); return; }
      renderPage(target);
    });
  });

  // File upload
  document.getElementById("fileInput").addEventListener("change", e => {
    const f = e.target.files[0];
    if (f) loadFile(f);
    // FIX-FILE-RESET: reset value so the same file can be re-uploaded (e.g. after editing)
    e.target.value = "";
  });

  // Incoming Shelf Life file upload
  document.getElementById("incomingFileInput").addEventListener("change", e => {
    const f = e.target.files[0]; if (f) loadIncomingFile(f);
    e.target.value = "";
  });

  // Incoming Shelf Life filter wiring
  document.getElementById("isl-filter-apply").addEventListener("click", () => {
    islFilterState.date    = (document.getElementById("isl-filter-date")    || {}).value || "";
    islFilterState.valType = (document.getElementById("isl-filter-valtype") || {}).value || "";
    islFilterState.sloc    = (document.getElementById("isl-filter-sloc")    || {}).value || "";
    islFilterState.mg      = (document.getElementById("isl-filter-mg")      || {}).value || "";
    const matWrap = document.getElementById("ms-isl-mat");
    islFilterState.materials = (matWrap && matWrap._getSelected) ? matWrap._getSelected() : [];
    renderIncomingShelfLife();
  });
  document.getElementById("isl-filter-clear").addEventListener("click", () => {
    islFilterState.date = islFilterState.valType = islFilterState.sloc = islFilterState.mg = "";
    islFilterState.materials = [];
    ["isl-filter-date","isl-filter-valtype","isl-filter-sloc","isl-filter-mg"].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = "";
    });
    const matWrap = document.getElementById("ms-isl-mat");
    if (matWrap && matWrap._clearSelected) matWrap._clearSelected();
    renderIncomingShelfLife();
  });

  // Stock in Transit file upload
  document.getElementById("transitFileInput").addEventListener("change", e => {
    const f = e.target.files[0]; if (f) loadTransitFile(f);
    e.target.value = "";
  });

  // Material Standardization Mapping file upload
  document.getElementById("mappingFileInput").addEventListener("change", e => {
    const f = e.target.files[0]; if (f) loadMappingFile(f);
    e.target.value = "";
  });

  // Stock in Transit section filter wiring
  document.getElementById("st-filter-apply").addEventListener("click", () => {
    stFilterState.purDoc   = (document.getElementById("st-filter-pur-doc")   || {}).value || "";
    stFilterState.supPlant = (document.getElementById("st-filter-sup-plant") || {}).value || "";
    renderStockTransitSection();
  });
  document.getElementById("st-filter-clear").addEventListener("click", () => {
    stFilterState = { purDoc: "", supPlant: "" };
    const purDocEl   = document.getElementById("st-filter-pur-doc");
    const supPlantEl = document.getElementById("st-filter-sup-plant");
    if (purDocEl)   purDocEl.value   = "";
    if (supPlantEl) supPlantEl.value = "";
    renderStockTransitSection();
  });

  // Expiry window radio
  document.getElementById("expiry-window-group").addEventListener("change", () => {
    if (rawDf.length && currentPage === "expiry") renderExpiry();
  });

  // ── Page filter wiring (event delegation) ──────────────────────────────
  // Uses document-level delegation so listeners survive any DOM rebuild
  // (e.g. the renderPage error path replaces pg.innerHTML entirely).
  // Each Apply/Clear button is identified by its stable ID.

  const PAGE_FILTER_MAP = {
    "dash-filter-apply":    { page:"dashboard", plantWrap:"ms-dash-plant",    mgWrap:"ms-dash-mg",    vtWrap:"ms-dash-vt",    matWrap:null,             action:"apply" },
    "dash-filter-clear":    { page:"dashboard", plantWrap:"ms-dash-plant",    mgWrap:"ms-dash-mg",    vtWrap:"ms-dash-vt",    matWrap:null,             action:"clear" },
    "transit-filter-apply": { page:"transit",   plantWrap:"ms-transit-plant", mgWrap:"ms-transit-mg", vtWrap:"ms-transit-vt", matWrap:"ms-transit-mat", action:"apply" },
    "transit-filter-clear": { page:"transit",   plantWrap:"ms-transit-plant", mgWrap:"ms-transit-mg", vtWrap:"ms-transit-vt", matWrap:"ms-transit-mat", action:"clear" },
    "expiry-filter-apply":  { page:"expiry",    plantWrap:"ms-expiry-plant",  mgWrap:"ms-expiry-mg",  vtWrap:"ms-expiry-vt",  matWrap:"ms-expiry-mat",  action:"apply" },
    "expiry-filter-clear":  { page:"expiry",    plantWrap:"ms-expiry-plant",  mgWrap:"ms-expiry-mg",  vtWrap:"ms-expiry-vt",  matWrap:"ms-expiry-mat",  action:"clear" },
    "qc-filter-apply":      { page:"qc",        plantWrap:"ms-qc-plant",      mgWrap:"ms-qc-mg",      vtWrap:"ms-qc-vt",      matWrap:"ms-qc-mat",      action:"apply" },
    "qc-filter-clear":      { page:"qc",        plantWrap:"ms-qc-plant",      mgWrap:"ms-qc-mg",      vtWrap:"ms-qc-vt",      matWrap:"ms-qc-mat",      action:"clear" },

    "flow-filter-apply":    { page:"flow",          plantWrap:"ms-flow-plant",    mgWrap:"ms-flow-mg",    vtWrap:"ms-flow-vt",    matWrap:"ms-flow-mat",    action:"apply" },
    "flow-filter-clear":    { page:"flow",          plantWrap:"ms-flow-plant",    mgWrap:"ms-flow-mg",    vtWrap:"ms-flow-vt",    matWrap:"ms-flow-mat",    action:"clear" },
    "conc-filter-apply":    { page:"concentration", plantWrap:null,               mgWrap:"ms-conc-mg",    vtWrap:"ms-conc-vt",    matWrap:null,             action:"apply" },
    "conc-filter-clear":    { page:"concentration", plantWrap:null,               mgWrap:"ms-conc-mg",    vtWrap:"ms-conc-vt",    matWrap:null,             action:"clear" },
  };

  document.body.addEventListener("click", (e) => {
    const btn = e.target.closest("button[id]");
    if (!btn) return;
    const cfg = PAGE_FILTER_MAP[btn.id];
    if (!cfg) return;
    if (!rawDf.length) return;

    e.stopPropagation();
    // Close any open dropdowns first
    document.querySelectorAll(".ms-wrap.open").forEach(w => w.classList.remove("open"));

    if (cfg.action === "apply") {
      if (cfg.plantWrap) {
        const wrap = document.getElementById(cfg.plantWrap);
        pageFilters[cfg.page].plants = (wrap && wrap._getSelected) ? wrap._getSelected() : [];
      }
      if (cfg.mgWrap) {
        const wrap = document.getElementById(cfg.mgWrap);
        pageFilters[cfg.page].mgs = (wrap && wrap._getSelected) ? wrap._getSelected() : [];
      }
      if (cfg.vtWrap) {
        const wrap = document.getElementById(cfg.vtWrap);
        pageFilters[cfg.page].valTypes = (wrap && wrap._getSelected) ? wrap._getSelected() : [];
      }
      if (cfg.matWrap) {
        const wrap = document.getElementById(cfg.matWrap);
        pageFilters[cfg.page].materials = (wrap && wrap._getSelected) ? wrap._getSelected() : [];
      }
    } else {
      if (cfg.plantWrap) {
        pageFilters[cfg.page].plants = [];
        const wrap = document.getElementById(cfg.plantWrap);
        if (wrap && wrap._clearSelected) wrap._clearSelected();
      }
      if (cfg.mgWrap) {
        pageFilters[cfg.page].mgs = [];
        const wrap = document.getElementById(cfg.mgWrap);
        if (wrap && wrap._clearSelected) wrap._clearSelected();
      }
      if (cfg.vtWrap) {
        pageFilters[cfg.page].valTypes = [];
        const wrap = document.getElementById(cfg.vtWrap);
        if (wrap && wrap._clearSelected) wrap._clearSelected();
      }
      if (cfg.matWrap) {
        pageFilters[cfg.page].materials = [];
        const wrap = document.getElementById(cfg.matWrap);
        if (wrap && wrap._clearSelected) wrap._clearSelected();
      }
    }
    renderPage(cfg.page);
  });

});

// ── GLOBAL MATERIAL SEARCH ─────────────────────────────────────────────────
(function () {
  function fmt(n) {
    if (n == null || isNaN(+n)) return "—";
    return (+n).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  // FIX-R6: added export buttons so users always have a download path, not just
  // when results are truncated past 200 rows.
  // BUG-FIX-1: renamed from buildTable → gsrBuildTable to avoid collision with the
  // global buildTable at line 582 (different signatures: rowClass fn vs exportFilename str).
  // exportCols (optional) lets callers supply plain-text column defs for CSV/Excel
  // export — display cols often use raw:true/fmt to render HTML badges/links,
  // which would leak markup into a spreadsheet if exported as-is. When omitted,
  // falls back to display cols (fine for plain text-only column sets).
  function gsrBuildTable(rows, cols, exportFilename, exportCols) {
    if (!rows.length) return '<p class="gsr-no-data">No matching records found.</p>';
    let html = '<div class="tbl-wrap"><table><thead><tr>';
    cols.forEach(c => { html += `<th>${escHtml(c.label)}</th>`; });
    html += "</tr></thead><tbody>";
    rows.slice(0, 200).forEach(r => {
      html += "<tr>";
      cols.forEach(c => {
        const rawVal = r[c.key] ?? "";
        const display = c.fmt ? c.fmt(rawVal, r) : rawVal;
        const val = c.raw ? display : escHtml(String(display ?? ""));
        const cls = (c.cellClass || c.cls) ? ` class="${c.cellClass || c.cls}"` : "";
        html += `<td${cls}>${val}</td>`;
      });
      html += "</tr>";
    });
    html += "</tbody></table></div>";

    const safeFile  = exportFilename || "search_results.csv";
    const baseName   = safeFile.replace(/\.csv$/i, "");
    const safeId     = baseName.replace(/\W/g, "_");
    const csvFile    = baseName + ".csv";
    const xlsxFile   = baseName + ".xlsx";
    const colsForExport = exportCols || cols;
    const noteText   = rows.length > 200 ? `Showing first 200 of ${rows.length} rows. ` : "";

    html += `<p class="gsr-no-data" style="margin-top:0.4rem">
      ${noteText}
      <button id="gsr-export-csv-${safeId}" class="dl-btn" style="font-size:0.72rem;padding:3px 10px;margin-left:6px">⬇ CSV (${rows.length} rows)</button>
      <button id="gsr-export-xlsx-${safeId}" class="dl-btn" style="font-size:0.72rem;padding:3px 10px;margin-left:6px">⬇ Excel (${rows.length} rows)</button>
    </p>`;
    // Wire export after insertion via a deferred data attribute approach
    setTimeout(() => {
      const csvBtn  = document.getElementById(`gsr-export-csv-${safeId}`);
      const xlsxBtn = document.getElementById(`gsr-export-xlsx-${safeId}`);
      if (csvBtn)  csvBtn.addEventListener("click",  () => downloadCSV(rows,   colsForExport, csvFile),  { once: true });
      if (xlsxBtn) xlsxBtn.addEventListener("click", () => downloadExcel(rows, colsForExport, xlsxFile), { once: true });
    }, 0);
    return html;
  }

  function showResultsPanel() {
    document.getElementById("global-search-results-panel").style.display = "block";
  }
  function hideResultsPanel() {
    document.getElementById("global-search-results-panel").style.display = "none";
  }

  function runSearch() {
    const q = (document.getElementById("global-search-input").value || "").trim().toLowerCase();
    const out = document.getElementById("global-search-results");
    if (!q) { out.innerHTML = ""; hideResultsPanel(); return; }

    // ── In-Stock results ──
    // FIX-SEARCH-MAPPED: use the reconciled base (mappedDf when mapping is active)
    // so search matches on standardized material codes/descriptions, and aggregate
    // per-material so the quantities shown match the QC/Dashboard KPIs exactly.
    const base = getReconciledBase();
    const stockRowsRaw = base.filter(r => {
      const code     = String(r._mappedMaterial || r["Material"] || "").toLowerCase();
      const origCode = String(r["Material"] || "").toLowerCase();
      const desc     = String(r._mappedDesc || r["Material Description"] || "").toLowerCase();
      return code.includes(q) || origCode.includes(q) || desc.includes(q);
    });
    // Aggregate to match what QC/Dashboard pages show (one row per canonical material)
    const stockRows = aggregateByMappedMaterial(stockRowsRaw);

    const stockCols = [
      { key: "Material", label: "Material Code", fmt:(val,r)=>renderMappedMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap" },
      { key: "Material Description", label: "Material Description", fmt:(val,r)=>renderMappedMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap" },
      { key: "_plantList",           label: "Plant(s)" },
      { key: "Material Group Name",  label: "Material Group" },
      { key: "Unrestricted Stock",   label: "Unrestricted Qty",  fmt: fmtQty, rawKey: "Unrestricted Stock",              cls: "col-qty" },
      { key: "Stock in Quality Inspection", label: "QC Qty",     fmt: fmtQty, rawKey: "Stock in Quality Inspection",     cls: "col-qty" },
      { key: "Value of Unrestricted Stock", label: "Value (ETB)",fmt: fmtETB, rawKey: "Value of Unrestricted Stock",     cls: "col-val" },
    ];
    const stockExportCols = [
      { key: "Material",             label: "Material Code" },
      { key: "Material Description", label: "Material Description" },
      { key: "_plantList",           label: "Plant(s)" },
      { key: "Material Group Name",  label: "Material Group" },
      { key: "Unrestricted Stock",          label: "Unrestricted Qty" },
      { key: "Stock in Quality Inspection", label: "QC Qty" },
      { key: "Value of Unrestricted Stock", label: "Value (ETB)" },
    ];

    // ── Transit results (from separate transit file) ──
    const transitCols = [
      { key: "_st_material", label: "Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap" },
      { key: "_st_desc",     label: "Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap" },
      { key: "_st_purDoc",   label: "Purch. Doc." },
      { key: "_st_supPlant", label: "Supplying Plant" },
      { key: "_st_qty",      label: "Qty", cls: "col-qty" },
      { key: "_st_uom",      label: "UoM" },
    ];
    const transitExportCols = [
      { key: "_st_material", label: "Material Code" },
      { key: "_st_desc",     label: "Material Description" },
      { key: "_st_purDoc",   label: "Purch. Doc." },
      { key: "_st_supPlant", label: "Supplying Plant" },
      { key: "_st_qty",      label: "Qty" },
      { key: "_st_uom",      label: "UoM" },
    ];
    const transitRows = stockTransitRaw.filter(r => {
      const code = String(r["_st_material"] || "").toLowerCase();
      const desc = String(r["_st_desc"]     || "").toLowerCase();
      // FIX-PHANTOM-SEARCH: phantom rows (no PO & no supplying plant) must not appear
      // in global search — they are only visible in the transit detail section
      const isPhantom = !r._st_purDoc && !r._st_supPlant;
      return !isPhantom && (code.includes(q) || desc.includes(q));
    });

    // ── Also search "Stock in Transit" column in main data ──
    // FIX-PHANTOM-SEARCH: exclude phantom rows (no PO/supplying plant) from search results
    const inTransitMain = base.filter(r => {
      const code = String(r["Material"] || "").toLowerCase();
      const desc = String(r["Material Description"] || "").toLowerCase();
      const hasTransit = parseFloat(r["Stock in Transit"] || 0) > 0;
      const isPhantom  = r._phantomTransitQty > 0;
      return hasTransit && !isPhantom && (code.includes(q) || desc.includes(q));
    });

    let html = "";

    // In-Stock section
    html += `<div class="gsr-section-title">
      <span class="gsr-badge gsr-badge-stock">In Stock</span>
      ${stockRows.length} record${stockRows.length !== 1 ? "s" : ""} found
    </div>`;
    html += gsrBuildTable(stockRows, stockCols, "search_results_stock.csv", stockExportCols);

    // Transit from separate file (if uploaded)
    if (stockTransitRaw.length > 0) {
      html += `<div class="gsr-section-title" style="margin-top:1.2rem">
        <span class="gsr-badge gsr-badge-transit">In Transit (Transit File)</span>
        ${transitRows.length} record${transitRows.length !== 1 ? "s" : ""} found
      </div>`;
      html += gsrBuildTable(transitRows, transitCols, "search_results_transit.csv", transitExportCols);
    } else if (inTransitMain.length > 0) {
      // Fallback: show in-transit column from main data
      html += `<div class="gsr-section-title" style="margin-top:1.2rem">
        <span class="gsr-badge gsr-badge-transit">In Transit (from inventory data)</span>
        ${inTransitMain.length} record${inTransitMain.length !== 1 ? "s" : ""} found
      </div>`;
      const tCols = [
        { key: "Material", label: "Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap" },
        { key: "Material Description", label: "Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap" },
        { key: "Plant",                label: "Plant" },
        { key: "Stock in Transit",     label: "Transit Qty", cls: "col-qty" },
        { key: "Value of Stock in Transit", label: "Transit Value (ETB)", cls: "col-val" },
      ];
      const tExportCols = [
        { key: "Material",             label: "Material Code" },
        { key: "Material Description", label: "Material Description" },
        { key: "Plant",                label: "Plant" },
        { key: "Stock in Transit",            label: "Transit Qty" },
        { key: "Value of Stock in Transit",   label: "Transit Value (ETB)" },
      ];
      html += gsrBuildTable(inTransitMain, tCols, "search_results_transit_main.csv", tExportCols);
    }

    out.innerHTML = html;
    showResultsPanel();
  }

  function clearSearch() {
    document.getElementById("global-search-input").value = "";
    document.getElementById("global-search-results").innerHTML = "";
    hideResultsPanel();
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("global-search-btn").addEventListener("click", runSearch);
    document.getElementById("global-search-clear").addEventListener("click", clearSearch);
    document.getElementById("global-search-input").addEventListener("keydown", e => {
      if (e.key === "Enter") runSearch();
    });
    document.getElementById("global-search-results-close").addEventListener("click", hideResultsPanel);
  });
})();
