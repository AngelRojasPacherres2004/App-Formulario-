import { createClient } from "@supabase/supabase-js";
import { runDueAttendanceReports } from "../../services/attendance_report.mjs";
import { runDueActivityReports } from "../../services/activity_report.mjs";

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
  const db = databaseClient();
  const now = new Date();
  const [attendance, activity] = await Promise.allSettled([
    runDueAttendanceReports({ db, envValues: process.env, now }),
    runDueActivityReports({ db, envValues: process.env, now })
  ]);

  console.log(JSON.stringify({
    task: "automatic-notifications",
    attendance: attendance.status === "fulfilled" ? {
      status: attendance.value.status,
      checked: attendance.value.checked,
      due: attendance.value.due,
      sent: attendance.value.sent,
      failed: attendance.value.failed
    } : { status: "failed", reason: attendance.reason?.code || "scheduler_error" },
    activity: activity.status === "fulfilled" ? {
      status: activity.value.status,
      sent: activity.value.sent,
      failed: activity.value.failed
    } : { status: "failed", reason: activity.reason?.code || "scheduler_error" }
  }));
}

// La hora exacta sigue siendo editable desde la web y se guarda en Supabase.
// Esta funcion despierta cada minuto para admitir cualquier minuto elegido por el administrador.
export const config = {
  schedule: "* * * * *"
};
