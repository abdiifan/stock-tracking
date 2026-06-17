// =============================================================================
// viewer-data.js
// Functions for VIEWERS (people who didn't upload, just want to see data fast).
// These call the Postgres RPC functions from 01_schema.sql so aggregation
// happens server-side — the browser never sums 10-50k rows itself.
// Load after 02_supabase-client.js.
// =============================================================================

/**
 * Dashboard KPI row. Replaces any client-side reduce() over rawDf.
 */
async function fetchDashboardKpis() {
  const { data, error } = await sb.rpc("get_dashboard_kpis");
  if (error) throw error;
  return data?.[0] ?? null;
}

/**
 * Plant-level totals for the "Inventory Value & Quantity by Plant" chart.
 */
async function fetchPlantSummary() {
  const { data, error } = await sb.rpc("get_plant_summary");
  if (error) throw error;
  return data ?? [];
}

/**
 * Material-group totals for the bar chart.
 */
async function fetchMaterialGroupSummary() {
  const { data, error } = await sb.rpc("get_material_group_summary");
  if (error) throw error;
  return data ?? [];
}

/**
 * Expiry risk grouped by plant, default 6-month horizon (matches
 * existing "Near-Expiry Risk by Plant" chart language in index.html).
 */
async function fetchExpiryRiskByPlant(monthsAhead = 6) {
  const { data, error } = await sb.rpc("get_expiry_risk_by_plant", { months_ahead: monthsAhead });
  if (error) throw error;
  return data ?? [];
}

/**
 * Dropdown options for plant / material group / valuation type filters —
 * one round trip instead of computing distinct values from raw rows in JS.
 */
async function fetchFilterOptions() {
  const { data, error } = await sb.rpc("get_filter_options");
  if (error) throw error;
  return data?.[0] ?? { plants: [], material_groups: [], valuation_types: [] };
}

/**
 * Paginated, filtered detail rows — for tables like the Shelf Life Lookup
 * or Concentration detail tables. Never fetches more than `pageSize` rows.
 *
 * @param {Object} filters - { plant, materialGroup, valuationType, material }
 * @param {number} page - 0-based page index
 * @param {number} pageSize
 */
async function fetchInventoryPage(filters = {}, page = 0, pageSize = 100) {
  let query = sb.from("clean_inventory").select("*", { count: "exact" });

  if (filters.plant)         query = query.eq("plant", filters.plant);
  if (filters.materialGroup) query = query.eq("material_group_name", filters.materialGroup);
  if (filters.valuationType) query = query.eq("inventory_valuation_type", filters.valuationType);
  if (filters.material)      query = query.eq("material", filters.material);

  const from = page * pageSize;
  const to = from + pageSize - 1;
  const { data, error, count } = await query.range(from, to);
  if (error) throw error;
  return { rows: data ?? [], totalCount: count ?? 0 };
}

/**
 * Renders the "Data last updated" banner that replaces the upload control
 * for read-only viewers. Call once on page load.
 */
async function renderLastUpdatedBanner(targetElId = "fileStatus") {
  const el = document.getElementById(targetElId);
  if (!el) return;
  try {
    const meta = await getUploadMeta("inventory");
    if (!meta) {
      el.textContent = "No data uploaded yet.";
      return;
    }
    const when = new Date(meta.uploaded_at).toLocaleString();
    el.textContent = `Data last updated: ${when} (${meta.row_count.toLocaleString()} rows)`;
  } catch (e) {
    el.textContent = "Could not load update status.";
  }
}

// -----------------------------------------------------------------------
// Example wiring for the Dashboard page — adapt names to your actual
// render functions in script.js (e.g. renderDashboard()).
// -----------------------------------------------------------------------
async function loadDashboardFromSupabase() {
  const [kpis, plantSummary, mgSummary, expiryRisk] = await Promise.all([
    fetchDashboardKpis(),
    fetchPlantSummary(),
    fetchMaterialGroupSummary(),
    fetchExpiryRiskByPlant(6),
  ]);

  // Wire these into your existing Plotly render calls, e.g.:
  // renderPlantChart(plantSummary);
  // renderMaterialGroupChart(mgSummary);
  // renderExpiryRiskChart(expiryRisk);
  // renderKpiCards(kpis);

  return { kpis, plantSummary, mgSummary, expiryRisk };
}
