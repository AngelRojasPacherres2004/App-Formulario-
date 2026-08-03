import fs from "node:fs";
import path from "node:path";
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

function normalizeTaskName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function expectedFlags(name) {
  const normalized = normalizeTaskName(name);
  return {
    requiere_marca: normalized === "etiquetado",
    requiere_lote: normalized === "etiquetado",
    requiere_numero_guia: new Set([
      "revision de guia devolucion",
      "revision de guia despacho"
    ]).has(normalized)
  };
}

const env = readEnv();
if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) throw new Error("Faltan credenciales de Supabase.");
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

let tableName = null;
let tasks = [];
for (const candidate of ["tarea", "tareas"]) {
  const result = await db
    .from(candidate)
    .select("id,nombre,requiere_marca,requiere_lote,requiere_numero_guia")
    .order("id", { ascending: true });
  if (!result.error) {
    tableName = candidate;
    tasks = result.data || [];
    break;
  }
}
if (!tableName) throw new Error("No se encontro una tabla de tareas con los tres indicadores requeridos.");

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDirectory = path.resolve("..", "doc_build");
fs.mkdirSync(backupDirectory, { recursive: true });
const backupFile = path.join(backupDirectory, `task_field_flags_backup_${timestamp}.json`);
fs.writeFileSync(backupFile, JSON.stringify({ created_at: new Date().toISOString(), table: tableName, tasks }, null, 2));

let changed = 0;
for (const task of tasks) {
  const expected = expectedFlags(task.nombre);
  const isDifferent = Object.entries(expected).some(([key, value]) => Boolean(task[key]) !== value);
  if (!isDifferent) continue;
  const result = await db.from(tableName).update(expected).eq("id", task.id);
  if (result.error) throw result.error;
  changed++;
}

const verification = await db
  .from(tableName)
  .select("id,nombre,requiere_marca,requiere_lote,requiere_numero_guia")
  .order("id", { ascending: true });
if (verification.error) throw verification.error;
const mismatches = (verification.data || []).filter((task) => {
  const expected = expectedFlags(task.nombre);
  return Object.entries(expected).some(([key, value]) => Boolean(task[key]) !== value);
});

console.log(JSON.stringify({
  ok: mismatches.length === 0,
  table: tableName,
  tasks_checked: tasks.length,
  tasks_changed: changed,
  verification_mismatches: mismatches.length,
  backup_file: backupFile
}, null, 2));
if (mismatches.length) process.exitCode = 2;
