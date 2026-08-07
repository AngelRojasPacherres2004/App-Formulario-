import { requireSupabase } from "./supabaseClient";
import { applyScoringRules, isGroupLeaderTimeTask, isWorkerRole, normalizeRole, normalizeScoringRule } from "./scoring";
import { nowLimaISODateTime } from "./dates";

let taskTableName;
let attendanceTableName;

const missingColumnRegex = /Could not find the '([^']+)' column/i;
const missingResourceRegex = /Could not find the table 'public\.([^']+)'/i;

function db() {
  return requireSupabase();
}

const API_SESSION_KEY = "formulario_api_session_v2";

function apiSessionToken() {
  try {
    return localStorage.getItem(API_SESSION_KEY) || "";
  } catch {
    return "";
  }
}

function apiEndpoints(path) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const configuredOrigin = import.meta.env?.VITE_API_URL;
  const localOrigins = import.meta.env?.DEV
    ? ["http://127.0.0.1:5180", "http://localhost:5180"]
    : [];
  const origins = [configuredOrigin, ...localOrigins]
    .filter(Boolean)
    .map((origin) => String(origin).replace(/\/+$/, ""));

  return Array.from(new Set([normalizedPath, ...origins.map((origin) => `${origin}${normalizedPath}`)]));
}

async function requestLocalApi(path, options = {}, config = {}) {
  let sawNotFound = false;
  let sawNonJson = false;
  let sawNetworkFailure = false;
  for (const endpoint of apiEndpoints(path)) {
    try {
      const response = await fetch(endpoint, {
        ...options,
        headers: {
          "content-type": "application/json",
          ...(apiSessionToken() ? { authorization: `Bearer ${apiSessionToken()}` } : {}),
          ...(options.headers || {})
        }
      });

      const contentType = response.headers.get("content-type") || "";
      if (response.status === 404 && !contentType.includes("application/json")) {
        sawNotFound = true;
        continue;
      }
      if (!contentType.includes("application/json")) {
        sawNonJson = true;
        continue;
      }

      const payload = await response.json().catch(() => ({}));
      if (response.status === 404 && /ruta de api no encontrada/i.test(String(payload.error || payload.message || ""))) {
        sawNotFound = true;
        continue;
      }
      if (response.ok) return payload;
      if (config.nullOnAuthFailure && [400, 401, 403].includes(response.status)) return null;

      throw new Error(payload.error || payload.message || `Error ${response.status} al consultar el backend local.`);
    } catch (error) {
      if (error instanceof TypeError) {
        sawNetworkFailure = true;
        continue;
      }
      throw error;
    }
  }

  if (config.requiredBackend) {
    if (sawNotFound) {
      throw new Error("El backend esta desactualizado y aun no incluye Notificaciones. Reinicialo localmente o publica las nuevas Functions de Netlify.");
    }
    if (sawNonJson) {
      throw new Error("La ruta de Notificaciones esta devolviendo la pagina web en lugar de la API. Reinicia el backend y revisa la redireccion /api de Netlify.");
    }
    if (sawNetworkFailure) {
      throw new Error("No se pudo conectar con el backend de Notificaciones. Ejecuta npm.cmd run dev o verifica que las Functions esten publicadas.");
    }
    throw new Error("El servicio de Notificaciones no esta disponible en este momento.");
  }

  return null;
}

function errorMessage(error) {
  return error?.message || String(error || "Error desconocido");
}

function ensureOk(result) {
  if (result.error) throw result.error;
  return result.data;
}

async function trySelectTable(tableName) {
  const result = await db().from(tableName).select("id").limit(1);
  return !result.error;
}

export async function getTaskTableName() {
  if (taskTableName) return taskTableName;

  for (const candidate of ["tarea", "tareas"]) {
    if (await trySelectTable(candidate)) {
      taskTableName = candidate;
      return taskTableName;
    }
  }

  throw new Error("No se encontro la tabla de tareas. Crea public.tarea o public.tareas.");
}

async function getAttendanceTableName() {
  if (attendanceTableName) return attendanceTableName;

  for (const candidate of ["asistencias", "asistencia"]) {
    if (await trySelectTable(candidate)) {
      attendanceTableName = candidate;
      return attendanceTableName;
    }
  }

  throw new Error("No se encontro la tabla de asistencia. Crea public.asistencias o public.asistencia.");
}

