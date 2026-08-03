import fs from "node:fs";

const env = Object.fromEntries(
  fs.readFileSync(".env", "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "")];
    })
);

const response = await fetch(`${env.SUPABASE_URL}/rest/v1/`, {
  headers: {
    apikey: env.SUPABASE_SECRET_KEY,
    authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
    accept: "application/openapi+json"
  }
});
const spec = await response.json();
const definitions = spec.definitions || spec.components?.schemas || {};
const tables = ["capacitaciones", "usuario_capacitaciones", "asignacion_capacitaciones"];
const catalogResponse = await fetch(
  `${env.SUPABASE_URL}/rest/v1/capacitaciones?select=id,curso,competencia,numero_horas,inversion,descripcion,activo&order=id.asc`,
  {
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`
    }
  }
);
const catalog = catalogResponse.ok ? await catalogResponse.json() : [];
async function tableCount(table) {
  const tableResponse = await fetch(
    `${env.SUPABASE_URL}/rest/v1/${table}?select=id`,
    {
      headers: {
        apikey: env.SUPABASE_SECRET_KEY,
        authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
        prefer: "count=exact",
        range: "0-0"
      }
    }
  );
  const range = tableResponse.headers.get("content-range");
  return tableResponse.ok && range ? Number(range.split("/").at(-1)) : null;
}

const [assignmentCount, progressCount] = await Promise.all([
  tableCount("asignacion_capacitaciones"),
  tableCount("usuario_capacitaciones")
]);
console.log(JSON.stringify({
  status: response.status,
  tables: Object.fromEntries(tables.map((table) => [
    table,
    definitions[table]?.properties ? Object.keys(definitions[table].properties) : null
  ])),
  assignment_count: assignmentCount,
  progress_count: progressCount,
  catalog_count: catalog.length,
  catalog
}, null, 2));
