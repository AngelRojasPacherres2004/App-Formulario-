import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAttendanceReport,
  gmailConfiguration,
  localDateTimeParts,
  normalizeRecipients,
  normalizeReportSubject,
  normalizeReportTime,
  readActiveAttendanceWorkers,
  readAttendanceReportConfig,
  readAttendanceReportConfigs,
  readPresentAttendances,
  reportDue,
  runDueAttendanceReport,
  runDueAttendanceReports,
  sendAttendanceReport
} from "../services/attendance_report.mjs";

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

  ilike(field, value) {
    this.filters.push((row) => String(row[field] || "").toLowerCase() === String(value).toLowerCase());
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
      const confirmationRow = rows[0];
      const confirmationFails = state.failSentConfirmation === true ||
        state.failSentConfirmationIds?.has(Number(confirmationRow?.configuracion_id));
      if (confirmationFails && this.table === "reporte_asistencia_envios" && this.payload.estado === "enviado") {
        return { data: null, error: { code: "TEST_DB_FAILURE", message: "fallo al confirmar" } };
      }
      rows.forEach((row) => Object.assign(row, this.payload, { updated_at: new Date().toISOString() }));
      return { data: this.singleRow ? rows[0] || null : rows, error: null };
    }

    if (Number.isInteger(this.maxRows)) rows = rows.slice(0, this.maxRows);
    return { data: this.singleRow ? rows[0] || null : rows, error: null };
  }
}

function reportConfig(id, changes = {}) {
  return {
    id,
    nombre: `Programacion ${id}`,
    activo: true,
    destinatarios: [`reporte${id}@example.com`],
    hora_envio: "00:00",
    zona_horaria: "America/Lima",
    asunto: "Reporte diario de asistencia",
    incluir_todos_activos: true,
    eliminado_en: null,
    ultimo_envio_fecha: null,
    ultimo_envio_en: null,
    ...changes
  };
}