function isMissingResource(error) {
  const message = errorMessage(error);
  return missingResourceRegex.test(message) || /relation .* does not exist/i.test(message);
}

function missingColumn(error) {
  return missingColumnRegex.exec(errorMessage(error))?.[1] || null;
}

function isMissingTableError(error, tableName) {
  const message = errorMessage(error).toLowerCase();
  return message.includes(tableName.toLowerCase()) && message.includes("schema cache");
}

async function tableColumns(tableName) {
  const result = await db().from(tableName).select("*").limit(1);
  if (result.error || !result.data?.length) return null;
  return Object.keys(result.data[0]);
}

function filterPayloadColumns(payload, columns) {
  if (!columns) return payload;
  return Object.fromEntries(Object.entries(payload).filter(([key]) => columns.includes(key)));
}

function isActiveValue(value) {
  return !["false", "0", "no"].includes(String(value ?? true).trim().toLowerCase());
}

export function friendlyError(error) {
  const message = errorMessage(error);
  if (/numeric field overflow|precision 10, scale 2/i.test(message)) {
    return "Una cantidad supera el maximo permitido por la base de datos: 99,999,999.99.";
  }
  if (/incidentes|usuario_id/i.test(message) && /could not find|does not exist|schema cache/i.test(message)) {
    return "Falta ejecutar la migración de incidencias en Supabase: sql/010_incidentes_estructura.sql.";
  }
  if (/row-level security/i.test(message)) {
    return "Supabase rechazo la operacion por politicas RLS. Revisa permisos de la clave publica.";
  }
  if (/duplicate key/i.test(message)) {
    if (/Key \(id\)|_pkey/i.test(message)) {
      return "La numeracion interna de la base de datos esta desactualizada. Reinicia el backend e intenta nuevamente.";
    }
    return "Ya existe un registro con esos datos.";
  }
  if (/violates foreign key/i.test(message)) {
    return "No se puede guardar porque falta un registro relacionado.";
  }
  return message;
}

export async function selectUsers() {
  const apiResult = await requestLocalApi("/api/users");
  if (apiResult?.users) return apiResult.users;

  const cols = "id,nombre,email,rol,activo,created_at,fecha_cumpleanos,sueldo";
  const precise = await db().from("usuarios").select(cols).order("id", { ascending: true });
  if (!precise.error) return precise.data || [];
  return ensureOk(await db().from("usuarios").select("*").order("id", { ascending: true })) || [];
}

export async function listWorkers() {
  const users = await selectUsers();
  return users.filter((user) => ["trabajador", "operante", "jefe de equipo"].includes(normalizeRole(user.rol)));
}

export async function listAssignableWorkers() {
  const users = await selectUsers();
  return users.filter((user) => isWorkerRole(user.rol) && isActiveValue(user.activo));
}

export async function listOperantesAndTeamLeads() {
  const users = await selectUsers();
  return users.filter((user) => ["operante", "jefe de equipo"].includes(normalizeRole(user.rol)));
}

export async function verifyUser(email, password) {
  const normalizedEmail = String(email || "").trim().toLowerCase();

  const apiUser = await verifyUserWithLocalApi(normalizedEmail, password);
  if (apiUser) return apiUser;

  const rpcResult = await db().rpc("verify_usuario_login", {
    p_email: normalizedEmail,
    p_password: password
  });
  if (!rpcResult.error && rpcResult.data?.length) return rpcResult.data[0];

  const byHash = await db()
    .from("usuarios")
    .select("*")
    .eq("email", normalizedEmail)
    .eq("password_hash", password)
    .limit(1);
  if (!byHash.error && byHash.data?.length) return byHash.data[0];

  const byPassword = await db()
    .from("usuarios")
    .select("*")
    .eq("email", normalizedEmail)
    .eq("password", password)
    .limit(1);
  if (!byPassword.error && byPassword.data?.length) return byPassword.data[0];

  return null;
}

async function verifyUserWithLocalApi(email, password) {
  const payload = await requestLocalApi(
    "/api/login",
    {
      method: "POST",
      body: JSON.stringify({ email, password })
    },
    { nullOnAuthFailure: true }
  );
  if (payload?.sessionToken) {
    try {
      localStorage.setItem(API_SESSION_KEY, payload.sessionToken);
    } catch {
      // El inicio de sesion sigue funcionando aunque el navegador bloquee storage.
    }
  }
  return payload?.user || null;
}

