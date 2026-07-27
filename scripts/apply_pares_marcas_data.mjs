import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

function readEnv() {
  const env = {};
  for (const rawLine of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const name = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[name] = value;
  }
  return env;
}

function isPairUnit(value) {
  const words = String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  return words.includes("par") || words.includes("pares");
}

const env = readEnv();
if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
  throw new Error("Faltan SUPABASE_URL y SUPABASE_SECRET_KEY en .env");
}

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const current = await supabase
  .from("tarea")
  .select("id,nombre,unidad_medida,requiere_marca")
  .order("id", { ascending: true });
if (current.error) throw current.error;

const pairTasks = (current.data || []).filter((task) => isPairUnit(task.unidad_medida));
const pendingIds = pairTasks.filter((task) => task.requiere_marca !== true).map((task) => task.id);

if (pendingIds.length) {
  const updated = await supabase
    .from("tarea")
    .update({ requiere_marca: true })
    .in("id", pendingIds)
    .select("id");
  if (updated.error) throw updated.error;
}

const verification = await supabase
  .from("tarea")
  .select("id,nombre,unidad_medida,requiere_marca")
  .in("id", pairTasks.map((task) => task.id));
if (verification.error) throw verification.error;

const invalid = (verification.data || []).filter(
  (task) => isPairUnit(task.unidad_medida) && task.requiere_marca !== true
);
if (invalid.length) throw new Error("Algunas tareas de pares no quedaron habilitadas para marcas.");

console.log(
  JSON.stringify(
    {
      pair_tasks: pairTasks.length,
      updated: pendingIds.length,
      tasks: (verification.data || []).map(({ id, nombre, unidad_medida, requiere_marca }) => ({
        id,
        nombre,
        unidad_medida,
        requiere_marca
      }))
    },
    null,
    2
  )
);
