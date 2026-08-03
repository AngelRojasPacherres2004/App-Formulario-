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

const env = readEnv();
if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) throw new Error("Faltan credenciales de Supabase.");
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

async function migrationReady() {
  const [courses, progress] = await Promise.all([
    db.from("capacitaciones").select("id_curso,orden").order("orden", { ascending: true }),
    db.from("usuario_capacitaciones").select("id").limit(1)
  ]);
  return !courses.error && !progress.error && (courses.data || []).length === 7;
}

if (await migrationReady()) {
  console.log(JSON.stringify({ ok: true, already_applied: true, courses: 7 }, null, 2));
  process.exit(0);
}

const sql = fs.readFileSync("sql/012_capacitaciones_trabajadores.sql", "utf8");
const attempts = [
  ["exec_sql", { query: sql }],
  ["exec_sql", { sql }],
  ["run_sql", { query: sql }],
  ["run_sql", { sql }],
  ["execute_sql", { query: sql }],
  ["execute_sql", { sql }]
];

const errors = [];
for (const [functionName, payload] of attempts) {
  const result = await db.rpc(functionName, payload);
  if (!result.error && (await migrationReady())) {
    console.log(JSON.stringify({ ok: true, applied_with_rpc: functionName, courses: 7 }, null, 2));
    process.exit(0);
  }
  errors.push({ function: functionName, error: result.error?.message || null });
}

console.log(JSON.stringify({
  ok: false,
  reason: "No hay una RPC SQL habilitada para crear las tablas.",
  run_manually: "sql/012_capacitaciones_trabajadores.sql",
  rpc_errors: errors
}, null, 2));
process.exitCode = 2;
