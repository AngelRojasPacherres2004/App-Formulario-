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

const env = readEnv();
const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_PUBLISHABLE_KEY;
if (!env.SUPABASE_URL || !key) {
  throw new Error("Faltan SUPABASE_URL y una clave Supabase en .env");
}

const supabase = createClient(env.SUPABASE_URL, key, {
  auth: { persistSession: false, autoRefreshToken: false }
});

async function sueldoExists() {
  const result = await supabase.from("usuarios").select("id,sueldo").limit(1);
  return !result.error;
}

if (await sueldoExists()) {
  console.log(JSON.stringify({ applied: true, sueldo_exists: true }, null, 2));
  process.exit(0);
}

const sql = fs.readFileSync("sql/013_usuarios_sueldo.sql", "utf8");
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
  const result = await supabase.rpc(functionName, payload);
  if (!result.error && (await sueldoExists())) {
    console.log(JSON.stringify({ applied: true, sueldo_exists: true, rpc: functionName }, null, 2));
    process.exit(0);
  }
  errors.push({ function: functionName, error: result.error?.message || null });
}

console.log(
  JSON.stringify(
    {
      applied: false,
      sueldo_exists: false,
      reason: "Supabase JS no puede ejecutar ALTER TABLE si no existe una RPC SQL.",
      run_manually: "sql/013_usuarios_sueldo.sql",
      rpc_errors: errors
    },
    null,
    2
  )
);
process.exitCode = 1;
