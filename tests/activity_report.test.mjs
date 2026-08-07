import test from "node:test";
import assert from "node:assert/strict";
import {
  activityShiftDue,
  buildActivityReport,
  normalizeActivityReportConfig,
  readActivityCompliance,
  readActivityReportConfig,
  readActivityReportConfigs,
  runDueActivityReports,
  sendActivityReport
} from "../services/activity_report.mjs";

class FakeQuery {
  constructor(database, table) {
    this.database = database;
    this.table = table;
    this.action = null;
    this.payload = null;
    this.filters = [];
    this.maxRows = null;
    this.singleRow = false;
  }

  select() {
    if (!this.action) this.action = "select";
    return this;
  }

  insert(payload) {
    this.action = "insert";
    this.payload = payload;
    return this;
  }

  update(payload) {
    this.action = "update";
    this.payload = payload;
    return this;
  }

  eq(field, value) {
    this.filters.push((row) => String(row[field]) === String(value));
    return this;
  }

  in(field, values) {
    this.filters.push((row) => values.map(String).includes(String(row[field])));
    return this;
  }

  is(field, value) {
    this.filters.push((row) => value === null ? row[field] == null : row[field] === value);
    return this;
  }

  order() {
    return this;
  }

  limit(value) {
    this.maxRows = Number(value);
    return this;
  }

  single() {
    this.singleRow = true;
    return this.execute();
  }

  maybeSingle() {
    this.singleRow = true;
    return this.execute();
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }

