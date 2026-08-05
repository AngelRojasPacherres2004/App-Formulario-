import test from "node:test";
import assert from "node:assert/strict";
import {
  activityShiftDue,
  buildActivityReport,
  normalizeActivityReportConfig,
  readActivityCompliance
} from "../services/activity_report.mjs";

class Query {
  constructor(state, table) { this.state = state; this.table = table; this.filters = []; }
  select() { return this; }
  eq(field, value) { this.filters.push((row) => String(row[field]) === String(value)); return this; }
  order() { return this; }
  then(resolve, reject) {
    const rows = (this.state[this.table] || []).filter((row) => this.filters.every((filter) => filter(row)));
    return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
  }
}

function database(state) {
  return { from(table) { return new Query(state, table); } };
}

test("calcula independientemente los dos horarios automaticos", () => {
  const config = normalizeActivityReportConfig({
    id: 1, activo: true, destinatarios: ["admin@example.com"],
    hora_manana: "12:00", hora_tarde: "18:00", zona_horaria: "America/Lima"
  });
  assert.equal(activityShiftDue(config, "manana", new Date("2026-08-04T17:00:00Z")).due, true);
  assert.equal(activityShiftDue(config, "tarde", new Date("2026-08-04T17:00:00Z")).due, false);
  assert.equal(activityShiftDue(config, "tarde", new Date("2026-08-04T23:00:00Z")).due, true);
});

test("clasifica operantes activos con y sin registro en cada turno", async () => {
  const db = database({
    usuarios: [
      { id: 1, nombre: "Ana", email: "ana@example.com", rol: "operante", activo: true },
      { id: 2, nombre: "Luis", email: "luis@example.com", rol: "operante", activo: true },
      { id: 3, nombre: "Inactivo", email: "x@example.com", rol: "operante", activo: false },
      { id: 4, nombre: "Jefe", email: "j@example.com", rol: "jefe de equipo", activo: true }
    ],
    registros_tareas: [
      { id: 10, usuario_id: 1, fecha_registro: "2026-08-04", created_at: "2026-08-04T15:00:00Z" },
      { id: 11, usuario_id: 2, fecha_registro: "2026-08-04", created_at: "2026-08-04T20:00:00Z" }
    ]
  });
  const config = normalizeActivityReportConfig({ destinatarios: [], hora_manana: "12:00", hora_tarde: "18:00" });
  const morning = await readActivityCompliance(db, "2026-08-04", "manana", config);
  const afternoon = await readActivityCompliance(db, "2026-08-04", "tarde", config);
  assert.deepEqual(morning.map((row) => [row.nombre, row.cumplio]), [["Ana", true], ["Luis", false]]);
  assert.deepEqual(afternoon.map((row) => [row.nombre, row.cumplio]), [["Ana", false], ["Luis", true]]);
});

test("genera el reporte con totales de cumplimiento", () => {
  const report = buildActivityReport({
    reportDate: "2026-08-04", shift: "manana",
    rows: [
      { nombre: "Ana", email: "ana@example.com", cumplio: true, registros: 2 },
      { nombre: "Luis", email: "luis@example.com", cumplio: false, registros: 0 }
    ]
  });
  assert.equal(report.completed, 1);
  assert.equal(report.missing, 1);
  assert.match(report.html, /Sin registro/);
  assert.match(report.csv, /Cumplio/);
});