function fakeDatabase(overrides = {}) {
  const defaultConfigs = [reportConfig(1, {
    nombre: "Reporte principal",
    destinatarios: ["reporte1@example.com", "reporte2@example.com"]
  })];
  const state = {
    configuracion_reporte_asistencia: defaultConfigs,
    configuracion_reporte_asistencia_usuarios: [],
    asistencias: [{
      id: 1,
      usuario_id: 8,
      fecha: "2026-08-04",
      estado: "Presente",
      created_at: "2026-08-04T14:30:00Z"
    }],
    usuarios: [{ id: 8, nombre: "Ana Perez", email: "ana@example.com", rol: "operante", activo: true }],
    reporte_asistencia_envios: [],
    nextLogId: 1,
    failSentConfirmation: false,
    failSentConfirmationIds: new Set(),
    rpcClaim: { envio_id: 50, reclamado: true, motivo: "nuevo", intento: 1 },
    rpcClaimsByConfig: {},
    rpcCalls: [],
    ...overrides
  };
  state.config = state.configuracion_reporte_asistencia[0];
  const database = {
    state,
    from(table) {
      return new FakeQuery(database, table);
    },
    async rpc(name, params) {
      assert.equal(name, "reclamar_reporte_asistencia");
      state.rpcCalls.push({ name, params });
      const configId = Number(params.p_configuracion_id);
      const config = state.configuracion_reporte_asistencia.find((item) => Number(item.id) === configId);
      const claim = state.rpcClaimsByConfig[configId] || {
        ...state.rpcClaim,
        envio_id: Number(state.rpcClaim.envio_id || 50) + configId - 1
      };
      if (claim.reclamado && !state.reporte_asistencia_envios.some((row) => row.id === claim.envio_id)) {
        state.reporte_asistencia_envios.push({
          id: claim.envio_id,
          configuracion_id: configId,
          programacion_nombre: config?.nombre || "",
          fecha_reporte: params.p_fecha_reporte,
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

test("normaliza, separa y elimina destinatarios duplicados", () => {
  assert.deepEqual(
    normalizeRecipients(" UNO@Example.com, dos@example.com\nuno@example.com "),
    ["uno@example.com", "dos@example.com"]
  );
  assert.throws(() => normalizeRecipients("correo-invalido"), /no es valido/);
  assert.throws(
    () => normalizeRecipients(Array.from({ length: 21 }, (_, index) => `persona${index}@example.com`)),
    /hasta 20/
  );
});

test("valida hora y asunto de la configuracion", () => {
  assert.equal(normalizeReportTime("08:05:00"), "08:05");
  assert.equal(normalizeReportSubject("  Resumen de asistencia  "), "Resumen de asistencia");
  assert.throws(() => normalizeReportTime("25:00"), /hora valida/);
  assert.throws(() => normalizeReportSubject("x".repeat(161)), /160/);
});

test("calcula la fecha y la hora usando America/Lima", () => {
  assert.deepEqual(
    localDateTimeParts(new Date("2026-08-04T23:07:00Z"), "America/Lima"),
    { date: "2026-08-04", time: "18:07", minutes: 1087 }
  );
});

test("el reporte solo vence despues de la hora y una vez por dia", () => {
  const config = {
    activo: true,
    destinatarios: ["destino@example.com"],
    hora_envio: "18:00",
    zona_horaria: "America/Lima",
    ultimo_envio_fecha: null
  };

  assert.deepEqual(
    reportDue(config, new Date("2026-08-04T22:59:00Z")),
    { due: false, reason: "before_schedule", reportDate: "2026-08-04" }
  );
  assert.deepEqual(
    reportDue(config, new Date("2026-08-04T23:00:00Z")),
    { due: true, reason: "ready", reportDate: "2026-08-04" }
  );
  assert.deepEqual(
    reportDue({ ...config, ultimo_envio_fecha: "2026-08-04" }, new Date("2026-08-04T23:00:00Z")),
    { due: false, reason: "already_sent", reportDate: "2026-08-04" }
  );
});

test("genera correo HTML, texto y CSV escapando contenido peligroso", () => {
  const report = buildAttendanceReport({
    reportDate: "2026-08-04",
    attendees: [{
      nombre: "<Ana & Luis>",
      email: "ana@example.com",
      rol: "=ADMIN",
      marcado_en: "2026-08-04T14:30:00Z"
    }]
  });

  assert.match(report.html, /&lt;Ana &amp; Luis&gt;/);
  assert.doesNotMatch(report.html, /<Ana & Luis>/);
  assert.match(report.text, /Total de asistentes: 1/);
  assert.match(report.csv, /"'=ADMIN"/);
  assert.ok(report.csv.startsWith("\uFEFF"));
});

test("la configuracion Gmail usa la cuenta indicada y limpia espacios del app password", () => {
  assert.deepEqual(
    gmailConfiguration({ GMAIL_USER: "CALZADO661@gmail.com", GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop" }),
    { sender: "calzado661@gmail.com", appPassword: "abcdefghijklmnop", configured: true }
  );
});

test("envia con copia oculta, adjunta CSV y confirma el historial", async () => {
  const database = fakeDatabase();
  const sentMessages = [];
  const report = await sendAttendanceReport({
    db: database,
    envValues: { GMAIL_USER: "calzado661@gmail.com" },
    config: database.state.config,
    reportDate: "2026-08-04",
    type: "manual",
    mailTransport: {
      async sendMail(message) {
        sentMessages.push(message);
        return { messageId: "mensaje-prueba" };
      }
    }
  });

  assert.equal(report.status, "sent");
  assert.equal(report.attendeesCount, 1);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].to, "calzado661@gmail.com");
  assert.deepEqual(sentMessages[0].bcc, database.state.config.destinatarios);
  assert.equal(sentMessages[0].attachments[0].filename, "asistencia_2026-08-04.csv");
  assert.equal(database.state.reporte_asistencia_envios[0].estado, "enviado");
  assert.equal(database.state.reporte_asistencia_envios[0].asistentes_count, 1);
  assert.equal(database.state.reporte_asistencia_envios[0].programacion_nombre, "Reporte principal");
  assert.equal(database.state.config.ultimo_envio_fecha, null);
});

test("registra error antes de Gmail y conserva el conteo para reintentar", async () => {
  const database = fakeDatabase();
  await assert.rejects(
    sendAttendanceReport({
      db: database,
      envValues: { GMAIL_USER: "calzado661@gmail.com" },
      config: database.state.config,
      reportDate: "2026-08-04",
      type: "manual",
      mailTransport: {
        async sendMail() {
          throw new Error("SMTP temporalmente no disponible");
        }
      }
    }),
    /SMTP temporalmente/
  );

  assert.equal(database.state.reporte_asistencia_envios[0].estado, "error");
  assert.equal(database.state.reporte_asistencia_envios[0].asistentes_count, 1);
});

test("marca revision si Gmail acepto el correo pero fallo la confirmacion", async () => {
  const database = fakeDatabase({ failSentConfirmation: true });
  await assert.rejects(
    sendAttendanceReport({
      db: database,
      envValues: { GMAIL_USER: "calzado661@gmail.com" },
      config: database.state.config,
      reportDate: "2026-08-04",
      type: "manual",
      mailTransport: { async sendMail() { return { messageId: "aceptado" }; } }
    }),
    (error) => error.code === "EMAIL_STATUS_UNCERTAIN"
  );
  assert.equal(database.state.reporte_asistencia_envios[0].estado, "revision");
});

test("un reclamo automatico bloqueado no vuelve a enviar el correo", async () => {
  const database = fakeDatabase({
    rpcClaim: { envio_id: 50, reclamado: false, motivo: "maximo_intentos", intento: 3 }
  });
  let mailCalls = 0;
  const report = await sendAttendanceReport({
    db: database,
    envValues: { GMAIL_USER: "calzado661@gmail.com" },
    config: database.state.config,
    reportDate: "2026-08-04",
    type: "automatico",
    mailTransport: { async sendMail() { mailCalls += 1; } }
  });

  assert.deepEqual(report, {
    status: "skipped",
    reason: "maximo_intentos",
    configId: 1,
    programacionNombre: "Reporte principal",
    reportDate: "2026-08-04",
    attempt: 3
  });
  assert.equal(mailCalls, 0);
});

test("un envio manual del dia no bloquea el envio automatico", async () => {
  const now = new Date("2026-08-04T18:00:00Z");
  const database = fakeDatabase({
    reporte_asistencia_envios: [{
      id: 9,
      configuracion_id: 1,
      fecha_reporte: "2026-08-04",
      tipo_envio: "manual",
      estado: "enviado",
      destinatarios: ["reporte1@example.com"]
    }]
  });
  let mailCalls = 0;
  const result = await runDueAttendanceReport({
    db: database,
    now,
    mailTransport: { async sendMail() { mailCalls += 1; return { messageId: "automatico" }; } }
  });
  assert.equal(result.status, "sent");
  assert.equal(mailCalls, 1);
  assert.equal(database.state.config.ultimo_envio_fecha, "2026-08-04");
});

test("el programador se suspende limpiamente cuando falta el secreto de Gmail", async () => {
  const database = fakeDatabase();
  const result = await runDueAttendanceReport({
    db: database,
    envValues: { GMAIL_USER: "calzado661@gmail.com" },
    now: new Date("2026-08-04T18:00:00Z")
  });
  assert.deepEqual(result, {
    status: "skipped",
    reason: "gmail_not_configured",
    configId: 1,
    programacionNombre: "Reporte principal",
    reportDate: "2026-08-04"
  });
  assert.equal(database.state.reporte_asistencia_envios.length, 0);
});

test("carga multiples programaciones con sus usuarios de la tabla puente", async () => {
  const database = fakeDatabase({
    configuracion_reporte_asistencia: [
      reportConfig(1, { nombre: "Todos", incluir_todos_activos: true }),
      reportConfig(2, { nombre: "Equipo elegido", incluir_todos_activos: false }),
      reportConfig(3, { nombre: "Archivada", eliminado_en: "2026-08-04T15:00:00Z" })
    ],
    configuracion_reporte_asistencia_usuarios: [
      { configuracion_id: 2, usuario_id: 9 },
      { configuracion_id: 2, usuario_id: 12 },
      { configuracion_id: 2, usuario_id: 9 }
    ]
  });

  const configs = await readAttendanceReportConfigs(database);
  assert.equal(configs.length, 2);
  assert.deepEqual(configs[0].usuario_ids, []);
  assert.deepEqual(configs[1].usuario_ids, [9, 12]);
  assert.equal(configs[1].nombre, "Equipo elegido");

  const selected = await readAttendanceReportConfig(database, 2);
  assert.equal(selected.incluir_todos_activos, false);
  assert.deepEqual(selected.usuario_ids, [9, 12]);
  await assert.rejects(
    readAttendanceReportConfig(database, 3),
    (error) => error.code === "ATTENDANCE_REPORT_CONFIG_NOT_FOUND"
  );
});

test("solo incluye asistentes activos con rol trabajador y respeta la seleccion", async () => {
  const database = fakeDatabase({
    usuarios: [
      { id: 8, nombre: "Ana", email: "ana@example.com", rol: "operante", activo: true },
      { id: 9, nombre: "Luis", email: "luis@example.com", rol: "Jefe de Equipo", activo: true },
      { id: 10, nombre: "Inactivo", email: "inactivo@example.com", rol: "trabajador", activo: false },
      { id: 11, nombre: "Admin", email: "admin@example.com", rol: "administrador", activo: true },
      { id: 12, nombre: "Rosa", email: "rosa@example.com", rol: "TRABAJADOR", activo: true }
    ],
    asistencias: [8, 9, 10, 11, 12].map((usuarioId, index) => ({
      id: index + 1,
      usuario_id: usuarioId,
      fecha: "2026-08-04",
      estado: "Presente",
      created_at: `2026-08-04T14:3${index}:00Z`
    }))
  });

  const activeWorkers = await readActiveAttendanceWorkers(database);
  assert.deepEqual(activeWorkers.map((worker) => worker.id), [8, 9, 12]);

  const selected = await readPresentAttendances(database, "2026-08-04", {
    incluir_todos_activos: false,
    usuario_ids: [9, 10, 11]
  });
  assert.deepEqual(selected.map((worker) => worker.usuario_id), [9]);

  const allActive = await readPresentAttendances(database, "2026-08-04", {
    incluir_todos_activos: true,
    usuario_ids: []
  });
  assert.deepEqual(allActive.map((worker) => worker.usuario_id).sort((a, b) => a - b), [8, 9, 12]);
});

test("un reporte enviado de una programacion no bloquea otra", async () => {
  const database = fakeDatabase({
    configuracion_reporte_asistencia: [reportConfig(1), reportConfig(2)],
    reporte_asistencia_envios: [{
      id: 20,
      configuracion_id: 1,
      programacion_nombre: "Programacion 1",
      fecha_reporte: "2026-08-04",
      tipo_envio: "automatico",
      estado: "enviado",
      destinatarios: ["reporte1@example.com"]
    }]
  });
  const messages = [];
  const result = await runDueAttendanceReports({
    db: database,
    envValues: { GMAIL_USER: "calzado661@gmail.com", GMAIL_APP_PASSWORD: "abcdefghijklmnop" },
    now: new Date("2026-08-04T18:00:00Z"),
    mailTransportFactory: (config) => ({
      async sendMail(message) {
        messages.push({ configId: config.id, message });
        return { messageId: `mensaje-${config.id}` };
      }
    })
  });

  assert.equal(result.sent, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(messages.map((entry) => entry.configId), [2]);
  assert.deepEqual(messages[0].message.bcc, ["reporte2@example.com"]);
  assert.deepEqual(database.state.rpcCalls.map((call) => call.params.p_configuracion_id), [2]);
});

test("el lote aisla el fallo de una programacion y envia las demas", async () => {
  const database = fakeDatabase({
    configuracion_reporte_asistencia: [reportConfig(1), reportConfig(2)]
  });
  const result = await runDueAttendanceReports({
    db: database,
    envValues: { GMAIL_USER: "calzado661@gmail.com", GMAIL_APP_PASSWORD: "abcdefghijklmnop" },
    now: new Date("2026-08-04T18:00:00Z"),
    mailTransportFactory: (config) => ({
      async sendMail() {
        if (config.id === 1) throw new Error("fallo SMTP de la primera programacion");
        return { messageId: `mensaje-${config.id}` };
      }
    })
  });

  assert.equal(result.status, "partial");
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 1);
  const firstLog = database.state.reporte_asistencia_envios.find((row) => row.configuracion_id === 1);
  const secondLog = database.state.reporte_asistencia_envios.find((row) => row.configuracion_id === 2);
  assert.equal(firstLog.estado, "error");
  assert.equal(secondLog.estado, "enviado");
  assert.equal(firstLog.programacion_nombre, "Programacion 1");
  assert.equal(secondLog.programacion_nombre, "Programacion 2");
});

test("procesa como maximo tres programaciones vencidas por tick", async () => {
  const database = fakeDatabase({
    configuracion_reporte_asistencia: [1, 2, 3, 4].map((id) => reportConfig(id))
  });
  let mailCalls = 0;
  const result = await runDueAttendanceReports({
    db: database,
    envValues: { GMAIL_USER: "calzado661@gmail.com", GMAIL_APP_PASSWORD: "abcdefghijklmnop" },
    now: new Date("2026-08-04T18:00:00Z"),
    mailTransportFactory: () => ({
      async sendMail() {
        mailCalls += 1;
        return { messageId: `mensaje-${mailCalls}` };
      }
    })
  });

  assert.equal(result.due, 4);
  assert.equal(result.processed, 3);
  assert.equal(result.deferred, 1);
  assert.equal(result.sent, 3);
  assert.equal(mailCalls, 3);
  assert.equal(result.results.filter((item) => item.reason === "batch_limit").length, 1);
});
