// =============================================================================
// supabase-client.js
// Load this BEFORE script.js, right after filters.js.
// Replaces the "hold parsed Excel in a JS variable" model with
// "push to Supabase, then every viewer reads from Supabase."
// =============================================================================

const SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";   // ← replace
const SUPABASE_ANON_KEY = "YOUR-ANON-KEY";                  // ← replace

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Map your existing Excel header names -> snake_case DB columns.
// Extend this if your sheet has more columns than script.js currently reads.
const INVENTORY_COLUMN_MAP = {
  "Plant": "plant",
  "Plant Name": "plant_name",
  "Material": "material",
  "Material Description": "material_description",
  "Material Group Name": "material_group_name",
  "Storage Location": "storage_location",
  "Description of Storage Location": "storage_location_desc",
  "Special Stock Type": "special_stock_type",
  "Special Stock Type Description": "special_stock_type_desc",
  "Batch": "batch",
  "Inventory Valuation Type": "inventory_valuation_type",
  "Unrestricted Stock": "unrestricted_stock",
  "Blocked Stock": "blocked_stock",
  "Stock in Quality Inspection": "stock_in_quality_inspection",
  "Stock in Transit": "stock_in_transit",
  "Total Qty": "total_qty",
  "Value of Unrestricted Stock": "value_of_unrestricted_stock",
  "Value of Stock in Quality Inspection": "value_of_stock_in_quality_inspection",
  "Value of Stock in Transit": "value_of_stock_in_transit",
  "Total Value": "total_value",
  "Shelf Life Expiration Date": "shelf_life_expiration_date",
};

/**
 * Converts one parsed Excel row (object keyed by original header names,
 * exactly what XLSX.utils.sheet_to_json gives you) into a row matching
 * the inventory_rows table schema.
 */
function mapInventoryRow(excelRow) {
  const out = {};
  for (const [excelHeader, dbCol] of Object.entries(INVENTORY_COLUMN_MAP)) {
    let val = excelRow[excelHeader];
    if (val === undefined || val === "") val = null;
    // Dates from XLSX (cellDates:true) come through as JS Date objects
    if (val instanceof Date) {
      val = val.toISOString().slice(0, 10); // YYYY-MM-DD for a `date` column
    }
    out[dbCol] = val;
  }
  return out;
}

/**
 * Splits an array into chunks — Supabase/PostgREST inserts get slow/unreliable
 * much past a few hundred rows per request.
 */
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

/**
 * Replaces the entire inventory_rows table with a new snapshot.
 * Call this from your existing fileInput "change" handler, after
 * XLSX.read() has produced `rawRows` (array of objects keyed by header).
 *
 * @param {Array<Object>} rawRows - rows exactly as sheet_to_json returns them
 * @param {(msg:string)=>void} onProgress - optional UI status callback
 */
async function replaceInventorySnapshot(rawRows, onProgress = () => {}) {
  onProgress(`Preparing ${rawRows.length.toLocaleString()} rows…`);
  const mapped = rawRows.map(mapInventoryRow);

  // 1. Wipe the old snapshot. `neq` on the PK with an impossible value is the
  //    standard PostgREST "delete everything" pattern since delete() requires a filter.
  onProgress("Clearing previous snapshot…");
  const { error: delErr } = await sb.from("inventory_rows").delete().neq("id", -1);
  if (delErr) throw new Error("Failed to clear old data: " + delErr.message);

  // 2. Insert new rows in chunks
  const chunks = chunkArray(mapped, 500);
  let inserted = 0;
  for (const chunk of chunks) {
    const { error } = await sb.from("inventory_rows").insert(chunk);
    if (error) throw new Error("Failed to insert rows: " + error.message);
    inserted += chunk.length;
    onProgress(`Uploaded ${inserted.toLocaleString()} / ${mapped.length.toLocaleString()} rows…`);
  }

  // 3. Update metadata so viewers can see "last updated"
  await sb.from("upload_meta").upsert({
    dataset: "inventory",
    uploaded_at: new Date().toISOString(),
    row_count: mapped.length,
  });

  onProgress(`Done — ${mapped.length.toLocaleString()} rows live.`);
  return mapped.length;
}

/**
 * Fetches the "last updated" banner info for a dataset.
 */
async function getUploadMeta(dataset) {
  const { data, error } = await sb
    .from("upload_meta")
    .select("uploaded_at, row_count, uploaded_by")
    .eq("dataset", dataset)
    .maybeSingle();
  if (error) throw error;
  return data; // null if nothing uploaded yet
}
