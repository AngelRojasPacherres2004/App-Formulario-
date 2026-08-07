import {
  gmailConfiguration,
  gmailTransport,
  localDateTimeParts,
  MAX_AUTOMATIC_REPORTS_PER_TICK,
  normalizeRecipients,
  normalizeReportSubject,
  normalizeReportTime,
  REPORT_TIME_ZONE
} from "./attendance_report.mjs";

const CONFIG_TABLE = "configuracion_reporte_actividad";
const CONFIG_USERS_TABLE = "configuracion_reporte_actividad_usuarios";
const HISTORY_TABLE = "reporte_actividad_envios";
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function databaseError(result, fallback) {
  if (!result?.error) return result?.data;
  const error = new Error(result.error.message || fallback);
  error.code = result.error.code;
  throw error;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function timeMinutes(value) {
  const normalized = normalizeReportTime(value);
  const [hour, minute] = normalized.split(":").map(Number);
  return hour * 60 + minute;
}

function localMinutes(value, timeZone = REPORT_TIME_ZONE) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(values.hour) * 60 + Number(values.minute);
}

function displayDate(isoDate) {
  return new Intl.DateTimeFormat("es-PE", {
    timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric"
  }).format(new Date(`${isoDate}T12:00:00Z`));
}

function normalizePositiveIds(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
  ));
}

export function normalizeActivityReportConfig(config = {}, selectedUserIds = []) {
  const id = Number(config.id || 1);
  return {
    ...config,
    id,
    nombre: String(config.nombre || `Programacion ${id}`).trim(),
    activo: config.activo === true,
    destinatarios: normalizeRecipients(config.destinatarios),
    hora_manana: normalizeReportTime(config.hora_manana || "12:00"),
    hora_tarde: normalizeReportTime(config.hora_tarde || "18:00"),
    zona_horaria: config.zona_horaria || REPORT_TIME_ZONE,
    asunto: normalizeReportSubject(config.asunto || "Reporte de registros de actividades"),
    incluir_todos_activos: config.incluir_todos_activos !== false,
    usuario_ids: normalizePositiveIds(selectedUserIds),
    ultimo_envio_manana_fecha: config.ultimo_envio_manana_fecha || null,
    ultimo_envio_tarde_fecha: config.ultimo_envio_tarde_fecha || null,
    updated_at: config.updated_at || null
  };
}

async function readConfigSelections(db, configIds) {
  const ids = normalizePositiveIds(configIds);
  if (!ids.length) return new Map();

  let query = db
    .from(CONFIG_USERS_TABLE)
    .select("configuracion_id,usuario_id");
  query = ids.length === 1
    ? query.eq("configuracion_id", ids[0])
    : query.in("configuracion_id", ids);
  const rows = databaseError(await query, "No se pudieron cargar los operantes seleccionados.") || [];
  const selections = new Map(ids.map((id) => [id, []]));
  rows.forEach((row) => {
    const configId = Number(row.configuracion_id);
    const userId = Number(row.usuario_id);
    if (!selections.has(configId) || !Number.isInteger(userId) || userId <= 0) return;
    selections.get(configId).push(userId);
  });
  selections.forEach((values, id) => selections.set(id, normalizePositiveIds(values)));
  return selections;
}

export async function readActivityReportConfigs(db) {
  const result = await db
    .from(CONFIG_TABLE)
    .select("*")
    .is("eliminado_en", null)
    .order("id", { ascending: true });
  const configs = databaseError(result, "No se pudieron cargar las programaciones de actividades.") || [];
  const selections = await readConfigSelections(db, configs.map((config) => config.id));
  return configs.map((config) => normalizeActivityReportConfig(config, selections.get(Number(config.id)) || []));
}

