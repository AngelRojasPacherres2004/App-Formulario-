import crypto from "node:crypto";
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

function readEnv() {
  const values = {};
  for (const rawLine of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return values;
}

function sessionToken(user, secret) {
  const payload = Buffer.from(JSON.stringify({
    id: user.id,
    rol: "administrador",
    exp: Date.now() + 10 * 60 * 1000
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

const env = readEnv();
const secret = env.API_SESSION_SECRET || env.SUPABASE_SECRET_KEY;
if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY || !secret) throw new Error("Faltan credenciales.");
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const adminResult = await db.from("usuarios").select("id,rol").eq("rol", "administrador").limit(1).maybeSingle();
if (adminResult.error || !adminResult.data) throw new Error("No existe un administrador para probar la API.");
const token = sessionToken(adminResult.data, secret);
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const baseUrl = process.env.API_BASE_URL || "http://127.0.0.1:5180";

const catalogCheck = await db.from("capacitaciones").select("id,id_curso").order("orden", { ascending: true });
const progressCheck = await db.from("usuario_capacitaciones").select("id,capacitacion_id,estado").limit(1);
if (catalogCheck.error || progressCheck.error || (catalogCheck.data || []).length !== 7) {
  const anyUser = await db.from("usuarios").select("id").limit(1).maybeSingle();
  const response = await fetch(`${baseUrl}/api/users/${anyUser.data?.id || 1}/trainings`, { headers });
  const payload = await response.json().catch(() => ({}));
  const migrationMessagePresent = /01(?:2_capacitaciones_trabajadores|5_usuario_capacitacion_id|6_estado_capacitaciones)\.sql/i.test(payload.error || "");
  console.log(JSON.stringify({
    ok: response.status === 500 && migrationMessagePresent,
    migration_ready: false,
    api_status: response.status,
    migration_message_present: migrationMessagePresent
  }, null, 2));
  process.exitCode = 2;
} else {
  const lastUser = await db.from("usuarios").select("id").order("id", { ascending: false }).limit(1).maybeSingle();
  const testUserId = Number(lastUser.data?.id || 0) + 1;
  const testEmail = `__training_smoke_${Date.now()}`;
  const created = await db.from("usuarios").insert({
    id: testUserId,
    nombre: "Prueba Capacitaciones",
    email: testEmail,
    password_hash: "smoke-test-only",
    rol: "operante",
    activo: true
  });
  if (created.error) throw created.error;

  async function setCourse(courseId, estado) {
    const response = await fetch(`${baseUrl}/api/users/${testUserId}/trainings/${encodeURIComponent(courseId)}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ estado })
    });
    return { status: response.status, payload: await response.json().catch(() => ({})) };
  }

  let result;
  let resultExitCode = 0;
  try {
    const initial = await fetch(`${baseUrl}/api/users/${testUserId}/trainings`, { headers });
    const initialPayload = await initial.json();
    const cap2Blocked = await setCourse("CAP 2", "en_curso");
    const cap1Started = await setCourse("CAP 1", "en_curso");
    const cap1Done = await setCourse("CAP 1", "finalizado");
    const cap2Started = await setCourse("CAP 2", "en_curso");
    const cap1RollbackBlocked = await setCourse("CAP 1", "en_curso");
    const cap2Pending = await setCourse("CAP 2", "pendiente");
    const cap1Pending = await setCourse("CAP 1", "pendiente");
    const storedProgress = await db
      .from("usuario_capacitaciones")
      .select("capacitacion_id,curso_id,estado,completado")
      .eq("usuario_id", testUserId)
      .eq("curso_id", "CAP 1")
      .maybeSingle();
    const cap1Catalog = (catalogCheck.data || []).find((course) => course.id_curso === "CAP 1");
    const numericIdStored = !storedProgress.error &&
      Number(storedProgress.data?.capacitacion_id) === Number(cap1Catalog?.id);
    const numericIdVisible = Number(initialPayload.trainings?.[0]?.capacitacion_id) === Number(cap1Catalog?.id);

    const ok = initial.status === 200 &&
      initialPayload.trainings?.length === 7 &&
      initialPayload.trainings?.[0]?.disponible === true &&
      initialPayload.trainings?.slice(1).every((course) => course.disponible === false) &&
      cap2Blocked.status === 409 &&
      cap1Started.status === 200 &&
      cap1Done.status === 200 &&
      cap2Started.status === 200 &&
      cap1RollbackBlocked.status === 409 &&
      cap2Pending.status === 200 &&
      cap1Pending.status === 200 &&
      storedProgress.data?.estado === "pendiente" &&
      storedProgress.data?.completado === false &&
      numericIdStored &&
      numericIdVisible;

    result = {
      ok,
      migration_ready: true,
      courses: initialPayload.trainings?.length || 0,
      numeric_training_id_stored: numericIdStored,
      numeric_training_id_visible: numericIdVisible,
      forward_order_blocked: cap2Blocked.status === 409,
      in_progress_saved: cap1Started.status === 200 && cap2Started.status === 200,
      reverse_order_blocked: cap1RollbackBlocked.status === 409,
      cleanup_pending: true
    };
    if (!ok) resultExitCode = 3;
  } finally {
    const cleanup = await db.from("usuarios").delete().eq("id", testUserId);
    result = {
      ...result,
      cleanup_pending: Boolean(cleanup.error),
      ...(cleanup.error ? { cleanup_error: cleanup.error.message } : {})
    };
    if (cleanup.error && !resultExitCode) resultExitCode = 4;
  }
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = resultExitCode;
}
