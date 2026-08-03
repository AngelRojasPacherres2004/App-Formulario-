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
const assignmentResponse = await fetch(
  `${env.SUPABASE_URL}/rest/v1/asignacion_capacitaciones?select=id`,
  {
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      prefer: "count=exact",
      range: "0-0"
    }
  }
);
const assignmentRange = assignmentResponse.headers.get("content-range");
const assignmentCount = assignmentResponse.ok && assignmentRange
  ? Number(assignmentRange.split("/").at(-1))
  : null;
console.log(JSON.stringify({
  status: response.status,
  tables: Object.fromEntries(tables.map((table) => [
    table,
    definitions[table]?.properties ? Object.keys(definitions[table].properties) : null
  ])),
  assignment_count: assignmentCount,
  catalog_count: catalog.length,
  catalog
}, null, 2));
