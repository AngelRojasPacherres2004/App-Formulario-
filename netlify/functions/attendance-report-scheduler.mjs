import { createClient } from "@supabase/supabase-js";
import { runDueAttendanceReports } from "../../services/attendance_report.mjs";

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
  const result = await runDueAttendanceReports({
    db: databaseClient(),
    envValues: process.env,
    now: new Date()
  });

  // Netlify conserva solamente totales; nunca se registran destinatarios ni secretos.
  console.log(JSON.stringify({
    task: "attendance-report",
    status: result.status,
    checked: result.checked,
    due: result.due,
    processed: result.processed,
    deferred: result.deferred,
    sent: result.sent,
    skipped: result.skipped,
    failed: result.failed
  }));
}

// La hora exacta sigue siendo editable desde la web y se guarda en Supabase.
// Esta funcion despierta cada minuto para admitir cualquier minuto elegido por el administrador.
export const config = {
  schedule: "* * * * *"
};