export async function readActivityReportConfig(db, configId = 1) {
  const id = Number(configId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("La programacion del reporte no es valida.");
  const result = await db
    .from(CONFIG_TABLE)
    .select("*")
    .eq("id", id)
    .is("eliminado_en", null)
    .maybeSingle();
  const row = databaseError(result, "No se pudo cargar la configuracion de actividades.");
  if (!row) {
    const error = new Error("No existe la configuracion del reporte de actividades.");
    error.code = "ACTIVITY_REPORT_CONFIG_NOT_FOUND";
    throw error;
  }
  const selections = await readConfigSelections(db, [id]);
  return normalizeActivityReportConfig(row, selections.get(id) || []);
}

export async function readActivityReportHistory(db, limit = 30) {
  const result = await db.from(HISTORY_TABLE).select("*").order("created_at", { ascending: false }).limit(limit);
  return databaseError(result, "No se pudo cargar el historial de actividades.") || [];
}

export async function readActiveActivityWorkers(db) {
  const result = await db
    .from("usuarios")
    .select("id,nombre,email,rol,activo")
    .eq("activo", true)
    .order("nombre", { ascending: true });
  const workers = databaseError(result, "No se pudieron consultar los operantes activos.") || [];
  return workers.filter((worker) => worker.activo === true && String(worker.rol || "").trim().toLowerCase() === "operante");
}

export function activityShiftDue(config, shift, now = new Date()) {
  if (!config?.activo) return { due: false, reason: "inactive" };
  if (!normalizeRecipients(config.destinatarios).length) return { due: false, reason: "no_recipients" };
  const parts = localDateTimeParts(now, config.zona_horaria || REPORT_TIME_ZONE);
  const field = shift === "manana" ? "ultimo_envio_manana_fecha" : "ultimo_envio_tarde_fecha";
  const scheduled = shift === "manana" ? config.hora_manana : config.hora_tarde;
  if (String(config[field] || "") === parts.date) return { due: false, reason: "already_sent", reportDate: parts.date };
  if (parts.minutes < timeMinutes(scheduled)) return { due: false, reason: "before_schedule", reportDate: parts.date };
  return { due: true, reason: "ready", reportDate: parts.date };
}

function selectedActiveOperantes(activeWorkers, config) {
  const includeAllActive = config?.incluir_todos_activos !== false;
  const selectedIds = new Set(normalizePositiveIds(config?.usuario_ids));
  if (!includeAllActive && !selectedIds.size) return [];
  return activeWorkers.filter((worker) => includeAllActive || selectedIds.has(Number(worker.id)));
}

export async function readActivityCompliance(db, reportDate, shift, config) {
  if (!DATE_PATTERN.test(String(reportDate || ""))) throw new Error("La fecha del reporte no es valida.");
  if (!["manana", "tarde"].includes(shift)) throw new Error("El turno del reporte no es valido.");
  const activeWorkers = await readActiveActivityWorkers(db);
  const operantes = selectedActiveOperantes(activeWorkers, config);

  const logsResult = await db
    .from("registros_tareas")
    .select("id,usuario_id,fecha_registro,created_at")
    .eq("fecha_registro", reportDate);
  const logs = databaseError(logsResult, "No se pudieron consultar los registros de actividades.") || [];
  const morningEnd = timeMinutes(config.hora_manana);
  const afternoonEnd = timeMinutes(config.hora_tarde);
  const counts = new Map();
  logs.forEach((log) => {
    const minutes = localMinutes(log.created_at, config.zona_horaria || REPORT_TIME_ZONE);
    if (minutes === null) return;
    const belongs = shift === "manana"
      ? minutes < morningEnd
      : minutes >= morningEnd && minutes < afternoonEnd;
    if (belongs) counts.set(Number(log.usuario_id), (counts.get(Number(log.usuario_id)) || 0) + 1);
  });
  return operantes.map((worker) => ({
    usuario_id: Number(worker.id),
    nombre: worker.nombre || `Usuario ${worker.id}`,
    email: worker.email || "",
    registros: counts.get(Number(worker.id)) || 0,
    cumplio: (counts.get(Number(worker.id)) || 0) > 0
  }));
}

export function buildActivityReport({ reportDate, shift, rows }) {
  const label = shift === "manana" ? "Mañana" : "Tarde";
  const completed = rows.filter((row) => row.cumplio);
  const missing = rows.filter((row) => !row.cumplio);
  const completedTableRows = completed.map((row, index) => `<tr>
    <td style="padding:10px;border-bottom:1px solid #dce6e2;">${index + 1}</td>
    <td style="padding:10px;border-bottom:1px solid #dce6e2;font-weight:700;">${escapeHtml(row.nombre)}</td>
    <td style="padding:10px;border-bottom:1px solid #dce6e2;">${escapeHtml(row.email || "Sin correo")}</td>
    <td style="padding:10px;border-bottom:1px solid #dce6e2;">${row.registros}</td>
  </tr>`).join("");
  const completedEmptyRow = `<tr><td colspan="4" style="padding:20px;text-align:center;color:#66756f;">Nadie registro actividad en este turno.</td></tr>`;

  const missingTableRows = missing.map((row, index) => `<tr>
    <td style="padding:10px;border-bottom:1px solid #dce6e2;">${index + 1}</td>
    <td style="padding:10px;border-bottom:1px solid #dce6e2;font-weight:700;">${escapeHtml(row.nombre)}</td>
    <td style="padding:10px;border-bottom:1px solid #dce6e2;">${escapeHtml(row.email || "Sin correo")}</td>
    <td style="padding:10px;border-bottom:1px solid #dce6e2;">Sin registro</td>
  </tr>`).join("");
  const missingEmptyRow = `<tr><td colspan="4" style="padding:20px;text-align:center;color:#66756f;">Todos registraron actividad en este turno.</td></tr>`;
  const html = `<!doctype html><html lang="es"><body style="margin:0;background:#f2f6f4;font-family:Arial,sans-serif;color:#17221e;">
    <div style="max-width:760px;margin:0 auto;padding:28px 16px;"><div style="background:#10231e;color:#fff;padding:24px;border-radius:14px 14px 0 0;">
      <div style="color:#f4b75e;font-weight:800;text-transform:uppercase;">Sistema de Formularios</div>
      <h1 style="margin:8px 0 4px;">Registros de actividades · ${label}</h1><p style="margin:0;">${displayDate(reportDate)}</p></div>
      <div style="background:#fff;padding:24px;border:1px solid #dce6e2;border-radius:0 0 14px 14px;">
      <p><strong>${completed.length}</strong> cumplieron · <strong>${missing.length}</strong> no registraron actividad</p>
      <h2 style="margin:18px 0 10px;font-size:17px;">Reporte 1 - Registraron actividad</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px;"><thead><tr style="background:#edf3f0;text-align:left;"><th style="padding:10px;">Nro.</th><th style="padding:10px;">Operante</th><th style="padding:10px;">Correo</th><th style="padding:10px;">Registros</th></tr></thead><tbody>${completedTableRows || completedEmptyRow}</tbody></table>
      <h2 style="margin:26px 0 10px;font-size:17px;">Reporte 2 - No registraron actividad</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px;"><thead><tr style="background:#edf3f0;text-align:left;"><th style="padding:10px;">Nro.</th><th style="padding:10px;">Operante</th><th style="padding:10px;">Correo</th><th style="padding:10px;">Estado</th></tr></thead><tbody>${missingTableRows || missingEmptyRow}</tbody></table>
      </div></div></body></html>`;
  const text = `REPORTE DE REGISTROS DE ACTIVIDADES - ${label.toUpperCase()}\nFecha: ${displayDate(reportDate)}\nCumplieron: ${completed.length}\nSin registro: ${missing.length}\n\nREPORTE 1 - REGISTRARON ACTIVIDAD\n${completed.length ? completed.map((row, index) => `${index + 1}. ${row.nombre} (${row.registros} registro${row.registros === 1 ? "" : "s"})`).join("\n") : "Nadie registro actividad en este turno."}\n\nREPORTE 2 - NO REGISTRARON ACTIVIDAD\n${missing.length ? missing.map((row, index) => `${index + 1}. ${row.nombre}`).join("\n") : "Todos registraron actividad en este turno."}`;
  const csv = `\uFEFF${[
    ["Reporte", "Operante", "Correo", "Turno", "Estado", "Registros"],
    ...completed.map((row) => ["Registraron actividad", row.nombre, row.email, label, "Cumplio", row.registros]),
    ...missing.map((row) => ["No registraron actividad", row.nombre, row.email, label, "Sin registro", row.registros])
  ].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  return { html, text, csv, completed: completed.length, missing: missing.length };
}

async function createLog(db, { config, reportDate, shift, type, recipients, initiatedBy }) {
  if (type === "automatico") {
    const claimResult = await db.rpc("reclamar_reporte_actividad", {
      p_configuracion_id: Number(config.id),
      p_fecha_reporte: reportDate,
      p_turno: shift,
      p_destinatarios: recipients,
      p_ahora: new Date().toISOString()
    });
    const rows = databaseError(claimResult, "No se pudo reclamar el reporte automatico de actividades.");
    const claim = Array.isArray(rows) ? rows[0] : rows;
    return claim?.reclamado ? { id: claim.envio_id } : null;
  }
  const result = await db.from(HISTORY_TABLE).insert({
    configuracion_id: config.id,
    programacion_nombre: String(config.nombre || `Programacion ${config.id}`),
    fecha_reporte: reportDate,
    turno: shift,
    tipo_envio: type,
    estado: "procesando",
    destinatarios: recipients,
    iniciado_por: initiatedBy || null
  }).select("*").single();
  return databaseError(result, "No se pudo iniciar el historial del reporte de actividades.");
}

export async function sendActivityReport({ db, envValues = process.env, config, reportDate, shift, type = "manual", initiatedBy = null, mailTransport = null }) {
  const recipients = normalizeRecipients(config.destinatarios);
  if (!recipients.length) throw new Error("Agrega al menos un correo destinatario antes de enviar.");
  if (!["manana", "tarde"].includes(shift)) throw new Error("El turno del reporte no es valido.");
  const configId = Number(config.id);
  const programacionNombre = String(config.nombre || `Programacion ${configId}`);
  const log = await createLog(db, { config, reportDate, shift, type, recipients, initiatedBy });
  if (!log) return { status: "skipped", reason: "already_sent", configId, programacionNombre, reportDate, shift };
  try {
    const rows = await readActivityCompliance(db, reportDate, shift, config);
    const content = buildActivityReport({ reportDate, shift, rows });
    const mailer = mailTransport ? { sender: gmailConfiguration(envValues).sender, transport: mailTransport } : gmailTransport(envValues);
    const shiftLabel = shift === "manana" ? "Mañana" : "Tarde";
    const mailResult = await mailer.transport.sendMail({
      from: `"Sistema de Formularios" <${mailer.sender}>`, to: mailer.sender, bcc: recipients,
      subject: `${config.asunto} - ${shiftLabel} - ${displayDate(reportDate)}`,
      text: content.text, html: content.html,
      attachments: [{ filename: `actividades_${shift}_${reportDate}.csv`, content: content.csv, contentType: "text/csv; charset=utf-8" }]
    });
    const sentAt = new Date().toISOString();
    databaseError(await db.from(HISTORY_TABLE).update({
      programacion_nombre: programacionNombre,
      estado: "enviado",
      cumplieron_count: content.completed,
      sin_registro_count: content.missing,
      mensaje_id: mailResult?.messageId || null,
      enviado_en: sentAt
    }).eq("id", log.id), "No se pudo confirmar el envio de actividades.");
    if (type === "automatico") {
      const field = shift === "manana" ? "ultimo_envio_manana_fecha" : "ultimo_envio_tarde_fecha";
      await db.from(CONFIG_TABLE).update({ [field]: reportDate }).eq("id", configId);
    }
    return {
      status: "sent",
      configId,
      programacionNombre,
      reportDate,
      shift,
      recipients,
      completedCount: content.completed,
      missingCount: content.missing,
      rows,
      sentAt
    };
  } catch (error) {
    await db.from(HISTORY_TABLE).update({ estado: "error", detalle_error: String(error?.message || error).slice(0, 2000) }).eq("id", log.id);
    throw error;
  }
}

function rotateDueActivityJobs(jobs, now) {
  if (jobs.length <= MAX_AUTOMATIC_REPORTS_PER_TICK) return jobs;
  const minute = Math.floor(now.getTime() / 60_000);
  const offset = minute % jobs.length;
  return [...jobs.slice(offset), ...jobs.slice(0, offset)];
}

export async function runDueActivityReports({ db, envValues = process.env, now = new Date(), mailTransportFactory = null }) {
  const configs = await readActivityReportConfigs(db);
  const dueJobs = [];
  const results = [];

  configs.forEach((config) => {
    ["manana", "tarde"].forEach((shift) => {
      const due = activityShiftDue(config, shift, now);
      if (due.due) {
        dueJobs.push({ config, shift });
        return;
      }
      results.push({
        status: "skipped",
        reason: due.reason,
        configId: Number(config.id),
        programacionNombre: config.nombre,
        shift,
        reportDate: due.reportDate || null
      });
    });
  });

  if (dueJobs.length && !gmailConfiguration(envValues).configured && !mailTransportFactory) {
    dueJobs.forEach(({ config, shift }) => {
      const due = activityShiftDue(config, shift, now);
      results.push({
        status: "skipped",
        reason: "gmail_not_configured",
        configId: Number(config.id),
        programacionNombre: config.nombre,
        shift,
        reportDate: due.reportDate || null
      });
    });
    return {
      status: "completed",
      checked: configs.length,
      due: dueJobs.length,
      processed: 0,
      deferred: 0,
      sent: 0,
      skipped: results.length,
      failed: 0,
      results
    };
  }

  const orderedDue = rotateDueActivityJobs(dueJobs, now);
  const candidates = orderedDue.slice(0, MAX_AUTOMATIC_REPORTS_PER_TICK);
  const deferredJobs = orderedDue.slice(MAX_AUTOMATIC_REPORTS_PER_TICK);
  deferredJobs.forEach(({ config, shift }) => {
    results.push({
      status: "skipped",
      reason: "batch_limit",
      configId: Number(config.id),
      programacionNombre: config.nombre,
      shift,
      reportDate: localDateTimeParts(now, config.zona_horaria || REPORT_TIME_ZONE).date
    });
  });

  const settled = await Promise.allSettled(candidates.map(async ({ config, shift }) => {
    const due = activityShiftDue(config, shift, now);
    const mailTransport = typeof mailTransportFactory === "function" ? mailTransportFactory(config, shift) : null;
    return sendActivityReport({ db, envValues, config, reportDate: due.reportDate, shift, type: "automatico", mailTransport });
  }));
  settled.forEach((entry, index) => {
    const { config, shift } = candidates[index];
    if (entry.status === "fulfilled") {
      results.push(entry.value);
      return;
    }
    results.push({
      status: "failed",
      reason: entry.reason?.code || "send_failed",
      configId: Number(config.id),
      programacionNombre: config.nombre,
      shift,
      reportDate: localDateTimeParts(now, config.zona_horaria || REPORT_TIME_ZONE).date
    });
  });

  const sent = results.filter((result) => result.status === "sent").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  return {
    status: failed ? "partial" : "completed",
    checked: configs.length,
    due: dueJobs.length,
    processed: candidates.length,
    deferred: deferredJobs.length,
    sent,
    skipped,
    failed,
    results
  };
}
