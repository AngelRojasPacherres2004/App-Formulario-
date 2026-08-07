import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

function readEnv() {
  const envText = fs.readFileSync(".env", "utf8");
  const env = {};

  for (const rawLine of envText.split(/\r?\n/)) {
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
const url = env.SUPABASE_URL;
const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  throw new Error("Faltan SUPABASE_URL y una clave Supabase en .env");
}

const supabase = createClient(url, key, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

const usersToSeed = [
  {
    nombre: "Administrador Principal",
    email: "admin@empresa.com",
    password_hash: "Admin123!",
    rol: "administrador",
    activo: true,
    fecha_cumpleanos: null
  },
  {
    nombre: "Usuario Operante",
    email: "user@empresa.com",
    password_hash: "User123!",
    rol: "operante",
    activo: true,
    fecha_cumpleanos: null
  },
  {
    nombre: "Jefe de Equipo Demo",
    email: "equipo@empresa.com",
    password_hash: "Equipo123!",
    rol: "jefe de equipo",
    activo: true,
    fecha_cumpleanos: null
  },
  {
    nombre: "Jefe de Grupo Demo",
    email: "grupo@empresa.com",
    password_hash: "Grupo123!",
    rol: "jefe de grupo",
    activo: true,
    fecha_cumpleanos: null
  },
  {
    nombre: "Usuario Otros Demo",
    email: "otros@empresa.com",
    password_hash: "Otros123!",
    rol: "otros",
    activo: true,
    fecha_cumpleanos: null
  }
];

async function main() {
  const health = await supabase
    .from("usuarios")
    .select("id,email,rol,activo", { count: "exact" })
    .limit(3);

  if (health.error) throw health.error;

  const existing = await supabase
    .from("usuarios")
    .select("id,email")
    .in("email", usersToSeed.map((user) => user.email));

  if (existing.error) throw existing.error;

  const existingIdByEmail = new Map(existing.data.map((row) => [row.email, row.id]));
  const toUpdate = usersToSeed.filter((user) => existingIdByEmail.has(user.email));
  const toInsert = usersToSeed.filter((user) => !existingIdByEmail.has(user.email));

  for (const user of toUpdate) {
    const updated = await supabase
      .from("usuarios")
      .update(user)
      .eq("id", existingIdByEmail.get(user.email));
    if (updated.error) throw updated.error;
  }

  if (toInsert.length) {
    // La secuencia de public.usuarios se desincroniza cuando se importan filas
    // con id explicito (ver nextTableId en server.mjs), asi que se calcula el
    // siguiente id disponible en vez de dejar que Postgres lo autogenere.
    const maxIdResult = await supabase
      .from("usuarios")
      .select("id")
      .order("id", { ascending: false })
      .limit(1);
    if (maxIdResult.error) throw maxIdResult.error;
    let nextId = Number(maxIdResult.data?.[0]?.id || 0) + 1;

    const rowsWithIds = toInsert.map((user) => ({ ...user, id: nextId++ }));
    const inserted = await supabase.from("usuarios").insert(rowsWithIds);
    if (inserted.error) throw inserted.error;
  }

  const verify = await supabase
    .from("usuarios")
    .select("id,nombre,email,rol,activo")
    .in(
      "email",
      usersToSeed.map((user) => user.email)
    )
    .order("id", { ascending: true });

  if (verify.error) throw verify.error;

  const loginChecks = [];
  for (const user of usersToSeed) {
    const loginCheck = await supabase
      .from("usuarios")
      .select("id,email,rol,activo")
      .eq("email", user.email)
      .eq("password_hash", user.password_hash)
      .limit(1);

    if (loginCheck.error) throw loginCheck.error;

    loginChecks.push({
      email: user.email,
      login_match: Boolean(loginCheck.data?.length),
      rol: loginCheck.data?.[0]?.rol,
      activo: loginCheck.data?.[0]?.activo
    });
  }

  console.log(
    JSON.stringify(
      {
        connected: true,
        usuarios_count_before_seed: health.count,
        seeded: verify.data,
        login_checks: loginChecks,
        credentials: usersToSeed.map((user) => ({
          email: user.email,
          password: user.password_hash,
          rol: user.rol
        }))
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        connected: false,
        error: error.message || String(error)
      },
      null,
      2
    )
  );
  process.exit(1);
});
