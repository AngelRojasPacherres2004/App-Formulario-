import { createClient } from "@supabase/supabase-js";
import { runDueAttendanceReport } from "../../services/attendance_report.mjs";

function databaseClient() {
  const url = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    throw new Error("Faltan SUPABASE_URL y SUPABASE_SECRET_KEY para ejecutar el reporte programado.");
  }
  return createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

export default async function attendanceReportScheduler() {
  const result = await runDueAttendanceReport({
    db: databaseClient(),
    envValues: process.env,
    now: new Date()
  });

  // Netlify conserva este resumen en los logs sin incluir destinatarios ni secretos.
  console.log(JSON.stringify({
    task: "attendance-report",
    status: result.status,
    reason: result.reason || null,
    reportDate: result.reportDate || null,
    attendeesCount: result.attendeesCount ?? null
  }));
}

// La hora exacta sigue siendo editable desde la web y se guarda en Supabase.
// Esta funcion despierta cada minuto para admitir cualquier minuto elegido por el administrador.
export const config = {
  schedule: "* * * * *"
};