export function clearApiSession() {
  try {
    localStorage.removeItem(API_SESSION_KEY);
  } catch {
    // Nada que limpiar si storage no esta disponible.
  }
}

export async function createUser(payload, plainPassword) {
  const apiResult = await requestLocalApi("/api/users", {
    method: "POST",
    body: JSON.stringify({ ...payload, password_hash: plainPassword })
  });
  if (apiResult?.user) return apiResult.user;

  return ensureOk(await db().from("usuarios").insert({ ...payload, password_hash: plainPassword }).select("*").single());
}

export async function updateUser(userId, changes, newPassword) {
  const payload = newPassword ? { ...changes, password_hash: newPassword } : changes;
  const apiResult = await requestLocalApi(`/api/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
  if (apiResult?.user) return apiResult.user;

  return ensureOk(await db().from("usuarios").update(payload).eq("id", userId).select("*").single());
}

export async function deleteUser(userId) {
  const apiResult = await requestLocalApi(`/api/users/${encodeURIComponent(userId)}`, {
    method: "DELETE"
  });
  if (apiResult && (apiResult.deleted || apiResult.archived)) return apiResult;

  ensureOk(await db().from("usuarios").delete().eq("id", userId));
  return { deleted: true, archived: false };
}

export async function getUserTrainingProfile(userId) {
  const apiResult = await requestLocalApi(`/api/users/${encodeURIComponent(userId)}/trainings`);
  if (!apiResult?.user || !Array.isArray(apiResult.trainings)) {
    throw new Error("El backend local debe estar activo para cargar las capacitaciones.");
  }
  return apiResult;
}

export async function setUserTrainingStatus(userId, courseId, status) {
  const estado = typeof status === "boolean" ? (status ? "finalizado" : "pendiente") : String(status || "");
  const apiResult = await requestLocalApi(
    `/api/users/${encodeURIComponent(userId)}/trainings/${encodeURIComponent(courseId)}`,
    {
      method: "PUT",
      body: JSON.stringify({ estado })
    }
  );
  if (!apiResult?.user || !Array.isArray(apiResult.trainings)) {
    throw new Error("No se pudo actualizar la capacitacion.");
  }
  return apiResult;
}

export async function listTasks() {
  const apiResult = await requestLocalApi("/api/tasks");
  let tasks = apiResult?.tasks;

  if (!tasks) {
    const tableName = await getTaskTableName();
    tasks = ensureOk(await db().from(tableName).select("*").order("id", { ascending: true })) || [];
  }

  let rules = [];
  try {
    rules = await listTaskScoringRules();
  } catch (error) {
    console.warn("Las tareas se cargaron, pero no fue posible leer reglas_puntaje.", error);
  }
  const rulesByTask = new Map();
  rules.forEach((rule) => {
    const current = rulesByTask.get(String(rule.tarea_id)) || [];
    current.push(rule);
    rulesByTask.set(String(rule.tarea_id), current);
  });
  return tasks.map((task) => applyScoringRules(task, rulesByTask.get(String(task.id)) || []));
}

export async function getTasksForUser(user) {
  const role = normalizeRole(user?.rol);
  const tasks = (await listTasks()).filter((task) => isActiveValue(task.activo));

  if (!["trabajador", "operante", "jefe de equipo", "jefe de grupo"].includes(role)) {
    return tasks;
  }

  const roleTasks = role === "operante" || role === "trabajador"
    ? tasks
    : tasks.filter((task) => !isGroupLeaderTimeTask(task));

  const assignedTasks = roleTasks.filter((task) => {
    const idMatches = ["asignado_a", "trabajador_id", "usuario_id"].some(
      (column) => task[column] !== undefined && String(task[column]) === String(user?.id)
    );
    const emailMatches = ["email_trabajador", "correo_trabajador", "email"].some(
      (column) => task[column] !== undefined && String(task[column]).toLowerCase() === String(user?.email || "").toLowerCase()
    );
    return idMatches || emailMatches;
  });

  return assignedTasks.length ? assignedTasks : roleTasks;
}

export async function listBrands() {
  const apiResult = await requestLocalApi("/api/brands");
  if (apiResult?.brands) return apiResult.brands;

  const result = await db().from("marcas").select("id,nombre").order("nombre", { ascending: true });
  if (result.error) throw result.error;
  return result.data || [];
}

export async function listTaskScoringRules(taskId = null) {
  const query = taskId ? `?taskId=${encodeURIComponent(taskId)}` : "";
  const apiResult = await requestLocalApi(`/api/task-score-ranges${query}`);
  if (apiResult?.rules || apiResult?.ranges) {
    return (apiResult.rules || apiResult.ranges || []).map(normalizeScoringRule);
  }

  let dbQuery = db().from("reglas_puntaje").select("*").order("puntos", { ascending: true });
  if (taskId) dbQuery = dbQuery.eq("tarea_id", taskId);
  const result = await dbQuery;
  if (result.error) throw result.error;
  return (result.data || []).map(normalizeScoringRule);
}

export async function listTaskScoreRanges(taskId) {
  return (await listTaskScoringRules(taskId)).filter((rule) => rule.tipo_regla === "CANTIDAD");
}

export async function deleteTaskScoringRules(taskId) {
  const apiResult = await requestLocalApi(`/api/task-score-ranges?taskId=${encodeURIComponent(taskId)}`, {
    method: "DELETE"
  });
  if (apiResult) return;

  const result = await db().from("reglas_puntaje").delete().eq("tarea_id", taskId);
  if (result.error) throw result.error;
}

export async function deleteTaskScoreRanges(taskId) {
  return deleteTaskScoringRules(taskId);
}

export async function setTaskScoringRules(taskId, rules) {
  const normalized = (rules || []).map((item) => ({
    tarea_id: taskId,
    tipo_regla: String(item.tipo_regla || "CANTIDAD").toUpperCase(),
    desde: item.desde ?? item.cantidad_desde ?? null,
    hasta: item.hasta ?? item.cantidad_hasta ?? null,
    turno: item.turno || null,
    puntos: item.puntos
  }));

  const apiResult = await requestLocalApi("/api/task-score-ranges", {
    method: "PUT",
    body: JSON.stringify({ taskId, rules: normalized })
  });
  if (apiResult) return;

  await deleteTaskScoringRules(taskId);
  if (!normalized.length) return;

  ensureOk(await db().from("reglas_puntaje").insert(normalized));
}

export async function setTaskScoreRanges(taskId, ranges) {
  return setTaskScoringRules(taskId, ranges);
}

export async function createTask(payload) {
  const apiResult = await requestLocalApi("/api/tasks", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (apiResult?.task) return apiResult.task;

  const tableName = await getTaskTableName();
  const columns = await tableColumns(tableName);
  const filteredPayload = filterPayloadColumns(payload, columns);
  const result = await db().from(tableName).insert(filteredPayload).select("id").single();
  if (result.error) throw result.error;
  return result.data;
}

export async function updateTask(taskId, changes, existingRow) {
  const apiResult = await requestLocalApi(`/api/tasks/${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    body: JSON.stringify(changes)
  });
  if (apiResult?.task) return apiResult.task;

  const tableName = await getTaskTableName();
  const columns = existingRow ? Object.keys(existingRow) : await tableColumns(tableName);
  ensureOk(await db().from(tableName).update(filterPayloadColumns(changes, columns)).eq("id", taskId));
}

