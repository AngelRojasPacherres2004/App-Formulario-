import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAttendanceReport,
  gmailConfiguration,
  localDateTimeParts,
  normalizeRecipients,
  normalizeReportSubject,
  normalizeReportTime,
  reportDue,
  runDueAttendanceReport,
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
    const tableRows = this.table === "configuracion_reporte_asistencia"
      ? [state.config]
      : state[this.table] || [];

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
      if (state.failSentConfirmation && this.table === "reporte_asistencia_envios" && this.payload.estado === "enviado") {
        return { data: null, error: { code: "TEST_DB_FAILURE", message: "fallo al confirmar" } };
      }
      rows.forEach((row) => Object.assign(row, this.payload, { updated_at: new Date().toISOString() }));
      return { data: this.singleRow ? rows[0] || null : rows, error: null };
    }

    if (Number.isInteger(this.maxRows)) rows = rows.slice(0, this.maxRows);
    return { data: this.singleRow ? rows[0] || null : rows, error: null };
  }
}

function fakeDatabase(overrides = {}) {
  const state = {
    config: {
      id: 1,
      activo: true,
      destinatarios: ["reporte1@example.com", "reporte2@example.com"],
      hora_envio: "00:00",
      zona_horaria: "America/Lima",
      asunto: "Reporte diario de asistencia",
      ultimo_envio_fecha: null,
      ultimo_envio_en: null
    },
    asistencias: [{
      id: 1,
      usuario_id: 8,
      fecha: "2026-08-04",
      estado: "Presente",
      created_at: "2026-08-04T14:30:00Z"
    }],
    usuarios: [{ id: 8, nombre: "Ana Perez", email: "ana@example.com", rol: "operante" }],
    reporte_asistencia_envios: [],
    nextLogId: 1,
    failSentConfirmation: false,
    rpcClaim: { envio_id: 50, reclamado: true, motivo: "nuevo", intento: 1 },
    ...overrides
  };
  const database = {
    state,
    from(table) {
      return new FakeQuery(database, table);
    },
    async rpc(name) {
      assert.equal(name, "reclamar_reporte_asistencia");
      const claim = state.rpcClaim;
      if (claim.reclamado && !state.reporte_asistencia_envios.some((row) => row.id === claim.envio_id)) {
        state.reporte_asistencia_envios.push({
          id: claim.envio_id,
          fecha_reporte: "2026-08-04",
          tipo_envio: "automatico",
          estado: "procesando",
          destinatarios: state.config.destinatarios,
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
    reportDate: "2026-08-04",
    attempt: 3
  });
  assert.equal(mailCalls, 0);
});

test("el programador omite el automatico si ya existe un envio del dia", async () => {
  const now = new Date("2026-08-04T18:00:00Z");
  const database = fakeDatabase({
    reporte_asistencia_envios: [{
      id: 9,
      fecha_reporte: "2026-08-04",
      tipo_envio: "manual",
      estado: "enviado",
      destinatarios: ["reporte1@example.com"]
    }]
  });
  const result = await runDueAttendanceReport({ db: database, now });
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "already_sent");
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
    reportDate: "2026-08-04"
  });
  assert.equal(database.state.reporte_asistencia_envios.length, 0);
});
