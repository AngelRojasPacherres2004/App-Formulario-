import nodemailer from "nodemailer";

export const DEFAULT_GMAIL_USER = "calzado661@gmail.com";
export const DEFAULT_REPORT_SUBJECT = "Reporte diario de asistencia";
export const REPORT_TIME_ZONE = "America/Lima";
export const MAX_REPORT_RECIPIENTS = 20;
export const MAX_AUTOMATIC_REPORTS_PER_TICK = 3;

const REPORT_CONFIG_TABLE = "configuracion_reporte_asistencia";
const REPORT_CONFIG_USERS_TABLE = "configuracion_reporte_asistencia_usuarios";
const WORKER_ROLES = new Set(["trabajador", "operante", "jefe de equipo"]);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function databaseError(result, fallback) {
  if (!result?.error) return result?.data;
  const error = new Error(result.error.message || fallback);
  error.code = result.error.code;
  error.details = result.error.details;
  error.hint = result.error.hint;
  throw error;
}

function cleanErrorMessage(error) {
  return String(error?.message || error || "Error desconocido al enviar el reporte.").slice(0, 2000);
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

function displayDate(isoDate) {
  if (!DATE_PATTERN.test(String(isoDate || ""))) return String(isoDate || "");
  return new Intl.DateTimeFormat("es-PE", {
    timeZone: "UTC",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(new Date(`${isoDate}T12:00:00Z`));
}

function displayDateTime(value, timeZone = REPORT_TIME_ZONE) {
  if (!value) return "Sin hora registrada";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Sin hora registrada";
  return new Intl.DateTimeFormat("es-PE", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(date);
}

function timeToMinutes(value) {
  const match = String(value || "").match(TIME_PATTERN);
  if (!match) throw new Error("La hora de envio no es valida.");
  return Number(match[1]) * 60 + Number(match[2]);
}

function normalizeWorkerRole(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizePositiveIds(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
  ));
}

function normalizeReportConfig(config, selectedUserIds = []) {
  const id = Number(config?.id);
  return {
    ...config,
    id,
    nombre: String(config?.nombre || `Programacion ${id}`).trim(),
    activo: config?.activo === true,
    destinatarios: normalizeRecipients(config?.destinatarios),
    zona_horaria: config?.zona_horaria || REPORT_TIME_ZONE,
    asunto: normalizeReportSubject(config?.asunto),
    incluir_todos_activos: config?.incluir_todos_activos !== false,
    usuario_ids: normalizePositiveIds(selectedUserIds)
  };
}

export function normalizeRecipients(value) {
  const candidates = Array.isArray(value)
    ? value
    : String(value || "").split(/[\n,;]+/);
  const recipients = Array.from(
    new Set(candidates.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean))
  );

  if (recipients.length > MAX_REPORT_RECIPIENTS) {
    throw new Error(`Solo se permiten hasta ${MAX_REPORT_RECIPIENTS} correos destinatarios.`);
  }

  const invalid = recipients.find((email) => !EMAIL_PATTERN.test(email));
  if (invalid) throw new Error(`El correo destinatario ${invalid} no es valido.`);
  return recipients;
}

export function normalizeReportTime(value) {
  const match = String(value || "").match(TIME_PATTERN);
  if (!match) throw new Error("Selecciona una hora valida para el envio diario.");
  return `${match[1]}:${match[2]}`;
}

export function normalizeReportSubject(value) {
  const subject = String(value || DEFAULT_REPORT_SUBJECT).trim();
  if (!subject) throw new Error("El asunto del reporte es obligatorio.");
  if (subject.length > 160) throw new Error("El asunto no puede superar 160 caracteres.");
  return subject;
}

export function localDateTimeParts(now = new Date(), timeZone = REPORT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
    minutes: Number(values.hour) * 60 + Number(values.minute)
  };
}

export function reportDue(config, now = new Date()) {
  if (!config?.activo) return { due: false, reason: "inactive" };
  const recipients = normalizeRecipients(config.destinatarios);
  if (!recipients.length) return { due: false, reason: "no_recipients" };
  const parts = localDateTimeParts(now, config.zona_horaria || REPORT_TIME_ZONE);
  if (String(config.ultimo_envio_fecha || "") === parts.date) {
    return { due: false, reason: "already_sent", reportDate: parts.date };
  }
  if (parts.minutes < timeToMinutes(config.hora_envio)) {
    return { due: false, reason: "before_schedule", reportDate: parts.date };
  }
  return { due: true, reason: "ready", reportDate: parts.date };
}

export function gmailConfiguration(envValues = process.env) {
  const sender = String(envValues.GMAIL_USER || DEFAULT_GMAIL_USER).trim().toLowerCase();
  const appPassword = String(envValues.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
  return {
    sender,
    appPassword,
    configured: Boolean(sender && appPassword)
  };
}

async function readConfigSelections(db, configIds) {
  const ids = normalizePositiveIds(configIds);
  if (!ids.length) return new Map();

  let query = db
    .from(REPORT_CONFIG_USERS_TABLE)
    .select("configuracion_id,usuario_id");
  query = ids.length === 1
    ? query.eq("configuracion_id", ids[0])
    : query.in("configuracion_id", ids);
  const rows = databaseError(await query, "No se pudieron cargar los trabajadores seleccionados.") || [];
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

export async function readAttendanceReportConfigs(db) {
  const result = await db
    .from(REPORT_CONFIG_TABLE)
    .select("*")
    .is("eliminado_en", null)
    .order("id", { ascending: true });
  const configs = databaseError(result, "No se pudieron cargar las programaciones del reporte.") || [];
  const selections = await readConfigSelections(db, configs.map((config) => config.id));
  return configs.map((config) => normalizeReportConfig(config, selections.get(Number(config.id)) || []));
}

export async function readAttendanceReportConfig(db, configId = 1) {
  const id = Number(configId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("La programacion del reporte no es valida.");
  const result = await db
    .from(REPORT_CONFIG_TABLE)
    .select("*")
    .eq("id", id)
    .is("eliminado_en", null)
    .maybeSingle();
  const config = databaseError(result, "No se pudo cargar la programacion del reporte.");
  if (!config) {
    const error = new Error("No existe la programacion del reporte de asistencia.");
    error.code = "ATTENDANCE_REPORT_CONFIG_NOT_FOUND";
    throw error;
  }
  const selections = await readConfigSelections(db, [id]);
  return normalizeReportConfig(config, selections.get(id) || []);
}

export async function readAttendanceReportHistory(db, limit = 12) {
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 12));
  const result = await db
    .from("reporte_asistencia_envios")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(safeLimit);
  return databaseError(result, "No se pudo cargar el historial de reportes.") || [];
}

export async function readActiveAttendanceWorkers(db) {
  const result = await db
    .from("usuarios")
    .select("id,nombre,email,rol,activo")
    .eq("activo", true)
    .order("nombre", { ascending: true });
  const workers = databaseError(result, "No se pudieron consultar los trabajadores activos.") || [];
  return workers.filter((worker) => worker.activo === true && WORKER_ROLES.has(normalizeWorkerRole(worker.rol)));
}

const ATTENDED_STATES = new Set(["PUNTUAL", "TARDANZA"]);

async function readAttendanceRowsForDate(db, reportDate) {
  if (!DATE_PATTERN.test(String(reportDate || ""))) throw new Error("La fecha del reporte no es valida.");
  const attendanceResult = await db
    .from("asistencias")
    .select("id,usuario_id,fecha,estado,created_at")
    .eq("fecha", reportDate)
    .order("created_at", { ascending: true });
  return databaseError(attendanceResult, "No se pudo consultar la asistencia.") || [];
}

function selectedActiveWorkers(activeWorkers, config) {
  const includeAllActive = config?.incluir_todos_activos !== false;
  const selectedIds = new Set(normalizePositiveIds(config?.usuario_ids));
  if (!includeAllActive && !selectedIds.size) return [];
  return activeWorkers.filter((worker) => includeAllActive || selectedIds.has(Number(worker.id)));
}

export async function readPresentAttendances(db, reportDate, config = null) {
  const rows = await readAttendanceRowsForDate(db, reportDate);
  const attended = rows.filter((row) => ATTENDED_STATES.has(String(row.estado || "").toUpperCase()));
  if (!attended.length) return [];

  const activeWorkers = await readActiveAttendanceWorkers(db);
  const usersById = new Map(selectedActiveWorkers(activeWorkers, config).map((worker) => [Number(worker.id), worker]));
  return attended
    .map((attendance) => {
      const user = usersById.get(Number(attendance.usuario_id));
      if (!user) return null;
      return {
        id: attendance.id,
        usuario_id: attendance.usuario_id,
        fecha: attendance.fecha,
        marcado_en: attendance.created_at,
        estado: String(attendance.estado || "").toUpperCase(),
        nombre: user?.nombre || `Usuario ${attendance.usuario_id}`,
        email: user?.email || "",
        rol: user?.rol || ""
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.nombre.localeCompare(right.nombre, "es", { sensitivity: "base" }));
}

export async function readAbsentAttendances(db, reportDate, config = null) {
  const rows = await readAttendanceRowsForDate(db, reportDate);
  const attendedIds = new Set(
    rows
      .filter((row) => ATTENDED_STATES.has(String(row.estado || "").toUpperCase()))
      .map((row) => Number(row.usuario_id))
  );

  const activeWorkers = await readActiveAttendanceWorkers(db);
  return selectedActiveWorkers(activeWorkers, config)
    .filter((worker) => !attendedIds.has(Number(worker.id)))
    .map((worker) => ({
      usuario_id: Number(worker.id),
      nombre: worker.nombre || `Usuario ${worker.id}`,
      email: worker.email || "",
      rol: worker.rol || ""
    }))
    .sort((left, right) => left.nombre.localeCompare(right.nombre, "es", { sensitivity: "base" }));
}

function attendanceStateLabel(estado) {
  return String(estado || "").toUpperCase() === "TARDANZA" ? "Tardanza" : "Puntual";
}

export function buildAttendanceReport({ reportDate, attendees, absentees = [], timeZone = REPORT_TIME_ZONE }) {
  const attendeeRows = Array.isArray(attendees) ? attendees : [];
  const absentRows = Array.isArray(absentees) ? absentees : [];
  const formattedDate = displayDate(reportDate);

  const attendeeTableRows = attendeeRows.map((row, index) => `
    <tr>
      <td style="padding:10px;border-bottom:1px solid #dce6e2;">${index + 1}</td>
      <td style="padding:10px;border-bottom:1px solid #dce6e2;font-weight:700;">${escapeHtml(row.nombre)}</td>
      <td style="padding:10px;border-bottom:1px solid #dce6e2;">${escapeHtml(row.email || "Sin correo")}</td>
      <td style="padding:10px;border-bottom:1px solid #dce6e2;">${escapeHtml(row.rol || "Sin rol")}</td>
      <td style="padding:10px;border-bottom:1px solid #dce6e2;">${escapeHtml(attendanceStateLabel(row.estado))}</td>
      <td style="padding:10px;border-bottom:1px solid #dce6e2;">${escapeHtml(displayDateTime(row.marcado_en, timeZone))}</td>
    </tr>`).join("");
  const attendeeEmptyRow = `
    <tr><td colspan="6" style="padding:24px;text-align:center;color:#66756f;">No se registraron personas presentes en esta fecha.</td></tr>`;

  const absentTableRows = absentRows.map((row, index) => `
    <tr>
      <td style="padding:10px;border-bottom:1px solid #dce6e2;">${index + 1}</td>
      <td style="padding:10px;border-bottom:1px solid #dce6e2;font-weight:700;">${escapeHtml(row.nombre)}</td>
      <td style="padding:10px;border-bottom:1px solid #dce6e2;">${escapeHtml(row.email || "Sin correo")}</td>
      <td style="padding:10px;border-bottom:1px solid #dce6e2;">${escapeHtml(row.rol || "Sin rol")}</td>
    </tr>`).join("");
  const absentEmptyRow = `
    <tr><td colspan="4" style="padding:24px;text-align:center;color:#66756f;">No se registraron personas ausentes en esta fecha.</td></tr>`;

  const html = `<!doctype html>
  <html lang="es">
    <body style="margin:0;background:#f2f6f4;font-family:Arial,sans-serif;color:#17221e;">
      <div style="max-width:820px;margin:0 auto;padding:28px 16px;">
        <div style="background:#10231e;color:#fff;border-radius:14px 14px 0 0;padding:24px;">
          <div style="color:#f4b75e;font-size:13px;font-weight:800;text-transform:uppercase;">Sistema de Formularios</div>
          <h1 style="margin:8px 0 4px;font-size:28px;">Reporte diario de asistencia</h1>
          <p style="margin:0;color:#c8d7d1;">${escapeHtml(formattedDate)}</p>
        </div>
        <div style="background:#fff;border:1px solid #dce6e2;border-top:0;border-radius:0 0 14px 14px;padding:24px;">
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px;">
            <div style="background:#e6f7f1;color:#086451;border-radius:999px;padding:10px 16px;font-weight:800;">
              ${attendeeRows.length} ${attendeeRows.length === 1 ? "persona asistio" : "personas asistieron"}
            </div>
            <div style="background:#fdeeee;color:#a3312a;border-radius:999px;padding:10px 16px;font-weight:800;">
              ${absentRows.length} ${absentRows.length === 1 ? "persona no asistio" : "personas no asistieron"}
            </div>
          </div>

          <h2 style="margin:0 0 10px;font-size:17px;">Reporte 1 \u00B7 Asistieron</h2>
          <div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;font-size:14px;">
              <thead>
                <tr style="background:#edf3f0;text-align:left;">
                  <th style="padding:10px;">Nro.</th>
                  <th style="padding:10px;">Trabajador</th>
                  <th style="padding:10px;">Correo</th>
                  <th style="padding:10px;">Rol</th>
                  <th style="padding:10px;">Estado</th>
                  <th style="padding:10px;">Marcado en</th>
                </tr>
              </thead>
              <tbody>${attendeeTableRows || attendeeEmptyRow}</tbody>
            </table>
          </div>

          <h2 style="margin:26px 0 10px;font-size:17px;">Reporte 2 \u00B7 No asistieron</h2>
          <div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;font-size:14px;">
              <thead>
                <tr style="background:#edf3f0;text-align:left;">
                  <th style="padding:10px;">Nro.</th>
                  <th style="padding:10px;">Trabajador</th>
                  <th style="padding:10px;">Correo</th>
                  <th style="padding:10px;">Rol</th>
                </tr>
              </thead>
              <tbody>${absentTableRows || absentEmptyRow}</tbody>
            </table>
          </div>

          <p style="margin:22px 0 0;color:#66756f;font-size:12px;">Este reporte fue generado automaticamente desde el modulo de asistencia.</p>
        </div>
      </div>
    </body>
  </html>`;

  const textAttendeeRows = attendeeRows.length
    ? attendeeRows.map((row, index) => `${index + 1}. ${row.nombre} | ${row.email || "Sin correo"} | ${row.rol || "Sin rol"} | ${attendanceStateLabel(row.estado)} | ${displayDateTime(row.marcado_en, timeZone)}`).join("\n")
    : "No se registraron personas presentes en esta fecha.";
  const textAbsentRows = absentRows.length
    ? absentRows.map((row, index) => `${index + 1}. ${row.nombre} | ${row.email || "Sin correo"} | ${row.rol || "Sin rol"}`).join("\n")
    : "No se registraron personas ausentes en esta fecha.";
  const text = `REPORTE DIARIO DE ASISTENCIA\nFecha: ${formattedDate}\nTotal de asistentes: ${attendeeRows.length}\nTotal de ausentes: ${absentRows.length}\n\nREPORTE 1 - ASISTIERON\n${textAttendeeRows}\n\nREPORTE 2 - NO ASISTIERON\n${textAbsentRows}`;

  const csvHeader = ["Reporte", "Nro.", "Trabajador", "Correo", "Rol", "Estado", "Fecha", "Marcado en"];
  const csvAttendeeRows = attendeeRows.map((row, index) => [
    "Asistieron",
    index + 1,
    row.nombre,
    row.email,
    row.rol,
    attendanceStateLabel(row.estado),
    reportDate,
    displayDateTime(row.marcado_en, timeZone)
  ]);
  const csvAbsentRows = absentRows.map((row, index) => [
    "No asistieron",
    index + 1,
    row.nombre,
    row.email,
    row.rol,
    "Ausente",
    reportDate,
    ""
  ]);
  const csv = `\uFEFF${[csvHeader, ...csvAttendeeRows, ...csvAbsentRows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  return { html, text, csv };
}

export function gmailTransport(envValues) {
  const gmail = gmailConfiguration(envValues);
  if (!gmail.configured) {
    throw new Error("Falta configurar GMAIL_APP_PASSWORD en las variables privadas de Netlify.");
  }
  return {
    sender: gmail.sender,
    transport: nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: gmail.sender, pass: gmail.appPassword },
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 12_000
    })
  };
}

async function createManualReportLog(db, { config, reportDate, recipients, initiatedBy }) {
  const result = await db
    .from("reporte_asistencia_envios")
    .insert({
      configuracion_id: Number(config.id),
      programacion_nombre: String(config.nombre || `Programacion ${config.id}`),
      fecha_reporte: reportDate,
      tipo_envio: "manual",
      estado: "procesando",
      destinatarios: recipients,
      iniciado_por: initiatedBy || null
    })
    .select("*")
    .single();

  return databaseError(result, "No se pudo iniciar el historial del reporte.");
}

export async function claimAutomaticReport(db, { configId, reportDate, recipients, now = new Date() }) {
  const id = Number(configId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("La programacion del reporte no es valida.");
  const result = await db.rpc("reclamar_reporte_asistencia", {
    p_configuracion_id: id,
    p_fecha_reporte: reportDate,
    p_destinatarios: recipients,
    p_ahora: now.toISOString()
  });
  const rows = databaseError(result, "No se pudo reclamar el envio automatico.");
  const claim = Array.isArray(rows) ? rows[0] : rows;
  if (!claim) throw new Error("Supabase no devolvio el estado del envio automatico.");
  return {
    claimed: Boolean(claim.reclamado),
    reason: claim.motivo || "no_reclamado",
    attempt: Number(claim.intento || 0),
    log: claim.envio_id ? { id: claim.envio_id } : null
  };
}

export async function sendAttendanceReport({
  db,
  envValues = process.env,
  config,
  reportDate,
  type = "manual",
  initiatedBy = null,
  mailTransport = null
}) {
  if (!DATE_PATTERN.test(String(reportDate || ""))) throw new Error("La fecha del reporte no es valida.");
  if (!['automatico', 'manual'].includes(type)) throw new Error("El tipo de envio no es valido.");
  const recipients = normalizeRecipients(config?.destinatarios);
  if (!recipients.length) throw new Error("Agrega al menos un correo destinatario antes de enviar.");
  const configId = Number(config?.id);
  if (!Number.isInteger(configId) || configId <= 0) throw new Error("La programacion del reporte no es valida.");
  const gmail = gmailConfiguration(envValues);
  if (!mailTransport && !gmail.configured) {
    throw new Error("Falta configurar GMAIL_APP_PASSWORD en las variables privadas de Netlify.");
  }

  const claim = type === "automatico"
    ? await claimAutomaticReport(db, { configId, reportDate, recipients })
    : {
        claimed: true,
        reason: "manual",
        attempt: 1,
        log: await createManualReportLog(db, { config, reportDate, recipients, initiatedBy })
      };
  if (!claim.claimed) {
    return {
      status: "skipped",
      reason: claim.reason,
      configId,
      programacionNombre: String(config.nombre || `Programacion ${configId}`),
      reportDate,
      attempt: claim.attempt
    };
  }

  let mailAccepted = false;
  let historyConfirmed = false;
  try {
    const [attendees, absentees] = await Promise.all([
      readPresentAttendances(db, reportDate, config),
      readAbsentAttendances(db, reportDate, config)
    ]);
    databaseError(await db
      .from("reporte_asistencia_envios")
      .update({
        programacion_nombre: String(config.nombre || `Programacion ${configId}`),
        asistentes_count: attendees.length,
        ausentes_count: absentees.length
      })
      .eq("id", claim.log.id), "No se pudo actualizar el total de asistentes del reporte.");
    const content = buildAttendanceReport({
      reportDate,
      attendees,
      absentees,
      timeZone: config.zona_horaria || REPORT_TIME_ZONE
    });
    const mailer = mailTransport
      ? { sender: gmail.sender, transport: mailTransport }
      : gmailTransport(envValues);
    const subject = `${normalizeReportSubject(config.asunto)} - ${displayDate(reportDate)}`;
    databaseError(await db
      .from("reporte_asistencia_envios")
      .update({ estado: "enviando", detalle_error: null })
      .eq("id", claim.log.id), "No se pudo preparar el envio en el historial.");
    const mailResult = await mailer.transport.sendMail({
      from: `"Sistema de Formularios" <${mailer.sender}>`,
      to: mailer.sender,
      bcc: recipients,
      subject,
      text: content.text,
      html: content.html,
      attachments: [{
        filename: `asistencia_${reportDate}.csv`,
        content: content.csv,
        contentType: "text/csv; charset=utf-8"
      }]
    });
    mailAccepted = true;
    const sentAt = new Date().toISOString();
    databaseError(await db
      .from("reporte_asistencia_envios")
      .update({
        estado: "enviado",
        asistentes_count: attendees.length,
        ausentes_count: absentees.length,
        mensaje_id: String(mailResult?.messageId || "") || null,
        detalle_error: null,
        enviado_en: sentAt
      })
      .eq("id", claim.log.id), "No se pudo confirmar el historial del reporte.");
    historyConfirmed = true;

    let configWarning = null;
    // Un envio manual es una prueba o reenvio y no debe consumir el turno
    // automatico del dia.
    if (type === "automatico") {
      const configResult = await db
        .from("configuracion_reporte_asistencia")
        .update({ ultimo_envio_fecha: reportDate, ultimo_envio_en: sentAt })
        .eq("id", configId);
      if (configResult.error) configWarning = cleanErrorMessage(configResult.error);
    }

    return {
      status: "sent",
      configId,
      programacionNombre: String(config.nombre || `Programacion ${configId}`),
      reportDate,
      recipients,
      attendeesCount: attendees.length,
      absenteesCount: absentees.length,
      messageId: String(mailResult?.messageId || "") || null,
      sentAt,
      attempt: claim.attempt,
      configWarning
    };
  } catch (error) {
    const uncertain = mailAccepted && !historyConfirmed;
    await db
      .from("reporte_asistencia_envios")
      .update({
        estado: uncertain ? "revision" : "error",
        detalle_error: uncertain
          ? `Gmail acepto el mensaje, pero no se pudo confirmar el historial: ${cleanErrorMessage(error)}`
          : cleanErrorMessage(error)
      })
      .eq("id", claim.log.id);
    if (uncertain) {
      const uncertainError = new Error("Gmail acepto el correo, pero su estado requiere revision en el historial.");
      uncertainError.code = "EMAIL_STATUS_UNCERTAIN";
      throw uncertainError;
    }
    throw error;
  }
}

export async function runDueAttendanceReport({
  db,
  envValues = process.env,
  now = new Date(),
  config = null,
  configId = null,
  mailTransport = null
}) {
  const resolvedConfig = config || await readAttendanceReportConfig(db, configId || 1);
  const resolvedConfigId = Number(resolvedConfig.id);
  const programacionNombre = String(resolvedConfig.nombre || `Programacion ${resolvedConfigId}`);
  const due = reportDue(resolvedConfig, now);
  if (!due.due) {
    return {
      status: "skipped",
      reason: due.reason,
      configId: resolvedConfigId,
      programacionNombre,
      reportDate: due.reportDate || null
    };
  }
  const existingResult = await db
    .from("reporte_asistencia_envios")
    .select("id,estado")
    .eq("configuracion_id", resolvedConfigId)
    .eq("fecha_reporte", due.reportDate)
    .eq("tipo_envio", "automatico")
    .in("estado", ["enviando", "enviado", "revision"])
    .limit(1);
  const existing = databaseError(existingResult, "No se pudo verificar si el reporte ya fue enviado.") || [];
  if (existing.length) {
    if (existing[0].estado === "enviado") {
      await db
        .from("configuracion_reporte_asistencia")
        .update({ ultimo_envio_fecha: due.reportDate, ultimo_envio_en: now.toISOString() })
        .eq("id", resolvedConfigId);
    }
    return {
      status: "skipped",
      reason: existing[0].estado === "enviado" ? "already_sent" : "requires_review",
      configId: resolvedConfigId,
      programacionNombre,
      reportDate: due.reportDate
    };
  }
  if (!mailTransport && !gmailConfiguration(envValues).configured) {
    return {
      status: "skipped",
      reason: "gmail_not_configured",
      configId: resolvedConfigId,
      programacionNombre,
      reportDate: due.reportDate
    };
  }
  return sendAttendanceReport({
    db,
    envValues,
    config: resolvedConfig,
    reportDate: due.reportDate,
    type: "automatico",
    mailTransport
  });
}

function rotateDueConfigs(configs, now) {
  if (configs.length <= MAX_AUTOMATIC_REPORTS_PER_TICK) return configs;
  const minute = Math.floor(now.getTime() / 60_000);
  const offset = minute % configs.length;
  return [...configs.slice(offset), ...configs.slice(0, offset)];
}

export async function runDueAttendanceReports({
  db,
  envValues = process.env,
  now = new Date(),
  mailTransportFactory = null
}) {
  const configs = await readAttendanceReportConfigs(db);
  const dueConfigs = [];
  const results = [];

  configs.forEach((config) => {
    const due = reportDue(config, now);
    if (due.due) {
      dueConfigs.push(config);
      return;
    }
    results.push({
      status: "skipped",
      reason: due.reason,
      configId: Number(config.id),
      programacionNombre: config.nombre,
      reportDate: due.reportDate || null
    });
  });

  if (dueConfigs.length && !gmailConfiguration(envValues).configured && !mailTransportFactory) {
    dueConfigs.forEach((config) => {
      const due = reportDue(config, now);
      results.push({
        status: "skipped",
        reason: "gmail_not_configured",
        configId: Number(config.id),
        programacionNombre: config.nombre,
        reportDate: due.reportDate || null
      });
    });
    return {
      status: "completed",
      checked: configs.length,
      due: dueConfigs.length,
      processed: 0,
      deferred: 0,
      sent: 0,
      skipped: results.length,
      failed: 0,
      results
    };
  }

  const orderedDue = rotateDueConfigs(dueConfigs, now);
  const candidates = orderedDue.slice(0, MAX_AUTOMATIC_REPORTS_PER_TICK);
  const deferredConfigs = orderedDue.slice(MAX_AUTOMATIC_REPORTS_PER_TICK);
  deferredConfigs.forEach((config) => {
    results.push({
      status: "skipped",
      reason: "batch_limit",
      configId: Number(config.id),
      programacionNombre: config.nombre,
      reportDate: localDateTimeParts(now, config.zona_horaria || REPORT_TIME_ZONE).date
    });
  });

  const settled = await Promise.allSettled(candidates.map(async (config) => {
    const mailTransport = typeof mailTransportFactory === "function" ? mailTransportFactory(config) : null;
    return runDueAttendanceReport({ db, envValues, now, config, mailTransport });
  }));
  settled.forEach((entry, index) => {
    const config = candidates[index];
    if (entry.status === "fulfilled") {
      results.push(entry.value);
      return;
    }
    results.push({
      status: "failed",
      reason: entry.reason?.code || "send_failed",
      configId: Number(config.id),
      programacionNombre: config.nombre,
      reportDate: localDateTimeParts(now, config.zona_horaria || REPORT_TIME_ZONE).date
    });
  });

  const sent = results.filter((result) => result.status === "sent").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  return {
    status: failed ? "partial" : "completed",
    checked: configs.length,
    due: dueConfigs.length,
    processed: candidates.length,
    deferred: deferredConfigs.length,
    sent,
    skipped,
    failed,
    results
  };
}
