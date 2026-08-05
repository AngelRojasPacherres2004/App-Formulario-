import {
  gmailConfiguration,
  gmailTransport,
  localDateTimeParts,
  normalizeRecipients,
  normalizeReportSubject,
  normalizeReportTime,
  REPORT_TIME_ZONE
} from "./attendance_report.mjs";

const CONFIG_TABLE = "configuracion_reporte_actividad";
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

export function normalizeActivityReportConfig(config = {}) {
  return {
    id: Number(config.id || 1),
    activo: config.activo === true,
    destinatarios: normalizeRecipients(config.destinatarios),
    hora_manana: normalizeReportTime(config.hora_manana || "12:00"),
    hora_tarde: normalizeReportTime(config.hora_tarde || "18:00"),
    zona_horaria: config.zona_horaria || REPORT_TIME_ZONE,
    asunto: normalizeReportSubject(config.asunto || "Reporte de registros de actividades"),
    ultimo_envio_manana_fecha: config.ultimo_envio_manana_fecha || null,
    ultimo_envio_tarde_fecha: config.ultimo_envio_tarde_fecha || null,
    updated_at: config.updated_at || null
  };
}

export async function readActivityReportConfig(db) {
  const result = await db.from(CONFIG_TABLE).select("*").eq("id", 1).maybeSingle();
  const row = databaseError(result, "No se pudo cargar la configuracion de actividades.");
  if (!row) {
    const error = new Error("No existe la configuracion del reporte de actividades.");
    error.code = "ACTIVITY_REPORT_CONFIG_NOT_FOUND";
    throw error;
  }
  return normalizeActivityReportConfig(row);
}

export async function readActivityReportHistory(db, limit = 30) {
  const result = await db.from(HISTORY_TABLE).select("*").order("created_at", { ascending: false }).limit(limit);
  return databaseError(result, "No se pudo cargar el historial de actividades.") || [];
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

export async function readActivityCompliance(db, reportDate, shift, config) {
  if (!DATE_PATTERN.test(String(reportDate || ""))) throw new Error("La fecha del reporte no es valida.");
  if (!["manana", "tarde"].includes(shift)) throw new Error("El turno del reporte no es valido.");
  const usersResult = await db
    .from("usuarios")
    .select("id,nombre,email,rol,activo")
    .eq("activo", true)
    .order("nombre", { ascending: true });
  const users = databaseError(usersResult, "No se pudieron consultar los operantes activos.") || [];
  const operantes = users.filter((user) => String(user.rol || "").trim().toLowerCase() === "operante" && user.activo === true);

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
  const bodyRows = rows.map((row, index) => `<tr>
    <td style="padding:10px;border-bottom:1px solid #dce6e2;">${index + 1}</td>
    <td style="padding:10px;border-bottom:1px solid #dce6e2;font-weight:700;">${escapeHtml(row.nombre)}</td>
    <td style="padding:10px;border-bottom:1px solid #dce6e2;">${row.cumplio ? "Cumplió" : "Sin registro"}</td>
    <td style="padding:10px;border-bottom:1px solid #dce6e2;">${row.registros}</td>
  </tr>`).join("");
  const html = `<!doctype html><html lang="es"><body style="margin:0;background:#f2f6f4;font-family:Arial,sans-serif;color:#17221e;">
    <div style="max-width:760px;margin:0 auto;padding:28px 16px;"><div style="background:#10231e;color:#fff;padding:24px;border-radius:14px 14px 0 0;">
      <div style="color:#f4b75e;font-weight:800;text-transform:uppercase;">Sistema de Formularios</div>
      <h1 style="margin:8px 0 4px;">Registros de actividades · ${label}</h1><p style="margin:0;">${displayDate(reportDate)}</p></div>
      <div style="background:#fff;padding:24px;border:1px solid #dce6e2;border-radius:0 0 14px 14px;">
      <p><strong>${completed.length}</strong> cumplieron · <strong>${missing.length}</strong> no registraron actividad</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;"><thead><tr style="background:#edf3f0;text-align:left;"><th style="padding:10px;">Nro.</th><th style="padding:10px;">Operante</th><th style="padding:10px;">Estado</th><th style="padding:10px;">Registros</th></tr></thead><tbody>${bodyRows}</tbody></table>
      </div></div></body></html>`;
  const text = `REPORTE DE REGISTROS DE ACTIVIDADES - ${label.toUpperCase()}\nFecha: ${displayDate(reportDate)}\nCumplieron: ${completed.length}\nSin registro: ${missing.length}\n\n${rows.map((row) => `${row.nombre}: ${row.cumplio ? `Cumplio (${row.registros})` : "Sin registro"}`).join("\n")}`;
  const csv = `\uFEFF${[["Operante", "Correo", "Turno", "Estado", "Registros"], ...rows.map((row) => [row.nombre, row.email, label, row.cumplio ? "Cumplio" : "Sin registro", row.registros])].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  return { html, text, csv, completed: completed.length, missing: missing.length };
}

async function createLog(db, { config, reportDate, shift, type, recipients, initiatedBy }) {
  if (type === "automatico") {
    const claimResult = await db.rpc("reclamar_reporte_actividad", {
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
  const log = await createLog(db, { config, reportDate, shift, type, recipients, initiatedBy });
  if (!log) return { status: "skipped", reason: "already_sent", reportDate, shift };
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
    databaseError(await db.from(HISTORY_TABLE).update({ estado: "enviado", cumplieron_count: content.completed, sin_registro_count: content.missing, mensaje_id: mailResult?.messageId || null, enviado_en: sentAt }).eq("id", log.id), "No se pudo confirmar el envio de actividades.");
    if (type === "automatico") {
      const field = shift === "manana" ? "ultimo_envio_manana_fecha" : "ultimo_envio_tarde_fecha";
      await db.from(CONFIG_TABLE).update({ [field]: reportDate }).eq("id", config.id);
    }
    return { status: "sent", reportDate, shift, recipients, completedCount: content.completed, missingCount: content.missing, rows, sentAt };
  } catch (error) {
    await db.from(HISTORY_TABLE).update({ estado: "error", detalle_error: String(error?.message || error).slice(0, 2000) }).eq("id", log.id);
    throw error;
  }
}

export async function runDueActivityReports({ db, envValues = process.env, now = new Date(), mailTransportFactory = null }) {
  const config = await readActivityReportConfig(db);
  const results = [];
  for (const shift of ["manana", "tarde"]) {
    const due = activityShiftDue(config, shift, now);
    if (!due.due) { results.push({ status: "skipped", reason: due.reason, shift }); continue; }
    if (!gmailConfiguration(envValues).configured && !mailTransportFactory) { results.push({ status: "skipped", reason: "gmail_not_configured", shift }); continue; }
    try {
      results.push(await sendActivityReport({ db, envValues, config, reportDate: due.reportDate, shift, type: "automatico", mailTransport: mailTransportFactory?.(shift) || null }));
    } catch (error) {
      results.push({ status: "failed", reason: error?.code || "send_failed", shift });
    }
  }
  return { status: results.some((item) => item.status === "failed") ? "partial" : "completed", sent: results.filter((item) => item.status === "sent").length, failed: results.filter((item) => item.status === "failed").length, results };
}
