import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

function readEnv() {
  return Object.fromEntries(
    fs.readFileSync(".env", "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "")];
      })
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const env = readEnv();
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const origin = `http://127.0.0.1:${process.env.API_PORT || env.API_PORT || 5180}`;
const marker = `__smoke_${Date.now()}`;
const cleanup = { userIds: [], storeIds: [], taskIds: [], movementIds: [], attendanceUserIds: [] };
const checks = [];

async function api(path, options = {}) {
  const response = await fetch(`${origin}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function nextId(table) {
  const result = await db.from(table).select("id").order("id", { ascending: false }).limit(1);
  if (result.error) throw result.error;
  return Number(result.data?.[0]?.id || 0) + 1;
}

const adminResult = await db
  .from("usuarios")
  .select("id,email,password_hash")
  .eq("rol", "administrador")
  .eq("activo", true)
  .order("id", { ascending: false })
  .limit(1)
  .single();
if (adminResult.error) throw adminResult.error;

const login = await api("/api/login", {
  method: "POST",
  body: JSON.stringify({ email: adminResult.data.email, password: adminResult.data.password_hash })
});
assert(login.response.ok && login.payload.sessionToken, "Fallo el inicio de sesion administrativo.");
const auth = { authorization: `Bearer ${login.payload.sessionToken}` };

try {
  for (const [name, path, key, minimum] of [
    ["usuarios", "/api/users", "users", 1],
    ["tareas", "/api/tasks", "tasks", 1],
    ["reglas", "/api/task-score-ranges", "rules", 1],
    ["tiendas", "/api/stores", "stores", 1],
    ["asistencias", "/api/attendances", "attendances", 1],
    ["puntos", "/api/activity-logs", "logs", 0]
  ]) {
    const result = await api(path, { headers: auth });
    assert(result.response.ok && Array.isArray(result.payload[key]), `Fallo la lectura de ${name}.`);
    assert(result.payload[key].length >= minimum, `${name} no devolvio los datos esperados.`);
    checks.push(`lectura ${name}`);
  }

  const selfDelete = await api(`/api/users/${adminResult.data.id}`, { method: "DELETE", headers: auth });
  assert(selfDelete.response.status === 400, "La proteccion de la cuenta administradora no respondio correctamente.");
  checks.push("proteccion de cuenta administradora");

  const createdUser = await api("/api/users", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      nombre: `${marker}_usuario`,
      email: `${marker}_usuario`,
      password_hash: "temporal-1",
      rol: "operante",
      activo: true,
      fecha_cumpleanos: "2000-01-01",
      sueldo: 1250.5
    })
  });
  assert(
    createdUser.response.ok &&
      createdUser.payload.user?.id &&
      Number(createdUser.payload.user?.sueldo) === 1250.5,
    "No se pudo crear el usuario temporal con sueldo."
  );
  const userId = Number(createdUser.payload.user.id);
  cleanup.userIds.push(userId);

  const updatedUser = await api(`/api/users/${userId}`, {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({
      nombre: `${marker}_editado`,
      email: `${marker}_editado`,
      password_hash: "temporal-2",
      activo: true,
      sueldo: 1425.75
    })
  });
  assert(
    updatedUser.response.ok &&
      updatedUser.payload.user?.nombre === `${marker}_editado` &&
      Number(updatedUser.payload.user?.sueldo) === 1425.75,
    `No se pudo editar el usuario y su sueldo: ${JSON.stringify(updatedUser.payload)}`
  );
  const editedLogin = await api("/api/login", {
    method: "POST",
    body: JSON.stringify({ email: `${marker}_editado`, password: "temporal-2" })
  });
  assert(editedLogin.response.ok, "El usuario editado no pudo iniciar sesion.");
  checks.push("crear y editar usuario");

  const attendanceDate = "2099-12-30";
  const markedPresent = await api("/api/attendances", {
    method: "PUT",
    headers: auth,
    body: JSON.stringify({ usuario_id: userId, fecha: attendanceDate, presente: true })
  });
  assert(markedPresent.response.ok && markedPresent.payload.attendance?.estado === "Presente", "No se pudo marcar presente.");
  cleanup.attendanceUserIds.push(userId);
  const markedAbsent = await api("/api/attendances", {
    method: "PUT",
    headers: auth,
    body: JSON.stringify({ usuario_id: userId, fecha: attendanceDate, presente: false })
  });
  assert(markedAbsent.response.ok && markedAbsent.payload.attendance?.estado === "Ausente", "No se pudo actualizar a ausente.");
  const attendanceRead = await api(`/api/attendances?date=${attendanceDate}`, { headers: auth });
  assert(attendanceRead.payload.attendances?.some((row) => Number(row.usuario_id) === userId), "No se leyo la asistencia guardada.");
  checks.push("crear, editar y leer asistencia");

  await db.from("asistencias").delete().eq("usuario_id", userId).eq("fecha", attendanceDate);
  cleanup.attendanceUserIds = cleanup.attendanceUserIds.filter((id) => id !== userId);
  const deletedUser = await api(`/api/users/${userId}`, { method: "DELETE", headers: auth });
  assert(deletedUser.response.ok && deletedUser.payload.deleted === true, "No se pudo eliminar un usuario sin historial.");
  cleanup.userIds = cleanup.userIds.filter((id) => id !== userId);
  checks.push("eliminar usuario sin historial");

  const archiveUser = await api("/api/users", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ nombre: `${marker}_archivo`, email: `${marker}_archivo`, password_hash: "temporal", rol: "operante", activo: true })
  });
  assert(archiveUser.response.ok && archiveUser.payload.user?.id, "No se creo el usuario para probar archivado.");
  const archiveUserId = Number(archiveUser.payload.user.id);
  cleanup.userIds.push(archiveUserId);
  const movementId = await nextId("movimientos_personal");
  const movement = await db.from("movimientos_personal").insert({
    id: movementId,
    usuario_id: archiveUserId,
    tipo_movimiento: "Ingreso",
    fecha_movimiento: "2099-12-29"
  });
  if (movement.error) throw movement.error;
  cleanup.movementIds.push(movementId);
  const archivedUser = await api(`/api/users/${archiveUserId}`, { method: "DELETE", headers: auth });
  assert(archivedUser.response.ok && archivedUser.payload.archived === true, "El usuario con historial no fue archivado.");
  const archivedRow = await db.from("usuarios").select("activo").eq("id", archiveUserId).single();
  assert(archivedRow.data?.activo === false, "El usuario archivado continuo activo.");
  checks.push("archivar usuario con historial");

  const createdStore = await api("/api/stores", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ nombre: `${marker}_tienda`, activo: true })
  });
  assert(createdStore.response.ok && createdStore.payload.store?.id, "No se pudo crear la tienda.");
  const storeId = Number(createdStore.payload.store.id);
  cleanup.storeIds.push(storeId);
  const updatedStore = await api(`/api/stores/${storeId}`, {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({ nombre: `${marker}_tienda_editada`, activo: false })
  });
  assert(updatedStore.response.ok && updatedStore.payload.store?.activo === false, "No se pudo editar la tienda.");
  const deletedStore = await api(`/api/stores/${storeId}`, { method: "DELETE", headers: auth });
  assert(deletedStore.response.ok && deletedStore.payload.deleted === true, "No se pudo eliminar la tienda temporal.");
  cleanup.storeIds = cleanup.storeIds.filter((id) => id !== storeId);
  checks.push("crear, editar y eliminar tienda");

  const createdTask = await api("/api/tasks", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      nombre: `${marker}_tarea`,
      activo: true,
      unidad_medida: "Pares",
      tipo_tarea: "General",
      requiere_marca: false,
      requiere_tiempo: false,
      requiere_lote: false,
      requiere_numero_guia: false
    })
  });
  assert(
    createdTask.response.ok &&
      createdTask.payload.task?.id &&
      createdTask.payload.task?.requiere_marca === true,
    `La tarea medida en pares no habilito marcas automaticamente: ${JSON.stringify(createdTask.payload)}`
  );
  const taskId = Number(createdTask.payload.task.id);
  cleanup.taskIds.push(taskId);
  const updatedTask = await api(`/api/tasks/${taskId}`, {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({ nombre: `${marker}_tarea_editada`, activo: true, unidad_medida: "Cajas", tipo_tarea: "Ingreso" })
  });
  assert(updatedTask.response.ok && updatedTask.payload.task?.nombre === `${marker}_tarea_editada`, "No se pudo editar la tarea.");
  const savedRule = await api("/api/task-score-ranges", {
    method: "PUT",
    headers: auth,
    body: JSON.stringify({ taskId, rules: [{ tipo_regla: "FIJO", desde: null, hasta: null, turno: null, puntos: 7 }] })
  });
  assert(savedRule.response.ok && savedRule.payload.rules?.[0]?.puntos === 7, "No se pudo guardar la regla de puntaje.");
  checks.push("crear y editar tarea con puntaje");

  console.log(JSON.stringify({ ok: true, checks, total: checks.length }, null, 2));
} finally {
  for (const id of cleanup.movementIds) await db.from("movimientos_personal").delete().eq("id", id);
  for (const id of cleanup.attendanceUserIds) await db.from("asistencias").delete().eq("usuario_id", id);
  for (const id of cleanup.taskIds) {
    await db.from("reglas_puntaje").delete().eq("tarea_id", id);
    await db.from("tarea").delete().eq("id", id);
  }
  for (const id of cleanup.storeIds) await db.from("tiendas").delete().eq("id", id);
  for (const id of cleanup.userIds) await db.from("usuarios").delete().eq("id", id);
}