  async execute() {
    const state = this.database.state;
    const tableRows = state[this.table] || [];

    if (this.action === "insert") {
      const inserted = {
        ...this.payload,
        id: this.payload.id || state.nextLogId++,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      tableRows.push(inserted);
      return { data: inserted, error: null };
    }

    let rows = tableRows.filter((row) => this.filters.every((filter) => filter(row)));
    if (this.action === "update") {
      rows.forEach((row) => Object.assign(row, this.payload, { updated_at: new Date().toISOString() }));
      return { data: this.singleRow ? rows[0] || null : rows, error: null };
    }

    if (Number.isInteger(this.maxRows)) rows = rows.slice(0, this.maxRows);
    return { data: this.singleRow ? rows[0] || null : rows, error: null };
  }
}

function activityConfig(id, changes = {}) {
  return {
    id,
    nombre: `Programacion ${id}`,
    activo: true,
    destinatarios: [`reporte${id}@example.com`],
    hora_manana: "12:00",
    hora_tarde: "18:00",
    zona_horaria: "America/Lima",
    asunto: "Reporte de registros de actividades",
    incluir_todos_activos: true,
    eliminado_en: null,
    ultimo_envio_manana_fecha: null,
    ultimo_envio_tarde_fecha: null,
    ...changes
  };
}

function fakeDatabase(overrides = {}) {
  const defaultConfigs = [activityConfig(1, { nombre: "Reporte principal" })];
  const state = {
    configuracion_reporte_actividad: defaultConfigs,
    configuracion_reporte_actividad_usuarios: [],
    usuarios: [
      { id: 1, nombre: "Ana", email: "ana@example.com", rol: "operante", activo: true }
    ],
    registros_tareas: [],
    reporte_actividad_envios: [],
    nextLogId: 1,
    rpcClaim: { envio_id: 50, reclamado: true, motivo: "nuevo", intento: 1 },
    rpcClaimsByConfig: {},
    rpcCalls: [],
    ...overrides
  };
  const database = {
    state,
    from(table) {
      return new FakeQuery(database, table);
    },
    async rpc(name, params) {
      assert.equal(name, "reclamar_reporte_actividad");
      state.rpcCalls.push({ name, params });
      const configId = Number(params.p_configuracion_id);
      const config = state.configuracion_reporte_actividad.find((item) => Number(item.id) === configId);
      const key = `${configId}:${params.p_turno}`;
      const claim = state.rpcClaimsByConfig[key] || {
        ...state.rpcClaim,
        envio_id: Number(state.rpcClaim.envio_id || 50) + configId - 1
      };
      if (claim.reclamado && !state.reporte_actividad_envios.some((row) => row.id === claim.envio_id)) {
        state.reporte_actividad_envios.push({
          id: claim.envio_id,
          configuracion_id: configId,
          programacion_nombre: config?.nombre || "",
          fecha_reporte: params.p_fecha_reporte,
          turno: params.p_turno,
          tipo_envio: "automatico",
          estado: "procesando",
          destinatarios: params.p_destinatarios,
          intentos: claim.intento
        });
      }
      return { data: [claim], error: null };
    }
  };
  return database;
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
  const db = fakeDatabase({
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

test("respeta la seleccion de operantes cuando incluir_todos_activos es false", async () => {
  const db = fakeDatabase({
    usuarios: [
      { id: 1, nombre: "Ana", email: "ana@example.com", rol: "operante", activo: true },
      { id: 2, nombre: "Luis", email: "luis@example.com", rol: "operante", activo: true }
    ],
    registros_tareas: [
      { id: 10, usuario_id: 1, fecha_registro: "2026-08-04", created_at: "2026-08-04T15:00:00Z" }
    ]
  });
  const config = normalizeActivityReportConfig(
    { destinatarios: [], hora_manana: "12:00", hora_tarde: "18:00", incluir_todos_activos: false },
    [2]
  );
  const morning = await readActivityCompliance(db, "2026-08-04", "manana", config);
  assert.deepEqual(morning.map((row) => row.nombre), ["Luis"]);
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

test("carga multiples programaciones de actividades con sus operantes de la tabla puente", async () => {
  const db = fakeDatabase({
    configuracion_reporte_actividad: [
      activityConfig(1, { nombre: "Todos", incluir_todos_activos: true }),
      activityConfig(2, { nombre: "Equipo elegido", incluir_todos_activos: false }),
      activityConfig(3, { nombre: "Archivada", eliminado_en: "2026-08-04T15:00:00Z" })
    ],
    configuracion_reporte_actividad_usuarios: [
      { configuracion_id: 2, usuario_id: 9 },
      { configuracion_id: 2, usuario_id: 12 },
      { configuracion_id: 2, usuario_id: 9 }
    ]
  });

  const configs = await readActivityReportConfigs(db);
  assert.equal(configs.length, 2);
  assert.deepEqual(configs[0].usuario_ids, []);
  assert.deepEqual(configs[1].usuario_ids, [9, 12]);
  assert.equal(configs[1].nombre, "Equipo elegido");

  const selected = await readActivityReportConfig(db, 2);
  assert.equal(selected.incluir_todos_activos, false);
  assert.deepEqual(selected.usuario_ids, [9, 12]);
  await assert.rejects(
    readActivityReportConfig(db, 3),
    (error) => error.code === "ACTIVITY_REPORT_CONFIG_NOT_FOUND"
  );
});

test("envia manualmente el reporte de una programacion y conserva su nombre en el historial", async () => {
  const db = fakeDatabase();
  const sentMessages = [];
  const config = normalizeActivityReportConfig(db.state.configuracion_reporte_actividad[0]);
  const result = await sendActivityReport({
    db,
    envValues: { GMAIL_USER: "calzado661@gmail.com" },
    config,
    reportDate: "2026-08-04",
    shift: "manana",
    type: "manual",
    mailTransport: {
      async sendMail(message) {
        sentMessages.push(message);
        return { messageId: "mensaje-prueba" };
      }
    }
  });

  assert.equal(result.status, "sent");
  assert.equal(result.configId, 1);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].bcc[0], "reporte1@example.com");
  assert.equal(db.state.reporte_actividad_envios[0].estado, "enviado");
  assert.equal(db.state.reporte_actividad_envios[0].programacion_nombre, "Reporte principal");
  assert.equal(db.state.reporte_actividad_envios[0].configuracion_id, 1);
});

test("el envio automatico reclama por programacion y turno usando el id de configuracion", async () => {
  const db = fakeDatabase();
  const result = await runDueActivityReports({
    db,
    envValues: { GMAIL_USER: "calzado661@gmail.com", GMAIL_APP_PASSWORD: "abcdefghijklmnop" },
    now: new Date("2026-08-04T18:00:00Z"),
    mailTransportFactory: () => ({ async sendMail() { return { messageId: "auto" }; } })
  });

  assert.equal(result.sent, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(db.state.rpcCalls.map((call) => call.params.p_configuracion_id), [1]);
  assert.deepEqual(db.state.rpcCalls.map((call) => call.params.p_turno), ["manana"]);
});

test("el lote de envios automaticos de actividades respeta el limite por tick", async () => {
  const db = fakeDatabase({
    configuracion_reporte_actividad: [1, 2].map((id) => activityConfig(id))
  });
  let mailCalls = 0;
  const result = await runDueActivityReports({
    db,
    envValues: { GMAIL_USER: "calzado661@gmail.com", GMAIL_APP_PASSWORD: "abcdefghijklmnop" },
    now: new Date("2026-08-04T18:00:00Z"),
    mailTransportFactory: () => ({
      async sendMail() {
        mailCalls += 1;
        return { messageId: `mensaje-${mailCalls}` };
      }
    })
  });

  assert.equal(result.due, 2);
  assert.equal(result.processed, 2);
  assert.equal(result.sent, 2);
  assert.equal(mailCalls, 2);
});