export async function deleteTask(taskId) {
  const apiResult = await requestLocalApi(`/api/tasks/${encodeURIComponent(taskId)}`, {
    method: "DELETE"
  });
  if (apiResult && (apiResult.deleted || apiResult.archived)) return apiResult;

  const tableName = await getTaskTableName();
  const result = await db().from(tableName).delete().eq("id", taskId);
  if (result.error?.code === "23503") {
    ensureOk(await db().from(tableName).update({ activo: false }).eq("id", taskId));
    return { deleted: false, archived: true };
  }
  if (result.error) throw result.error;
  return { deleted: true, archived: false };
}

export async function listTiendas() {
  const apiResult = await requestLocalApi("/api/stores");
  if (apiResult?.stores) return apiResult.stores;

  const result = await db().from("tiendas").select("*").order("id", { ascending: true });
  if (result.error) return [];
  return result.data || [];
}

export async function createTienda(payload) {
  const apiResult = await requestLocalApi("/api/stores", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (apiResult?.store) return apiResult.store;

  const result = await db().from("tiendas").insert(payload);
  if (result.error) {
    if (isMissingTableError(result.error, "tiendas")) {
      throw new Error("La tabla public.tiendas no existe. Ejecuta la migracion SQL.");
    }
    throw result.error;
  }
}

export async function updateTienda(tiendaId, changes) {
  const apiResult = await requestLocalApi(`/api/stores/${encodeURIComponent(tiendaId)}`, {
    method: "PATCH",
    body: JSON.stringify(changes)
  });
  if (apiResult?.store) return apiResult.store;

  const result = await db().from("tiendas").update(changes).eq("id", tiendaId);
  if (result.error) throw result.error;
}

export async function deleteTienda(tiendaId) {
  const apiResult = await requestLocalApi(`/api/stores/${encodeURIComponent(tiendaId)}`, { method: "DELETE" });
  if (apiResult && (apiResult.deleted || apiResult.archived)) return apiResult;

  const result = await db().from("tiendas").delete().eq("id", tiendaId);
  if (result.error) throw result.error;
  return { deleted: true, archived: false };
}

export async function listAmonestaciones() {
  const apiResult = await requestLocalApi("/api/amonestaciones");
  if (apiResult?.amonestaciones) return apiResult.amonestaciones;

  const result = await db().from("amonestaciones").select("*").order("created_at", { ascending: false });
  if (result.error) return [];
  return result.data || [];
}

export async function createAmonestacion(payload) {
  const apiResult = await requestLocalApi("/api/amonestaciones", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (apiResult?.amonestacion) return apiResult.amonestacion;

  const result = await db().from("amonestaciones").insert(payload).select("*").single();
  if (result.error) {
    if (isMissingTableError(result.error, "amonestaciones")) {
      throw new Error("La tabla public.amonestaciones no existe. Ejecuta la migracion SQL.");
    }
    throw result.error;
  }
  return result.data;
}

export async function deleteAmonestacion(amonestacionId) {
  const apiResult = await requestLocalApi(`/api/amonestaciones/${encodeURIComponent(amonestacionId)}`, { method: "DELETE" });
  if (apiResult?.deleted) return apiResult;

  const result = await db().from("amonestaciones").delete().eq("id", amonestacionId);
  if (result.error) throw result.error;
  return { deleted: true };
}

export async function listAttendances() {
  const apiResult = await requestLocalApi("/api/attendances");
  if (apiResult?.attendances) return apiResult.attendances;

  const tableName = await getAttendanceTableName();
  const result = await db().from(tableName).select("*").order("fecha", { ascending: false });
  if (result.error) return [];
  return result.data || [];
}

export async function getAttendanceForDate(fecha) {
  const apiResult = await requestLocalApi(`/api/attendances?date=${encodeURIComponent(fecha)}`);
  if (apiResult?.attendances) return apiResult.attendances;

  const tableName = await getAttendanceTableName();
  const result = await db().from(tableName).select("*").eq("fecha", fecha);
  if (result.error) return [];
  return result.data || [];
}

export const ATTENDANCE_STATES = ["AUSENTE", "PUNTUAL", "TARDANZA"];

export async function markAttendance(usuarioId, fecha, estado = "PUNTUAL") {
  const normalizedEstado = String(estado || "").trim().toUpperCase();
  const apiResult = await requestLocalApi("/api/attendances", {
    method: "PUT",
    body: JSON.stringify({ usuario_id: usuarioId, fecha, estado: normalizedEstado })
  });
  if (apiResult?.attendance) return apiResult.attendance;

  const present = normalizedEstado !== "AUSENTE";
  const tableName = await getAttendanceTableName();
  const payload = {
    usuario_id: usuarioId,
    fecha,
    estado: normalizedEstado,
    created_at: present ? nowLimaISODateTime() : null
  };
  const result = await db().from(tableName).upsert(payload, { onConflict: "usuario_id,fecha" });
  if (result.error) {
    ensureOk(await db().from(tableName).insert(payload));
  }
}

export async function getAttendanceReportSettings() {
  const apiResult = await requestLocalApi("/api/attendance-report/settings", {}, { requiredBackend: true });
  if (Array.isArray(apiResult?.configs)) return apiResult;
  throw new Error("El backend actual no incluye Notificaciones. Reinicia el proyecto con npm.cmd run dev; si esta publicado, despliega tambien las nuevas Functions de Netlify.");
}

export async function createAttendanceReportSettings(payload) {
  const apiResult = await requestLocalApi("/api/attendance-report/settings", {
    method: "POST",
    body: JSON.stringify(payload)
  }, { requiredBackend: true });
  if (apiResult?.config) return apiResult.config;
  throw new Error("No se pudo crear la programacion de Notificaciones.");
}

export async function updateAttendanceReportSettings(configId, payload) {
  const apiResult = await requestLocalApi(`/api/attendance-report/settings/${encodeURIComponent(configId)}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  }, { requiredBackend: true });
  if (apiResult?.config) return apiResult.config;
  throw new Error("No se pudo actualizar la programacion de Notificaciones.");
}

export async function deleteAttendanceReportSettings(configId) {
  const apiResult = await requestLocalApi(`/api/attendance-report/settings/${encodeURIComponent(configId)}`, {
    method: "DELETE"
  }, { requiredBackend: true });
  if (apiResult && (apiResult.deleted || apiResult.archived || apiResult.config)) return apiResult;
  throw new Error("No se pudo eliminar la programacion de Notificaciones.");
}

export async function sendAttendanceReportNow(configId, fecha) {
  const apiResult = await requestLocalApi(`/api/attendance-report/settings/${encodeURIComponent(configId)}/send`, {
    method: "POST",
    body: JSON.stringify({ fecha })
  }, { requiredBackend: true });
  if (apiResult?.report) return apiResult.report;
  throw new Error("El backend actual no incluye el envio de Notificaciones. Reinicia el backend o publica las nuevas Functions de Netlify.");
}

export async function getActivityReportSettings() {
  const apiResult = await requestLocalApi("/api/activity-report/settings", {}, { requiredBackend: true });
  if (Array.isArray(apiResult?.configs)) return apiResult;
  throw new Error("El backend actual no incluye el reporte de registros de actividades.");
}

export async function createActivityReportSettings(payload) {
  const apiResult = await requestLocalApi("/api/activity-report/settings", {
    method: "POST",
    body: JSON.stringify(payload)
  }, { requiredBackend: true });
  if (apiResult?.config) return apiResult.config;
  throw new Error("No se pudo crear la programacion del reporte de actividades.");
}

export async function updateActivityReportSettings(configId, payload) {
  const apiResult = await requestLocalApi(`/api/activity-report/settings/${encodeURIComponent(configId)}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  }, { requiredBackend: true });
  if (apiResult?.config) return apiResult.config;
  throw new Error("No se pudo guardar la configuracion del reporte de actividades.");
}

export async function deleteActivityReportSettings(configId) {
  const apiResult = await requestLocalApi(`/api/activity-report/settings/${encodeURIComponent(configId)}`, {
    method: "DELETE"
  }, { requiredBackend: true });
  if (apiResult && (apiResult.deleted || apiResult.archived || apiResult.config)) return apiResult;
  throw new Error("No se pudo eliminar la programacion del reporte de actividades.");
}

export async function getActivityReportPreview(configId, fecha, turno) {
  const result = await requestLocalApi(
    `/api/activity-report/settings/${encodeURIComponent(configId)}/preview?date=${encodeURIComponent(fecha)}&shift=${encodeURIComponent(turno)}`,
    {},
    { requiredBackend: true }
  );
  if (result?.report) return result.report;
  throw new Error("No se pudo generar el reporte de actividades.");
}

export async function sendActivityReportNow(configId, fecha, turno) {
  const result = await requestLocalApi(`/api/activity-report/settings/${encodeURIComponent(configId)}/send`, {
    method: "POST",
    body: JSON.stringify({ fecha, turno })
  }, { requiredBackend: true });
  if (result?.report) return result.report;
  throw new Error("No se pudo enviar el reporte de actividades.");
}

function activityLogInsertPayload(resourceName, payload) {
  if (resourceName !== "registros_tareas") {
    const mapped = { ...payload };
    if (mapped.tiempo_minutos !== null && mapped.tiempo_minutos !== undefined && !("dato_extra" in mapped)) {
      mapped.dato_extra = mapped.tiempo_minutos;
    }
    return mapped;
  }

  const mapped = {
    usuario_id: payload.usuario_id || payload.trabajador_id,
    tarea_id: payload.tarea_id,
    fecha_registro: payload.fecha_registro,
    cantidad: payload.cantidad,
    turno: payload.turno,
    tienda_id: payload.tienda_id,
    numero_guia: payload.numero_guia,
    dato_extra: payload.lote,
    observacion: payload.observacion || payload.detalle,
    puntos_obtenidos: payload.puntos_obtenidos
  };

  return Object.fromEntries(Object.entries(mapped).filter(([, value]) => value !== undefined && value !== null));
}

export async function createWorkerActivityLog(payload) {
  const apiResult = await requestLocalApi("/api/activity-logs", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (apiResult?.log) return apiResult.log;

  if (payload.marcas?.length || payload.guias?.length) {
    throw new Error("El backend local debe estar activo para guardar distribuciones por marcas o guías.");
  }

  const cleanPayload = { ...payload };
  delete cleanPayload.created_at;

  const optionalGroups = [
    [],
    ["created_at"],
    ["actividad_id"],
    ["actividad_nombre"],
    ["turno"],
    ["created_at", "actividad_id"],
    ["created_at", "actividad_nombre"],
    ["created_at", "turno"],
    ["actividad_id", "actividad_nombre"],
    ["created_at", "actividad_id", "actividad_nombre"],
    ["created_at", "actividad_id", "actividad_nombre", "turno"]
  ];

  const attempts = [];
  const seen = new Set();
  optionalGroups.forEach((fields) => {
    const candidate = { ...cleanPayload };
    fields.forEach((field) => delete candidate[field]);
    const signature = Object.keys(candidate).sort().join("|");
    if (!seen.has(signature)) {
      seen.add(signature);
      attempts.push(candidate);
    }
  });

  let lastError = null;
  for (const resourceName of ["registros_tareas", "registro_actividades"]) {
    for (const candidate of attempts) {
      let currentCandidate = activityLogInsertPayload(resourceName, candidate);
      for (let index = 0; index <= Object.keys(currentCandidate).length; index += 1) {
        const result = await db().from(resourceName).insert(currentCandidate);
        if (!result.error) return;
        if (isMissingResource(result.error)) {
          lastError = result.error;
          break;
        }
        lastError = result.error;
        const missing = missingColumn(result.error);
        if (!missing || !(missing in currentCandidate)) break;
        currentCandidate = { ...currentCandidate };
        delete currentCandidate[missing];
      }
    }
  }

  throw lastError || new Error("No se pudo guardar el registro de actividad.");
}

function normalizeActivityLog(row) {
  const normalized = { ...row };
  if ("usuario_id" in normalized && !("trabajador_id" in normalized)) normalized.trabajador_id = normalized.usuario_id;
  if ("observacion" in normalized && !("detalle" in normalized)) normalized.detalle = normalized.observacion;
  if ("dato_extra" in normalized && normalized.dato_extra !== null && String(normalized.dato_extra).trim() !== "") {
    const rawExtra = normalized.dato_extra;
    const parsed = Number(rawExtra);
    if (Number.isNaN(parsed)) normalized.lote = normalized.lote || rawExtra;
    else if (normalized.tiempo_minutos === null || normalized.tiempo_minutos === undefined) normalized.tiempo_minutos = parsed;
  }
  if ("tarea" in normalized && !("actividad_nombre" in normalized)) normalized.actividad_nombre = normalized.tarea;
  return normalized;
}

async function listActivityLogsForResource(resourceName, userColumn, workerId) {
  for (const orderColumn of ["fecha_registro", "created_at", null]) {
    let query = db().from(resourceName).select("*").eq(userColumn, workerId);
    if (orderColumn) query = query.order(orderColumn, { ascending: false });
    const result = await query;
    if (!result.error) return (result.data || []).map(normalizeActivityLog);
  }
  return null;
}

export async function listWorkerActivityLogs(workerId) {
  const apiResult = await requestLocalApi(`/api/activity-logs?workerId=${encodeURIComponent(workerId)}`);
  if (apiResult?.logs) return apiResult.logs.map(normalizeActivityLog);

  const resources = ["v_registro_actividades", "registros_tareas", "registro_actividades"];
  for (const resourceName of resources) {
    const userColumns = resourceName === "registros_tareas" ? ["usuario_id", "trabajador_id"] : ["trabajador_id", "usuario_id"];
    for (const userColumn of userColumns) {
      const rows = await listActivityLogsForResource(resourceName, userColumn, workerId);
      if (rows) return rows;
    }
  }
  return [];
}

export async function listAllActivityLogs() {
  const apiResult = await requestLocalApi("/api/activity-logs");
  if (apiResult?.logs) return apiResult.logs.map(normalizeActivityLog);

  for (const resourceName of ["v_registro_actividades", "registros_tareas", "registro_actividades"]) {
    for (const orderColumn of ["fecha_registro", "created_at", null]) {
      let query = db().from(resourceName).select("*");
      if (orderColumn) query = query.order(orderColumn, { ascending: false });
      const result = await query;
      if (!result.error) return (result.data || []).map(normalizeActivityLog);
    }
  }
  return [];
}

export async function listIncidentes() {
  const result = await db().from("incidentes").select("*").order("created_at", { ascending: false });
  if (result.error) return [];
  return result.data || [];
}

export async function createIncidente(payload) {
  ensureOk(await db().from("incidentes").insert(payload));
}

export async function loadIncidentContext() {
  const apiResult = await requestLocalApi("/api/incidents/context");
  if (!apiResult) throw new Error("El backend local debe estar activo para registrar incidencias.");
  return {
    workers: apiResult.workers || [],
    tasks: apiResult.tasks || [],
    stores: apiResult.stores || [],
    incidents: apiResult.incidents || []
  };
}

export async function createIncident(payload) {
  const apiResult = await requestLocalApi("/api/incidents", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (!apiResult?.incident) throw new Error("No se pudo guardar la incidencia.");
  return apiResult.incident;
}

function normalizeGroupLeaderLog(row) {
  return {
    ...row,
    codigo_guia: row.codigo_guia ?? row.numero_guia,
    detalle: row.detalle ?? row.observacion,
    encargado_nombre: row.encargado_nombre || row.encargado?.nombre,
    encargado_email: row.encargado_email || row.encargado?.email,
    trabajador_nombre: row.trabajador_nombre || row.trabajador?.nombre,
    trabajador_email: row.trabajador_email || row.trabajador?.email,
    tarea_nombre: row.tarea_nombre || row.tarea?.titulo || row.tarea?.nombre
  };
}

export async function createGroupLeaderRecord(payload) {
  const apiResult = await requestLocalApi("/api/group-leader/records", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (apiResult?.record) return apiResult.record;

  if (payload.marcas?.length) {
    throw new Error("El backend local debe estar activo para guardar la distribucion por marcas.");
  }

  const result = await db().from("registros_tareas_jefe_equipo").insert({
    encargado_id: payload.encargado_id,
    trabajador_id: payload.trabajador_id,
    tarea_id: payload.tarea_id,
    fecha_registro: payload.fecha_registro,
    cantidad: payload.cantidad,
    tiempo_minutos: payload.tiempo_minutos,
    numero_guia: payload.codigo_guia,
    lote: payload.lote,
    observacion: payload.detalle
  });
  if (result.error) throw result.error;
  return null;
}

export async function loadGroupLeaderContext() {
  const apiContext = await requestLocalApi("/api/group-leader/context");
  if (apiContext) {
    return {
      workers: apiContext.workers || [],
      tasks: apiContext.tasks || [],
      brands: apiContext.brands || [],
      leaders: apiContext.leaders || [],
      records: (apiContext.records || []).map(normalizeGroupLeaderLog)
    };
  }

  const [workers, tasks, brands, records] = await Promise.all([
    listAssignableWorkers(),
    listTasks().then((tasks) => tasks.filter(isGroupLeaderTimeTask)),
    listBrands(),
    listGroupLeaderRecords()
  ]);
  return { workers, tasks, brands, leaders: [], records };
}

export async function listGroupLeaderRecords(encargadoId = null) {
  const apiContext = await requestLocalApi("/api/group-leader/context");
  if (apiContext?.records) {
    const records = (apiContext.records || []).map(normalizeGroupLeaderLog);
    if (!encargadoId) return records;
    return records.filter((record) => String(record.encargado_id) === String(encargadoId));
  }

  let plainQuery = db().from("registros_tareas_jefe_equipo").select("*").order("created_at", { ascending: false });
  if (encargadoId) plainQuery = plainQuery.eq("encargado_id", encargadoId);
  const plainResult = await plainQuery;
  if (plainResult.error) throw plainResult.error;
  return (plainResult.data || []).map(normalizeGroupLeaderLog);
}
