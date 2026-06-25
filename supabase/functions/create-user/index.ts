// supabase/functions/create-user/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// Supabase Edge Function — creates a new auth user and assigns their role.
//
// WHY THIS EXISTS:
//   supabase.auth.admin.* requires the SERVICE ROLE key, which must NEVER be
//   in browser code. This function runs server-side with full service role access.
//
// DEPLOY:
//   supabase functions deploy create-user
//
// The function is protected — only signed-in admins can call it (we verify the
// caller's JWT and check their role in user_roles before creating anyone).
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// BUG 7 FIX: restrict CORS to your actual deployment origin.
// Wildcard (*) is forbidden by browsers for requests that carry credentials/auth headers,
// and it also exposes the endpoint to any origin. Replace the value below with your
// Cloudflare Pages domain (or comma-separate multiple allowed origins if needed).
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "https://your-app.pages.dev";

const corsHeaders = {
  "Access-Control-Allow-Origin":  ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ── 1. Verify the caller is a signed-in admin ──────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Service role client — has full DB access
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // Regular client to verify the caller's JWT
    const supabaseUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    // Get the caller's user from their JWT
    const { data: { user: caller }, error: callerErr } = await supabaseUser.auth.getUser();
    if (callerErr || !caller) {
      return new Response(JSON.stringify({ error: "Invalid or expired token" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check the caller's role in user_roles
    const { data: roleRow } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", caller.id)
      .maybeSingle();

    if (roleRow?.role !== "admin") {
      return new Response(JSON.stringify({ error: "Only admins can create users" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── 2. Parse and validate body ─────────────────────────────────────────
    // BUG 8 FIX: guard against non-POST requests that carry no body, and wrap
    // JSON.parse so malformed bodies return 400 instead of a 500 stack trace.
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let body: { email?: string; password?: string; role?: string };
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { email, password, role = "viewer" } = body;

    if (!email || !password) {
      return new Response(JSON.stringify({ error: "email and password are required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!["admin", "viewer"].includes(role)) {
      return new Response(JSON.stringify({ error: 'role must be "admin" or "viewer"' }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── 3. Create the auth user (skips confirmation email) ────────────────
    const { data, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (createErr) {
      return new Response(JSON.stringify({ error: createErr.message }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── 4. Assign their role ──────────────────────────────────────────────
    const { error: roleErr } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: data.user.id, role });

    if (roleErr) {
      // Attempt cleanup — delete the created user so we don't have orphans
      await supabaseAdmin.auth.admin.deleteUser(data.user.id);
      return new Response(JSON.stringify({ error: `Role assignment failed: ${roleErr.message}` }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── 5. Return success ─────────────────────────────────────────────────
    return new Response(
      JSON.stringify({ user: { id: data.user.id, email: data.user.email, role } }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
