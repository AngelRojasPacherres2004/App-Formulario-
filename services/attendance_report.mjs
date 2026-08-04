import nodemailer from "nodemailer";

export const DEFAULT_GMAIL_USER = "calzado661@gmail.com";
export const DEFAULT_REPORT_SUBJECT = "Reporte diario de asistencia";
export const REPORT_TIME_ZONE = "America/Lima";
export const MAX_REPORT_RECIPIENTS = 20;

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

export async function readAttendanceReportConfig(db) {
  const result = await db
    .from("configuracion_reporte_asistencia")
    .select("*")
    .eq("id", 1)
    .maybeSingle();
  const config = databaseError(result, "No se pudo cargar la configuracion del reporte.");
  if (!config) throw new Error("No existe la configuracion del reporte de asistencia.");
  return config;
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

export async function readPresentAttendances(db, reportDate) {
  if (!DATE_PATTERN.test(String(reportDate || ""))) throw new Error("La fecha del reporte no es valida.");
  const attendanceResult = await db
    .from("asistencias")
    .select("id,usuario_id,fecha,estado,created_at")
    .eq("fecha", reportDate)
    .ilike("estado", "Presente")
    .order("created_at", { ascending: true });
  const attendances = databaseError(attendanceResult, "No se pudo consultar la asistencia.") || [];
  const userIds = Array.from(new Set(attendances.map((row) => Number(row.usuario_id)).filter(Number.isInteger)));

  let users = [];
  if (userIds.length) {
    const usersResult = await db
      .from("usuarios")
      .select("id,nombre,email,rol")
      .in("id", userIds);
    users = databaseError(usersResult, "No se pudieron consultar los trabajadores asistentes.") || [];
  }

  const usersById = new Map(users.map((user) => [Number(user.id), user]));
  return attendances
    .map((attendance) => {
      const user = usersById.get(Number(attendance.usuario_id));
      return {
        id: attendance.id,
        usuario_id: attendance.usuario_id,
        fecha: attendance.fecha,
        marcado_en: attendance.created_at,
        nombre: user?.nombre || `Usuario ${attendance.usuario_id}`,
        email: user?.email || "",
        rol: user?.rol || ""
      };
    })
    .sort((left, right) => left.nombre.localeCompare(right.nombre, "es", { sensitivity: "base" }));
}

export function buildAttendanceReport({ reportDate, attendees, timeZone = REPORT_TIME_ZONE }) {
  const rows = Array.isArray(attendees) ? attendees : [];
  const formattedDate = displayDate(reportDate);
  const tableRows = rows.map((row, index) => `
    <tr>
      <td style="padding:10px;border-bottom:1px solid #dce6e2;">${index + 1}</td>
      <td style="padding:10px;border-bottom:1px solid #dce6e2;font-weight:700;">${escapeHtml(row.nombre)}</td>
      <td style="padding:10px;border-bottom:1px solid #dce6e2;">${escapeHtml(row.email || "Sin correo")}</td>
      <td style="padding:10px;border-bottom:1px solid #dce6e2;">${escapeHtml(row.rol || "Sin rol")}</td>
      <td style="padding:10px;border-bottom:1px solid #dce6e2;">${escapeHtml(displayDateTime(row.marcado_en, timeZone))}</td>
    </tr>`).join("");

  const emptyRow = `
    <tr><td colspan="5" style="padding:24px;text-align:center;color:#66756f;">No se registraron personas presentes en esta fecha.</td></tr>`;

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
          <div style="display:inline-block;background:#e6f7f1;color:#086451;border-radius:999px;padding:10px 16px;font-weight:800;margin-bottom:20px;">
            ${rows.length} ${rows.length === 1 ? "persona asistio" : "personas asistieron"}
          </div>
          <div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;font-size:14px;">
              <thead>
                <tr style="background:#edf3f0;text-align:left;">
                  <th style="padding:10px;">Nro.</th>
                  <th style="padding:10px;">Trabajador</th>
                  <th style="padding:10px;">Correo</th>
                  <th style="padding:10px;">Rol</th>
                  <th style="padding:10px;">Marcado en</th>
                </tr>
              </thead>
              <tbody>${tableRows || emptyRow}</tbody>
            </table>
          </div>
          <p style="margin:22px 0 0;color:#66756f;font-size:12px;">Este reporte fue generado automaticamente desde el modulo de asistencia.</p>
        </div>
      </div>
    </body>
  </html>`;

  const textRows = rows.length
    ? rows.map((row, index) => `${index + 1}. ${row.nombre} | ${row.email || "Sin correo"} | ${row.rol || "Sin rol"} | ${displayDateTime(row.marcado_en, timeZone)}`).join("\n")
    : "No se registraron personas presentes en esta fecha.";
  const text = `REPORTE DIARIO DE ASISTENCIA\nFecha: ${formattedDate}\nTotal de asistentes: ${rows.length}\n\n${textRows}`;

  const csvHeader = ["Nro.", "Trabajador", "Correo", "Rol", "Fecha", "Marcado en"];
  const csvRows = rows.map((row, index) => [
    index + 1,
    row.nombre,
    row.email,
    row.rol,
    reportDate,
    displayDateTime(row.marcado_en, timeZone)
  ]);
  const csv = `\uFEFF${[csvHeader, ...csvRows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  return { html, text, csv };
}

function gmailTransport(envValues) {
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
      configuracion_id: Number(config.id || 1),
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

export async function claimAutomaticReport(db, { reportDate, recipients, now = new Date() }) {
  const result = await db.rpc("reclamar_reporte_asistencia", {
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
  const gmail = gmailConfiguration(envValues);
  if (!mailTransport && !gmail.configured) {
    throw new Error("Falta configurar GMAIL_APP_PASSWORD en las variables privadas de Netlify.");
  }

  const claim = type === "automatico"
    ? await claimAutomaticReport(db, { reportDate, recipients })
    : {
        claimed: true,
        reason: "manual",
        attempt: 1,
        log: await createManualReportLog(db, { config, reportDate, recipients, initiatedBy })
      };
  if (!claim.claimed) {
    return { status: "skipped", reason: claim.reason, reportDate, attempt: claim.attempt };
  }

  let mailAccepted = false;
  let historyConfirmed = false;
  try {
    const attendees = await readPresentAttendances(db, reportDate);
    databaseError(await db
      .from("reporte_asistencia_envios")
      .update({ asistentes_count: attendees.length })
      .eq("id", claim.log.id), "No se pudo actualizar el total de asistentes del reporte.");
    const content = buildAttendanceReport({
      reportDate,
      attendees,
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
        mensaje_id: String(mailResult?.messageId || "") || null,
        detalle_error: null,
        enviado_en: sentAt
      })
      .eq("id", claim.log.id), "No se pudo confirmar el historial del reporte.");
    historyConfirmed = true;

    const today = localDateTimeParts(new Date(), config.zona_horaria || REPORT_TIME_ZONE).date;
    let configWarning = null;
    if (type === "automatico" || reportDate === today) {
      const configResult = await db
        .from("configuracion_reporte_asistencia")
        .update({ ultimo_envio_fecha: reportDate, ultimo_envio_en: sentAt })
        .eq("id", Number(config.id || 1));
      if (configResult.error) configWarning = cleanErrorMessage(configResult.error);
    }

    return {
      status: "sent",
      reportDate,
      recipients,
      attendeesCount: attendees.length,
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

export async function runDueAttendanceReport({ db, envValues = process.env, now = new Date() }) {
  const config = await readAttendanceReportConfig(db);
  const due = reportDue(config, now);
  if (!due.due) return { status: "skipped", reason: due.reason, reportDate: due.reportDate || null };
  const existingResult = await db
    .from("reporte_asistencia_envios")
    .select("id,estado")
    .eq("fecha_reporte", due.reportDate)
    .in("estado", ["enviando", "enviado", "revision"])
    .limit(1);
  const existing = databaseError(existingResult, "No se pudo verificar si el reporte ya fue enviado.") || [];
  if (existing.length) {
    if (existing[0].estado === "enviado") {
      await db
        .from("configuracion_reporte_asistencia")
        .update({ ultimo_envio_fecha: due.reportDate, ultimo_envio_en: now.toISOString() })
        .eq("id", Number(config.id || 1));
    }
    return {
      status: "skipped",
      reason: existing[0].estado === "enviado" ? "already_sent" : "requires_review",
      reportDate: due.reportDate
    };
  }
  if (!gmailConfiguration(envValues).configured) {
    return { status: "skipped", reason: "gmail_not_configured", reportDate: due.reportDate };
  }
  return sendAttendanceReport({
    db,
    envValues,
    config,
    reportDate: due.reportDate,
    type: "automatico"
  });
}
