import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const moduleUrl = import.meta.url;
const modulePath = moduleUrl ? fileURLToPath(moduleUrl) : "";
const __dirname = modulePath ? path.dirname(modulePath) : process.cwd();

function readEnv() {
  const envPath = path.join(__dirname, ".env");
  const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const env = {};

  for (const rawLine of envText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const name = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[name] = value;
  }

  return { ...process.env, ...env };
}

const env = readEnv();
const supabaseUrl = env.SUPABASE_URL;
const supabaseKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_PUBLISHABLE_KEY;
const sessionSecret = env.API_SESSION_SECRET || env.SUPABASE_SECRET_KEY;
const port = Number(env.API_PORT || 5180);
const distDir = path.join(__dirname, "dist");
const MAX_SCORE_QUANTITY = 99_999_999.99;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Faltan SUPABASE_URL y SUPABASE_SECRET_KEY en .env para el backend local.");
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

function sendJson(response, status, payload) {
  response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "authorization,content-type"
    });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        request.destroy();
        reject(new Error("Solicitud demasiado grande."));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function issueSessionToken(user) {
  if (!sessionSecret) return null;
  const payload = Buffer.from(
    JSON.stringify({ id: user.id, rol: normalizeRole(user.rol), exp: Date.now() + 8 * 60 * 60 * 1000 })
  ).toString("base64url");
  const signature = crypto.createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function readSession(request) {
  if (!sessionSecret) return null;
  const authorization = String(request.headers.authorization || "");
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const expected = crypto.createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number(session.exp) > Date.now() ? session : null;
  } catch {
    return null;
  }
}

function requireAdministrator(request, response) {
  if (!env.SUPABASE_SECRET_KEY) {
    sendJson(response, 503, { error: "El backend necesita SUPABASE_SECRET_KEY para administrar usuarios." });
    return false;
  }
  const session = readSession(request);
  if (!session || normalizeRole(session.rol) !== "administrador") {
    sendJson(response, 401, { error: "La sesion de administrador no es valida. Cierra sesion e ingresa nuevamente." });
    return false;
  }
  return true;
}

function requireSessionRole(request, response, allowedRoles) {
  const session = readSession(request);
  if (!session || !allowedRoles.includes(normalizeRole(session.rol))) {
    sendJson(response, 403, { error: "Tu sesión no tiene permiso para realizar esta operación." });
    return null;
  }
  return session;
}

async function handleLogin(request, response) {
  try {
    const rawBody = await readBody(request);
    const body = JSON.parse(rawBody || "{}");
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (!email || !password) {
      sendJson(response, 400, { error: "Completa usuario y contrasena." });
      return;
    }

    const result = await supabase
      .from("usuarios")
      .select("id,nombre,email,rol,activo,created_at,fecha_cumpleanos,sueldo")
      .eq("email", email)
      .eq("password_hash", password)
      .limit(1);

    if (result.error) {
      sendJson(response, 500, { error: result.error.message });
      return;
    }

    if (!result.data?.length) {
      sendJson(response, 401, { error: "Credenciales invalidas o usuario no existe." });
      return;
    }

    const user = result.data[0];
    if (!isActive(user.activo)) {
      sendJson(response, 423, {
        code: "ACCOUNT_BLOCKED",
        error: "Cuenta bloqueada. Tu usuario está inactivo y no puede ingresar. Contacta al administrador."
      });
      return;
    }
    sendJson(response, 200, { user, sessionToken: issueSessionToken(user) });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo iniciar sesion." });
  }
}

function normalizeRole(role) {
  const value = String(role || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return value === "trabajador" ? "operante" : value;
}

function isActive(value) {
  return !["false", "0", "no"].includes(String(value ?? true).trim().toLowerCase());
}

function taskTitle(task) {
  return String(task?.nombre || task?.titulo || "");
}

function isPairUnit(value) {
  const words = normalizeRole(value).split(/\s+/).filter(Boolean);
  return words.includes("par") || words.includes("pares");
}

function taskUsesStore(task) {
  const title = normalizeRole(taskTitle(task));
  const storeTaskNames = [
    "pedido mayorista",
    "visita de tienda",
    "picking",
    "apoyo tienda",
    "apoyo a tienda"
  ];
  return title.startsWith("revision de guia") ||
    storeTaskNames.some((taskName) => title === taskName || title.startsWith(`${taskName} `));
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isNaN(number) ? null : number;
}

function isPrimaryKeySequenceConflict(error) {
  return error?.code === "23505" && /Key \(id\)|_pkey/i.test(`${error?.details || ""} ${error?.message || ""}`);
}

function missingSchemaColumn(error) {
  return /Could not find the '([^']+)' column/i.exec(String(error?.message || ""))?.[1] || null;
}

async function nextTableId(tableName) {
  const result = await supabase.from(tableName).select("id").order("id", { ascending: false }).limit(1);
  if (result.error) throw result.error;
  return Number(result.data?.[0]?.id || 0) + 1;
}

async function insertCompatibleActivityRow(payload) {
  const candidate = { ...payload };
  let needsExplicitId = false;
  let result;
  for (let attempt = 0; attempt <= Object.keys(payload).length + 1; attempt += 1) {
    const row = needsExplicitId
      ? { ...candidate, id: await nextTableId("registros_tareas") }
      : candidate;
    result = await supabase.from("registros_tareas").insert(row).select("*").single();
    if (!result.error) return result;
    if (!needsExplicitId && isPrimaryKeySequenceConflict(result.error)) {
      needsExplicitId = true;
      continue;
    }
    const missingColumn = missingSchemaColumn(result.error);
    if (!missingColumn || !(missingColumn in candidate)) return result;
    delete candidate[missingColumn];
  }
  return result;
}

let taskTableName;

async function getTaskTableName() {
  if (taskTableName) return taskTableName;
  for (const candidate of ["tarea", "tareas"]) {
    const result = await supabase.from(candidate).select("id").limit(1);
    if (!result.error) {
      taskTableName = candidate;
      return candidate;
    }
  }
  throw new Error("No se encontro la tabla public.tarea ni public.tareas.");
}

function normalizeActivityLog(row) {
  const normalized = { ...row };
  if ("usuario_id" in normalized && !("trabajador_id" in normalized)) {
    normalized.trabajador_id = normalized.usuario_id;
  }
  if ("observacion" in normalized && !("detalle" in normalized)) {
    normalized.detalle = normalized.observacion;
  }
  if ("dato_extra" in normalized && !("tiempo_minutos" in normalized)) {
    const parsed = Number(normalized.dato_extra);
    normalized.tiempo_minutos = Number.isNaN(parsed) ? normalized.dato_extra : parsed;
  }
  if ("tarea" in normalized && !("actividad_nombre" in normalized)) {
    normalized.actividad_nombre = normalized.tarea;
  }
  return normalized;
}

function taskPayloadForDb(body, tableName) {
  const unit = body.unidad_medida ?? body.unidad_base;
  const requiresBrand = isPairUnit(unit) ? true : body.requiere_marca;
  const payload = tableName === "tarea"
    ? {
        nombre: body.nombre ?? body.titulo,
        activo: body.activo,
        unidad_medida: unit,
        tipo_tarea: body.tipo_tarea,
        requiere_marca: requiresBrand,
        requiere_tiempo: body.requiere_tiempo,
        requiere_lote: body.requiere_lote,
        requiere_numero_guia: body.requiere_numero_guia
      }
    : {
        nombre: body.nombre ?? body.titulo,
        tipo_medicion: body.tipo_medicion,
        activo: body.activo,
        requiere_dato_extra: body.requiere_dato_extra,
        nombre_dato_extra: body.nombre_dato_extra,
        puntaje_fijo: body.puntaje_fijo,
        puntos_turno_simple: body.puntos_turno_simple ?? body.puntaje_turno_simple,
        puntos_turno_completo: body.puntos_turno_completo ?? body.puntaje_turno_completo,
        tipo_tarea: body.tipo_tarea,
        requiere_marca: requiresBrand
      };

  if (payload.activo === undefined && body.estado !== undefined) {
    payload.activo = !["inactivo", "cerrado", "false", "0", "no"].includes(
      String(body.estado).trim().toLowerCase()
    );
  }

  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined && value !== "")
  );
}

async function selectUsers() {
  const [usersResult, movementsResult] = await Promise.all([
    supabase
      .from("usuarios")
      .select("id,nombre,email,rol,activo,created_at,fecha_cumpleanos,sueldo")
      .order("id", { ascending: true }),
    supabase
      .from("movimientos_personal")
      .select("id,usuario_id,tipo_movimiento,fecha_movimiento,created_at")
      .order("fecha_movimiento", { ascending: true })
      .order("id", { ascending: true })
  ]);
  if (usersResult.error) throw usersResult.error;
  if (movementsResult.error) throw movementsResult.error;

  const movementByUser = new Map();
  for (const movement of movementsResult.data || []) {
    const userId = Number(movement.usuario_id);
    const summary = movementByUser.get(userId) || { ingreso: null, salida: null };
    const type = normalizeRole(movement.tipo_movimiento);
    if (type === "ingreso") summary.ingreso = movement;
    if (type === "salida") summary.salida = movement;
    movementByUser.set(userId, summary);
  }

  return (usersResult.data || []).map((user) => {
    const summary = movementByUser.get(Number(user.id)) || {};
    const ingreso = summary.ingreso?.fecha_movimiento || null;
    const salida = summary.salida?.fecha_movimiento || null;
    return {
      ...user,
      fecha_ingreso: ingreso,
      fecha_salida: ingreso && salida && salida >= ingreso ? salida : null
    };
  });
}

function validateEmploymentDates(body) {
  const hasFields = body.fecha_ingreso !== undefined || body.fecha_salida !== undefined;
  if (!hasFields) return null;
  const ingreso = String(body.fecha_ingreso || "").trim();
  const salida = String(body.fecha_salida || "").trim();
  if (salida && !ingreso) throw new Error("La fecha de ingreso es obligatoria si registras una salida.");
  if (ingreso && !/^\d{4}-\d{2}-\d{2}$/.test(ingreso)) throw new Error("La fecha de ingreso no es valida.");
  if (salida && !/^\d{4}-\d{2}-\d{2}$/.test(salida)) throw new Error("La fecha de salida no es valida.");
  if (ingreso && salida && salida < ingreso) throw new Error("La fecha de salida no puede ser anterior a la fecha de ingreso.");
  return { ingreso, salida };
}

async function insertPersonnelMovement(payload) {
  let result = await supabase.from("movimientos_personal").insert(payload).select("*").single();
  if (isPrimaryKeySequenceConflict(result.error)) {
    result = await supabase
      .from("movimientos_personal")
      .insert({ ...payload, id: await nextTableId("movimientos_personal") })
      .select("*")
      .single();
  }
  if (result.error) throw result.error;
  return result.data;
}

async function saveEmploymentDates(userId, dates) {
  if (!dates || !dates.ingreso) return;
  const currentResult = await supabase
    .from("movimientos_personal")
    .select("id,tipo_movimiento,fecha_movimiento")
    .eq("usuario_id", userId)
    .order("fecha_movimiento", { ascending: false })
    .order("id", { ascending: false });
  if (currentResult.error) throw currentResult.error;

  const movements = currentResult.data || [];
  const latestIngreso = movements.find((item) => normalizeRole(item.tipo_movimiento) === "ingreso");
  const latestSalida = movements.find((item) => normalizeRole(item.tipo_movimiento) === "salida");
  const wasClosed = Boolean(
    latestIngreso && latestSalida && latestSalida.fecha_movimiento >= latestIngreso.fecha_movimiento
  );

  let ingresoMovement;
  if (latestIngreso && wasClosed && dates.ingreso > latestSalida.fecha_movimiento) {
    ingresoMovement = await insertPersonnelMovement({
      usuario_id: userId,
      tipo_movimiento: "Ingreso",
      fecha_movimiento: dates.ingreso
    });
  } else if (latestIngreso) {
    const updated = await supabase
      .from("movimientos_personal")
      .update({ fecha_movimiento: dates.ingreso })
      .eq("id", latestIngreso.id)
      .select("*")
      .single();
    if (updated.error) throw updated.error;
    ingresoMovement = updated.data;
  } else {
    ingresoMovement = await insertPersonnelMovement({
      usuario_id: userId,
      tipo_movimiento: "Ingreso",
      fecha_movimiento: dates.ingreso
    });
  }

  if (dates.salida) {
    const exitBelongsToCurrentPeriod = latestSalida && latestSalida.fecha_movimiento >= ingresoMovement.fecha_movimiento;
    if (exitBelongsToCurrentPeriod) {
      const updated = await supabase
        .from("movimientos_personal")
        .update({ fecha_movimiento: dates.salida })
        .eq("id", latestSalida.id);
      if (updated.error) throw updated.error;
    } else {
      await insertPersonnelMovement({
        usuario_id: userId,
        tipo_movimiento: "Salida",
        fecha_movimiento: dates.salida
      });
    }
  } else if (
    latestSalida &&
    latestIngreso &&
    Number(ingresoMovement.id) === Number(latestIngreso.id) &&
    latestSalida.fecha_movimiento >= latestIngreso.fecha_movimiento
  ) {
    const removed = await supabase.from("movimientos_personal").delete().eq("id", latestSalida.id);
    if (removed.error) throw removed.error;
  }
}

function userPayloadForDb(body, { creating = false } = {}) {
  let sueldo;
  if (body.sueldo !== undefined) {
    sueldo = Number(body.sueldo);
    if (!Number.isFinite(sueldo) || sueldo < 0 || sueldo > 9999999999.99) {
      throw new Error("El sueldo debe ser un monto valido mayor o igual a cero.");
    }
    sueldo = Math.round((sueldo + Number.EPSILON) * 100) / 100;
  }

  const payload = {
    nombre: body.nombre === undefined ? undefined : String(body.nombre).trim(),
    email: body.email === undefined ? undefined : String(body.email).trim().toLowerCase(),
    rol: body.rol === undefined ? undefined : normalizeRole(body.rol),
    activo: body.activo,
    fecha_cumpleanos:
      body.fecha_cumpleanos === undefined ? undefined : body.fecha_cumpleanos || null,
    sueldo,
    password_hash: body.password_hash === undefined ? undefined : String(body.password_hash)
  };

  if (creating && (!payload.nombre || !payload.email || !payload.password_hash)) {
    throw new Error("Nombre, usuario y contrasena son obligatorios.");
  }

  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}

function userMutationError(response, error, fallback) {
  if (error?.code === "23505") {
    sendJson(response, 409, { error: "Ya existe una cuenta con ese usuario o correo." });
    return;
  }
  if (error?.code === "23514") {
    sendJson(response, 400, { error: "El rol seleccionado no esta permitido por la base de datos." });
    return;
  }
  sendJson(response, 500, { error: error?.message || fallback });
}

async function handleCreateUser(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const payload = userPayloadForDb(body, { creating: true });
    let result = await supabase.from("usuarios").insert(payload).select("*").single();
    if (isPrimaryKeySequenceConflict(result.error)) {
      result = await supabase
        .from("usuarios")
        .insert({ ...payload, id: await nextTableId("usuarios") })
        .select("*")
        .single();
    }
    if (result.error) {
      userMutationError(response, result.error, "No se pudo crear el usuario.");
      return;
    }
    const { password_hash: _passwordHash, password: _password, ...user } = result.data;
    sendJson(response, 201, { user });
  } catch (error) {
    const status = error instanceof SyntaxError ? 400 : 400;
    sendJson(response, status, { error: error.message || "No se pudo crear el usuario." });
  }
}

async function handleUpdateUser(request, response, userId) {
  try {
    if (!requireAdministrator(request, response)) return;
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(response, 400, { error: "Usuario invalido." });
      return;
    }
    const body = JSON.parse((await readBody(request)) || "{}");
    const employmentDates = validateEmploymentDates(body);
    const payload = userPayloadForDb(body);
    if (employmentDates?.ingreso) payload.activo = !employmentDates.salida;
    if (!Object.keys(payload).length) {
      sendJson(response, 400, { error: "No hay cambios para guardar." });
      return;
    }
    const result = await supabase.from("usuarios").update(payload).eq("id", userId).select("*").maybeSingle();
    if (result.error) {
      userMutationError(response, result.error, "No se pudo actualizar el usuario.");
      return;
    }
    if (!result.data) {
      sendJson(response, 404, { error: "Usuario no encontrado." });
      return;
    }
    await saveEmploymentDates(userId, employmentDates);
    const { password_hash: _passwordHash, password: _password, ...user } = result.data;
    const refreshedUsers = await selectUsers();
    sendJson(response, 200, { user: refreshedUsers.find((item) => Number(item.id) === userId) || user });
  } catch (error) {
    sendJson(response, 400, { error: error.message || "No se pudo actualizar el usuario." });
  }
}

async function handleDeleteUser(_request, response, userId) {
  try {
    if (!requireAdministrator(_request, response)) return;
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(response, 400, { error: "Usuario invalido." });
      return;
    }
    const session = readSession(_request);
    if (Number(session?.id) === userId) {
      sendJson(response, 400, { error: "No puedes eliminar tu propia cuenta de administrador." });
      return;
    }
    const result = await supabase.from("usuarios").delete().eq("id", userId).select("id").maybeSingle();
    if (result.error) {
      if (result.error.code === "23503") {
        const archived = await supabase.from("usuarios").update({ activo: false }).eq("id", userId).select("id").maybeSingle();
        if (archived.error) {
          userMutationError(response, archived.error, "No se pudo desactivar el usuario.");
          return;
        }
        sendJson(response, 200, { deleted: false, archived: true });
        return;
      }
      userMutationError(response, result.error, "No se pudo eliminar el usuario.");
      return;
    }
    if (!result.data) {
      sendJson(response, 404, { error: "Usuario no encontrado." });
      return;
    }
    sendJson(response, 200, { deleted: true, archived: false });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo eliminar el usuario." });
  }
}

async function selectTasks() {
  const tableName = await getTaskTableName();
  const result = await supabase.from(tableName).select("*").order("id", { ascending: true });
  if (result.error) throw result.error;
  return result.data || [];
}

async function selectBrands() {
  const result = await supabase.from("marcas").select("id,nombre").order("nombre", { ascending: true });
  if (result.error) throw result.error;
  return result.data || [];
}

function isGroupLeaderTimeTask(task) {
  const timeTasks = new Set([
    "etiquetado",
    "envio nuevo",
    "visita de tienda",
    "picking",
    "embalado y rotulado de guia"
  ]);
  return timeTasks.has(normalizeRole(taskTitle(task)));
}

function isGuideBreakdownTask(task) {
  return normalizeRole(taskTitle(task)).startsWith("revision de guia");
}

function normalizedBrandItems(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.map((item) => {
    const marca_id = Number(item.marca_id);
    const cantidad = Number(item.cantidad);
    if (!marca_id || !Number.isFinite(cantidad) || cantidad <= 0) {
      throw new Error("Cada marca debe tener una cantidad mayor a cero.");
    }
    if (seen.has(marca_id)) throw new Error("No puedes repetir una marca en el mismo registro.");
    seen.add(marca_id);
    return { marca_id, cantidad };
  });
}

function normalizedGuideItems(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.map((item) => {
    const numero_guia = String(item.numero_guia || "").trim();
    const cantidad = Number(item.cantidad);
    if (!numero_guia || !Number.isFinite(cantidad) || cantidad <= 0) {
      throw new Error("Cada guía debe tener un número y una cantidad mayor a cero.");
    }
    const normalizedNumber = normalizeRole(numero_guia);
    if (seen.has(normalizedNumber)) throw new Error("No puedes repetir un número de guía en el mismo registro.");
    seen.add(normalizedNumber);
    return { numero_guia, cantidad };
  });
}

async function attachBrandBreakdown(rows) {
  if (!rows.length) return rows;
  const brands = await selectBrands();
  const brandName = new Map(brands.map((brand) => [Number(brand.id), brand.nombre]));
  return rows.map((row) => ({
    ...row,
    marcas: row.marca_id
      ? [{
          marca_id: Number(row.marca_id),
          cantidad: nullableNumber(row.cantidad),
          marca_nombre: brandName.get(Number(row.marca_id)) || `Marca ${row.marca_id}`
        }]
      : []
  }));
}

async function selectTaskScoreRanges(taskId = null) {
  let query = supabase.from("reglas_puntaje").select("*").order("puntos", { ascending: true });
  if (taskId) query = query.eq("tarea_id", taskId);
  const result = await query;
  if (result.error) throw result.error;
  return result.data || [];
}

async function selectActivityLogs(workerId = null) {
  const resources = [
    { table: "v_registro_actividades", userColumn: "usuario_id", orderColumn: "fecha_registro" },
    { table: "registros_tareas", userColumn: "usuario_id", orderColumn: "fecha_registro" }
  ];

  let lastError = null;
  for (const resource of resources) {
    let query = supabase.from(resource.table).select("*");
    if (workerId) query = query.eq(resource.userColumn, workerId);
    query = query.order(resource.orderColumn, { ascending: false });

    const result = await query;
    if (!result.error) {
      const rows = (result.data || []).map(normalizeActivityLog);
      return attachBrandBreakdown(rows);
    }
    lastError = result.error;
  }

  throw lastError || new Error("No se pudieron leer los registros de actividades.");
}

async function handleReadUsers(_request, response) {
  try {
    if (!requireAdministrator(_request, response)) return;
    sendJson(response, 200, { users: await selectUsers() });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudieron cargar los usuarios." });
  }
}

async function handleReadBrands(_request, response) {
  try {
    sendJson(response, 200, { brands: await selectBrands() });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudieron cargar las marcas." });
  }
}

async function handleReadTasks(_request, response) {
  try {
    sendJson(response, 200, { tasks: await selectTasks() });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudieron cargar las tareas." });
  }
}

async function handleCreateTask(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const tableName = await getTaskTableName();
    const payload = taskPayloadForDb(body, tableName);
    if (!String(payload.nombre || "").trim()) {
      sendJson(response, 400, { error: "El nombre de la tarea es obligatorio." });
      return;
    }

    let result = await supabase.from(tableName).insert(payload).select("*").single();
    if (isPrimaryKeySequenceConflict(result.error)) {
      result = await supabase
        .from(tableName)
        .insert({ ...payload, id: await nextTableId(tableName) })
        .select("*")
        .single();
    }
    if (result.error) {
      sendJson(response, 500, { error: result.error.message });
      return;
    }

    sendJson(response, 201, { task: result.data });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo crear la tarea." });
  }
}

async function handleUpdateTask(request, response, taskId) {
  try {
    if (!requireAdministrator(request, response)) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const tableName = await getTaskTableName();
    const payload = taskPayloadForDb(body, tableName);
    const result = await supabase.from(tableName).update(payload).eq("id", taskId).select("*").single();
    if (result.error) {
      sendJson(response, 500, { error: result.error.message });
      return;
    }

    sendJson(response, 200, { task: result.data });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo actualizar la tarea." });
  }
}

async function archiveTask(response, tableName, taskId) {
  const archived = await supabase
    .from(tableName)
    .update({ activo: false })
    .eq("id", taskId)
    .select("id")
    .maybeSingle();
  if (archived.error) throw archived.error;
  if (!archived.data) {
    sendJson(response, 404, { error: "Tarea no encontrada." });
    return false;
  }
  sendJson(response, 200, { deleted: false, archived: true });
  return true;
}

async function handleDeleteTask(request, response, taskId) {
  try {
    if (!requireAdministrator(request, response)) return;
    if (!Number.isInteger(taskId) || taskId <= 0) {
      sendJson(response, 400, { error: "Tarea invalida." });
      return;
    }

    const tableName = await getTaskTableName();
    const existing = await supabase.from(tableName).select("id").eq("id", taskId).maybeSingle();
    if (existing.error) throw existing.error;
    if (!existing.data) {
      sendJson(response, 404, { error: "Tarea no encontrada." });
      return;
    }

    const historyResults = await Promise.all([
      supabase.from("registros_tareas").select("id", { count: "exact", head: true }).eq("tarea_id", taskId),
      supabase.from("registros_tareas_jefe_equipo").select("id", { count: "exact", head: true }).eq("tarea_id", taskId),
      supabase.from("incidentes").select("id", { count: "exact", head: true }).eq("tarea_id", taskId)
    ]);
    const historyError = historyResults.find((result) => result.error)?.error;
    if (historyError) throw historyError;
    if (historyResults.some((result) => Number(result.count || 0) > 0)) {
      await archiveTask(response, tableName, taskId);
      return;
    }

    const previousRules = await selectTaskScoreRanges(taskId);
    const deleteRules = await supabase.from("reglas_puntaje").delete().eq("tarea_id", taskId);
    if (deleteRules.error) throw deleteRules.error;

    const result = await supabase.from(tableName).delete().eq("id", taskId).select("id").maybeSingle();
    if (result.error) {
      if (previousRules.length) await supabase.from("reglas_puntaje").insert(previousRules);
      if (result.error.code === "23503") {
        await archiveTask(response, tableName, taskId);
        return;
      }
      throw result.error;
    }
    if (!result.data) {
      sendJson(response, 404, { error: "Tarea no encontrada." });
      return;
    }
    sendJson(response, 200, { deleted: true, archived: false });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo eliminar la tarea." });
  }
}

async function handleReadTaskScoreRanges(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const taskId = url.searchParams.get("taskId");
    const rules = await selectTaskScoreRanges(taskId);
    sendJson(response, 200, { rules, ranges: rules });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudieron cargar los rangos." });
  }
}

async function handleReplaceTaskScoreRanges(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const taskId = Number(body.taskId || body.tarea_id);
    const rules = Array.isArray(body.rules) ? body.rules : Array.isArray(body.ranges) ? body.ranges : [];
    if (!taskId) {
      sendJson(response, 400, { error: "La tarea es obligatoria." });
      return;
    }

    const normalized = rules.map((item) => ({
      tarea_id: taskId,
      tipo_regla: String(item.tipo_regla || "CANTIDAD").trim().toUpperCase(),
      desde: nullableNumber(item.desde ?? item.cantidad_desde),
      hasta: nullableNumber(item.hasta ?? item.cantidad_hasta),
      turno: item.turno ? String(item.turno).trim() : null,
      puntos: nullableNumber(item.puntos)
    }));
    const invalid = normalized.find((rule) => (
      !["CANTIDAD", "FIJO", "TURNO"].includes(rule.tipo_regla) ||
      !Number.isInteger(rule.puntos) || rule.puntos < 1 || rule.puntos > 10 ||
      (rule.tipo_regla === "CANTIDAD" && (
        rule.desde === null || rule.desde < 0 || rule.desde > MAX_SCORE_QUANTITY
      )) ||
      (rule.hasta !== null && (
        rule.desde === null || rule.hasta < rule.desde || rule.hasta > MAX_SCORE_QUANTITY
      ))
    ));
    if (invalid) {
      sendJson(response, 400, {
        error: "Hay una regla invalida. Los rangos deben estar entre 0 y 99,999,999.99 y el puntaje entre 1 y 10."
      });
      return;
    }

    const previousRules = await selectTaskScoreRanges(taskId);
    const deleteResult = await supabase.from("reglas_puntaje").delete().eq("tarea_id", taskId);
    if (deleteResult.error) {
      sendJson(response, 500, { error: deleteResult.error.message });
      return;
    }

    if (normalized.length) {
      let insertResult = await supabase.from("reglas_puntaje").insert(normalized);
      if (isPrimaryKeySequenceConflict(insertResult.error)) {
        const firstId = await nextTableId("reglas_puntaje");
        insertResult = await supabase.from("reglas_puntaje").insert(
          normalized.map((rule, index) => ({ ...rule, id: firstId + index }))
        );
      }
      if (insertResult.error) {
        const rollback = previousRules.map(({ id: _id, ...rule }) => rule);
        if (rollback.length) await supabase.from("reglas_puntaje").insert(rollback);
        sendJson(response, 500, { error: insertResult.error.message });
        return;
      }
    }

    const savedRules = await selectTaskScoreRanges(taskId);
    sendJson(response, 200, { rules: savedRules, ranges: savedRules });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudieron guardar los rangos." });
  }
}

async function handleDeleteTaskScoreRanges(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const url = new URL(request.url, `http://${request.headers.host}`);
    const taskId = Number(url.searchParams.get("taskId"));
    if (!taskId) {
      sendJson(response, 400, { error: "La tarea es obligatoria." });
      return;
    }
    const result = await supabase.from("reglas_puntaje").delete().eq("tarea_id", taskId);
    if (result.error) {
      sendJson(response, 500, { error: result.error.message });
      return;
    }
    sendJson(response, 200, { ok: true });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudieron eliminar los rangos." });
  }
}

async function handleReadStores(request, response) {
  try {
    if (!requireSessionRole(request, response, ["administrador", "operante", "jefe de equipo", "jefe de grupo"])) return;
    const result = await supabase.from("tiendas").select("*").order("id", { ascending: true });
    if (result.error) throw result.error;
    sendJson(response, 200, { stores: result.data || [] });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudieron cargar las tiendas." });
  }
}

async function handleCreateStore(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const payload = { nombre: String(body.nombre || "").trim(), activo: body.activo !== false };
    if (!payload.nombre) {
      sendJson(response, 400, { error: "El nombre de la tienda es obligatorio." });
      return;
    }
    let result = await supabase.from("tiendas").insert(payload).select("*").single();
    if (isPrimaryKeySequenceConflict(result.error)) {
      result = await supabase.from("tiendas").insert({ ...payload, id: await nextTableId("tiendas") }).select("*").single();
    }
    if (result.error) {
      userMutationError(response, result.error, "No se pudo crear la tienda.");
      return;
    }
    sendJson(response, 201, { store: result.data });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo crear la tienda." });
  }
}

async function handleUpdateStore(request, response, storeId) {
  try {
    if (!requireAdministrator(request, response)) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const payload = {};
    if (body.nombre !== undefined) payload.nombre = String(body.nombre).trim();
    if (body.activo !== undefined) payload.activo = Boolean(body.activo);
    if (payload.nombre === "") {
      sendJson(response, 400, { error: "El nombre de la tienda es obligatorio." });
      return;
    }
    const result = await supabase.from("tiendas").update(payload).eq("id", storeId).select("*").maybeSingle();
    if (result.error) {
      userMutationError(response, result.error, "No se pudo actualizar la tienda.");
      return;
    }
    if (!result.data) {
      sendJson(response, 404, { error: "Tienda no encontrada." });
      return;
    }
    sendJson(response, 200, { store: result.data });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo actualizar la tienda." });
  }
}

async function handleDeleteStore(request, response, storeId) {
  try {
    if (!requireAdministrator(request, response)) return;
    const result = await supabase.from("tiendas").delete().eq("id", storeId).select("id").maybeSingle();
    if (result.error?.code === "23503") {
      const archived = await supabase.from("tiendas").update({ activo: false }).eq("id", storeId).select("id").maybeSingle();
      if (archived.error) throw archived.error;
      sendJson(response, 200, { deleted: false, archived: true });
      return;
    }
    if (result.error) throw result.error;
    if (!result.data) {
      sendJson(response, 404, { error: "Tienda no encontrada." });
      return;
    }
    sendJson(response, 200, { deleted: true, archived: false });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo eliminar la tienda." });
  }
}

async function handleReadAttendances(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const url = new URL(request.url, `http://${request.headers.host}`);
    let query = supabase.from("asistencias").select("*").order("fecha", { ascending: false });
    if (url.searchParams.get("date")) query = query.eq("fecha", url.searchParams.get("date"));
    const result = await query;
    if (result.error) throw result.error;
    sendJson(response, 200, { attendances: result.data || [] });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo cargar la asistencia." });
  }
}

async function handleMarkAttendance(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const userId = Number(body.usuario_id);
    const date = String(body.fecha || "").trim();
    if (!Number.isInteger(userId) || userId <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      sendJson(response, 400, { error: "Usuario y fecha de asistencia son obligatorios." });
      return;
    }
    const present = body.presente !== false;
    const payload = {
      usuario_id: userId,
      fecha: date,
      estado: present ? "Presente" : "Ausente",
      created_at: present ? new Date().toISOString() : null
    };
    let result = await supabase
      .from("asistencias")
      .upsert(payload, { onConflict: "usuario_id,fecha" })
      .select("*")
      .single();
    if (isPrimaryKeySequenceConflict(result.error)) {
      result = await supabase
        .from("asistencias")
        .upsert({ ...payload, id: await nextTableId("asistencias") }, { onConflict: "usuario_id,fecha" })
        .select("*")
        .single();
    }
    if (result.error) throw result.error;
    sendJson(response, 200, { attendance: result.data });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo guardar la asistencia." });
  }
}

async function handleReadActivityLogs(request, response) {
  try {
    const session = requireSessionRole(request, response, ["administrador", "operante", "jefe de equipo", "jefe de grupo"]);
    if (!session) return;
    const url = new URL(request.url, `http://${request.headers.host}`);
    const workerId = url.searchParams.get("workerId");
    if (normalizeRole(session.rol) !== "administrador" && workerId && Number(workerId) !== Number(session.id)) {
      sendJson(response, 403, { error: "No puedes consultar los registros de otro usuario." });
      return;
    }
    sendJson(response, 200, { logs: await selectActivityLogs(workerId) });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudieron cargar los registros." });
  }
}

async function handleCreateActivityLog(request, response) {
  try {
    const session = requireSessionRole(request, response, ["operante", "jefe de equipo", "jefe de grupo"]);
    if (!session) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const submittedTime = body.tiempo_minutos ?? body.dato_extra;
    if (
      normalizeRole(session.rol) === "operante" &&
      submittedTime !== null &&
      submittedTime !== undefined &&
      submittedTime !== ""
    ) {
      sendJson(response, 403, { error: "El operante no puede registrar tiempo, horas ni minutos." });
      return;
    }
    const tableName = await getTaskTableName();
    const taskResult = await supabase.from(tableName).select("*").eq("id", Number(body.tarea_id)).maybeSingle();
    if (taskResult.error || !taskResult.data) {
      sendJson(response, 400, { error: "La tarea seleccionada no existe." });
      return;
    }
    const scoringRulesResult = await supabase
      .from("reglas_puntaje")
      .select("tipo_regla")
      .eq("tarea_id", Number(body.tarea_id));
    if (scoringRulesResult.error) {
      sendJson(response, 500, { error: scoringRulesResult.error.message });
      return;
    }
    const scoringTypes = new Set((scoringRulesResult.data || []).map((rule) => normalizeRole(rule.tipo_regla)));
    const requestedType = normalizeRole(body.tipo_medicion);
    const storesQuantity = !scoringTypes.has("fijo") && !scoringTypes.has("turno") &&
      !["fijo", "turno", "cumplimiento"].includes(requestedType);
    const isTimeTask = isGroupLeaderTimeTask(taskResult.data);
    const requiresStore = taskUsesStore(taskResult.data);
    if (isTimeTask && body.tiempo_minutos !== null && body.tiempo_minutos !== undefined && body.tiempo_minutos !== "") {
      sendJson(response, 403, { error: "El operante no puede registrar el tiempo. Debe hacerlo el jefe de equipo." });
      return;
    }
    const brandItems = normalizedBrandItems(body.marcas);
    const guideItems = normalizedGuideItems(body.guias);
    if (guideItems.length && !isGuideBreakdownTask(taskResult.data)) {
      sendJson(response, 400, { error: "La distribución por guías solo está disponible para Revisión de Guía." });
      return;
    }
    if (brandItems.length && guideItems.length) {
      sendJson(response, 400, { error: "No puedes distribuir el mismo registro por marcas y por guías a la vez." });
      return;
    }
    const brandTotal = brandItems.reduce((total, item) => total + item.cantidad, 0);
    const guideTotal = guideItems.reduce((total, item) => total + item.cantidad, 0);
    const requestedQuantity = storesQuantity ? nullableNumber(body.cantidad) : null;
    if (isTimeTask && (!requestedQuantity || requestedQuantity <= 0)) {
      sendJson(response, 400, { error: "Las tareas de tiempo también requieren una cantidad mayor a cero." });
      return;
    }
    if (brandItems.length && (!requestedQuantity || requestedQuantity <= 0 || requestedQuantity !== brandTotal)) {
      sendJson(response, 400, { error: `Las cantidades por marca deben sumar exactamente la cantidad total (${requestedQuantity || 0}).` });
      return;
    }
    if (guideItems.length && (!requestedQuantity || requestedQuantity <= 0 || requestedQuantity !== guideTotal)) {
      sendJson(response, 400, { error: `Las cantidades por guía deben sumar exactamente la cantidad total (${requestedQuantity || 0}).` });
      return;
    }
    const payload = {
      usuario_id: Number(session.id),
      tarea_id: Number(body.tarea_id),
      fecha_registro: body.fecha_registro ? String(body.fecha_registro) : new Date().toISOString().slice(0, 10),
      cantidad: requestedQuantity,
      turno: body.turno ? String(body.turno).trim() : null,
      cumplimiento: body.cumplimiento === undefined ? null : Boolean(body.cumplimiento),
      tienda_id: requiresStore ? nullableNumber(body.tienda_id) : null,
      numero_guia: body.numero_guia ? String(body.numero_guia).trim() : null,
      observacion: body.observacion || body.detalle ? String(body.observacion || body.detalle).trim() : null,
      puntos_obtenidos: nullableNumber(body.puntos_obtenidos) ?? 0
    };
    const requestedTime = nullableNumber(body.tiempo_minutos ?? body.dato_extra);
    if (!isTimeTask && requestedTime !== null) payload.tiempo_minutos = requestedTime;

    if (!payload.usuario_id || !payload.tarea_id) {
      sendJson(response, 400, { error: "Usuario y tarea son obligatorios." });
      return;
    }
    if (requiresStore && !payload.tienda_id) {
      sendJson(response, 400, { error: `La tienda es obligatoria para ${taskTitle(taskResult.data)}.` });
      return;
    }
    if (payload.tienda_id) {
      const storeResult = await supabase
        .from("tiendas")
        .select("id,activo")
        .eq("id", payload.tienda_id)
        .maybeSingle();
      if (storeResult.error || !storeResult.data || !isActive(storeResult.data.activo)) {
        sendJson(response, 400, { error: "Selecciona una tienda activa y valida." });
        return;
      }
    }

    const insertedRows = [];
    const rowsToInsert = brandItems.length
      ? brandItems.map((item, index) => ({
          ...payload,
          cantidad: item.cantidad,
          marca_id: item.marca_id,
          puntos_obtenidos: index === 0 ? payload.puntos_obtenidos : 0
        }))
      : guideItems.length
        ? guideItems.map((item, index) => ({
            ...payload,
            cantidad: item.cantidad,
            numero_guia: item.numero_guia,
            puntos_obtenidos: index === 0 ? payload.puntos_obtenidos : 0
          }))
      : [payload];

    for (const row of rowsToInsert) {
      const result = await insertCompatibleActivityRow(row);
      if (result.error) {
        if (insertedRows.length) {
          await supabase.from("registros_tareas").delete().in("id", insertedRows.map((item) => item.id));
        }
        sendJson(response, 500, { error: result.error.message });
        return;
      }
      insertedRows.push(result.data);
    }

    const brands = brandItems.length ? await selectBrands() : [];
    const brandName = new Map(brands.map((brand) => [Number(brand.id), brand.nombre]));
    const log = {
      ...normalizeActivityLog(insertedRows[0]),
      cantidad: requestedQuantity,
      puntos_obtenidos: payload.puntos_obtenidos,
      guias: guideItems,
      marcas: brandItems.map((item) => ({
        ...item,
        marca_nombre: brandName.get(Number(item.marca_id)) || `Marca ${item.marca_id}`
      }))
    };
    sendJson(response, 201, { log });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo guardar el registro." });
  }
}

function enrichGroupRecords(records, users, tasks) {
  const userById = new Map(users.map((user) => [Number(user.id), user]));
  const taskById = new Map(tasks.map((task) => [Number(task.id), task]));

  return records.map((record) => {
    const encargado = userById.get(Number(record.encargado_id));
    const trabajador = userById.get(Number(record.trabajador_id));
    const task = taskById.get(Number(record.tarea_id));

    return {
      ...record,
      encargado_nombre: encargado?.nombre || encargado?.email || "",
      encargado_email: encargado?.email || "",
      trabajador_nombre: trabajador?.nombre || trabajador?.email || "",
      trabajador_email: trabajador?.email || "",
      tarea_nombre: record.tarea_nombre || taskTitle(task) || `Tarea ${record.tarea_id}`
    };
  });
}

async function loadGroupLeaderData() {
  const tableName = await getTaskTableName();
  const [usersResult, tasksResult, recordsResult] = await Promise.all([
    supabase.from("usuarios").select("id,nombre,email,rol,activo").order("id", { ascending: true }),
    supabase.from(tableName).select("*").order("id", { ascending: true }),
    supabase
      .from("registros_tareas_jefe_equipo")
      .select("id,encargado_id,trabajador_id,tarea_id,fecha_registro,cantidad,tiempo_minutos,numero_guia,lote,observacion,created_at")
      .order("created_at", { ascending: false })
  ]);

  if (usersResult.error) throw usersResult.error;
  if (tasksResult.error) throw tasksResult.error;
  if (recordsResult.error) throw recordsResult.error;

  const users = usersResult.data || [];
  const tasks = (tasksResult.data || []).filter((task) => isActive(task.activo) && isGroupLeaderTimeTask(task));
  const workers = users.filter((user) => normalizeRole(user.rol) === "operante" && isActive(user.activo));
  const leaders = users.filter((user) => ["jefe de equipo", "jefe de grupo"].includes(normalizeRole(user.rol)) && isActive(user.activo));
  const records = enrichGroupRecords(
    (recordsResult.data || []).map((record) => ({
      ...record,
      codigo_guia: record.numero_guia,
      detalle: record.observacion
    })),
    users,
    tasksResult.data || []
  );

  return { workers, tasks, leaders, records };
}

async function handleGroupLeaderContext(request, response) {
  try {
    if (!requireSessionRole(request, response, ["jefe de equipo", "jefe de grupo"])) return;
    const data = await loadGroupLeaderData();
    sendJson(response, 200, data);
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudieron cargar los datos." });
  }
}

async function handleCreateGroupLeaderRecord(request, response) {
  try {
    const session = requireSessionRole(request, response, ["jefe de equipo", "jefe de grupo"]);
    if (!session) return;
    const rawBody = await readBody(request);
    const body = JSON.parse(rawBody || "{}");
    const taskId = Number(body.tarea_id);
    const workerId = Number(body.trabajador_id);
    if (!Number.isInteger(taskId) || taskId <= 0 || !Number.isInteger(workerId) || workerId <= 0) {
      sendJson(response, 400, { error: "Operante y tarea son obligatorios." });
      return;
    }

    const tableName = await getTaskTableName();
    const taskResult = await supabase
      .from(tableName)
      .select("*")
      .eq("id", taskId)
      .maybeSingle();
    if (taskResult.error || !taskResult.data || !isGroupLeaderTimeTask(taskResult.data)) {
      sendJson(response, 400, { error: "Selecciona una tarea por tiempo válida." });
      return;
    }
    if (!isActive(taskResult.data.activo)) {
      sendJson(response, 400, { error: "La tarea seleccionada no está activa." });
      return;
    }
    const workerResult = await supabase
      .from("usuarios")
      .select("id,rol,activo")
      .eq("id", workerId)
      .maybeSingle();
    if (
      workerResult.error ||
      !workerResult.data ||
      normalizeRole(workerResult.data.rol) !== "operante" ||
      !isActive(workerResult.data.activo)
    ) {
      sendJson(response, 400, { error: "Selecciona un operante activo." });
      return;
    }

    const requestedQuantity = Number(body.cantidad);
    const requestedMinutes = Number(body.tiempo_minutos);
    if (!Number.isInteger(requestedQuantity) || requestedQuantity <= 0) {
      sendJson(response, 400, { error: "La cantidad debe ser un número entero mayor a cero." });
      return;
    }
    if (!Number.isInteger(requestedMinutes) || requestedMinutes <= 0) {
      sendJson(response, 400, { error: "El tiempo debe ser una cantidad entera de minutos mayor a cero." });
      return;
    }
    const payload = {
      encargado_id: Number(session.id),
      trabajador_id: workerId,
      tarea_id: taskId,
      fecha_registro: body.fecha_registro ? String(body.fecha_registro) : new Date().toISOString().slice(0, 10),
      cantidad: requestedQuantity,
      tiempo_minutos: requestedMinutes,
      numero_guia: body.codigo_guia ? String(body.codigo_guia).trim() : null,
      lote: body.lote ? String(body.lote).trim().toUpperCase() : null,
      observacion: body.detalle ? String(body.detalle).trim() : null
    };

    if (!payload.encargado_id || !payload.trabajador_id || !payload.tarea_id) {
      sendJson(response, 400, { error: "Encargado, trabajador y tarea son obligatorios." });
      return;
    }

    let result = await supabase
      .from("registros_tareas_jefe_equipo")
      .insert(payload)
      .select("id,encargado_id,trabajador_id,tarea_id,fecha_registro,cantidad,tiempo_minutos,numero_guia,lote,observacion,created_at")
      .single();

    if (isPrimaryKeySequenceConflict(result.error)) {
      result = await supabase
        .from("registros_tareas_jefe_equipo")
        .insert({ ...payload, id: await nextTableId("registros_tareas_jefe_equipo") })
        .select("id,encargado_id,trabajador_id,tarea_id,fecha_registro,cantidad,tiempo_minutos,numero_guia,lote,observacion,created_at")
        .single();
    }

    if (result.error) {
      sendJson(response, 500, { error: result.error.message });
      return;
    }

    const data = await loadGroupLeaderData();
    const record = data.records.find((item) => Number(item.id) === Number(result.data.id)) || result.data;
    sendJson(response, 201, { record });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo guardar el registro." });
  }
}

async function loadIncidentData() {
  const tableName = await getTaskTableName();
  const [usersResult, tasksResult, storesResult, incidentsResult] = await Promise.all([
    supabase.from("usuarios").select("id,nombre,email,rol,activo").order("id", { ascending: true }),
    supabase.from(tableName).select("id,nombre,activo").order("id", { ascending: true }),
    supabase.from("tiendas").select("id,nombre,activo").order("id", { ascending: true }),
    supabase
      .from("incidentes")
      .select("id,turno,nombre,tarea_id,tarea_nombre,tienda_id,numero_guia,observacion,tipo_error,created_by,created_at,usuario_id")
      .order("created_at", { ascending: false })
  ]);

  if (usersResult.error) throw usersResult.error;
  if (tasksResult.error) throw tasksResult.error;
  if (storesResult.error) throw storesResult.error;
  if (incidentsResult.error) throw incidentsResult.error;

  const stores = (storesResult.data || []).filter((store) => isActive(store.activo));
  const storeNames = new Map((storesResult.data || []).map((store) => [Number(store.id), store.nombre]));
  const incidents = (incidentsResult.data || []).map((incident) => ({
    ...incident,
    tienda_nombre: storeNames.get(Number(incident.tienda_id)) || ""
  }));

  return {
    workers: (usersResult.data || []).filter(
      (user) => normalizeRole(user.rol) === "operante" && isActive(user.activo)
    ),
    tasks: (tasksResult.data || []).filter((task) => isActive(task.activo)),
    stores,
    incidents
  };
}

async function handleIncidentContext(request, response) {
  try {
    if (!requireSessionRole(request, response, ["jefe de equipo", "jefe de grupo"])) return;
    sendJson(response, 200, await loadIncidentData());
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudieron cargar las incidencias." });
  }
}

async function handleCreateIncident(request, response) {
  try {
    const session = requireSessionRole(request, response, ["jefe de equipo", "jefe de grupo"]);
    if (!session) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const workerId = Number(body.usuario_id);
    const taskId = Number(body.tarea_id);
    const storeId = Number(body.tienda_id);
    const turno = String(body.turno || "").trim().toLowerCase();
    const guideNumber = String(body.numero_guia || "").trim();
    const errorType = String(body.tipo_error || "").trim().toUpperCase();

    if (![workerId, taskId, storeId].every((id) => Number.isInteger(id) && id > 0)) {
      sendJson(response, 400, { error: "Operante, tarea y tienda son obligatorios." });
      return;
    }
    if (!turno || !guideNumber || !errorType) {
      sendJson(response, 400, { error: "Turno, número de guía y tipo de error son obligatorios." });
      return;
    }
    if (!["CONTENIDO", "LIBERADO"].includes(errorType)) {
      sendJson(response, 400, { error: "El tipo de error debe ser CONTENIDO o LIBERADO." });
      return;
    }
    if (!["turno regular", "incidencia", "turno extra"].includes(turno)) {
      sendJson(response, 400, { error: "Selecciona un turno valido." });
      return;
    }

    const tableName = await getTaskTableName();
    const [workerResult, taskResult, storeResult] = await Promise.all([
      supabase.from("usuarios").select("id,nombre,email,rol,activo").eq("id", workerId).maybeSingle(),
      supabase.from(tableName).select("id,nombre,activo").eq("id", taskId).maybeSingle(),
      supabase.from("tiendas").select("id,nombre,activo").eq("id", storeId).maybeSingle()
    ]);

    const worker = workerResult.data;
    const task = taskResult.data;
    const store = storeResult.data;
    if (workerResult.error || !worker || normalizeRole(worker.rol) !== "operante" || !isActive(worker.activo)) {
      sendJson(response, 400, { error: "Selecciona un operante activo." });
      return;
    }
    if (taskResult.error || !task || !isActive(task.activo)) {
      sendJson(response, 400, { error: "Selecciona una tarea activa." });
      return;
    }
    if (storeResult.error || !store || !isActive(store.activo)) {
      sendJson(response, 400, { error: "Selecciona una tienda activa." });
      return;
    }

    const payload = {
      turno,
      nombre: worker.nombre || worker.email || `Usuario ${worker.id}`,
      tarea_id: task.id,
      tarea_nombre: taskTitle(task),
      tienda_id: store.id,
      numero_guia: guideNumber,
      observacion: body.observacion ? String(body.observacion).trim() : null,
      tipo_error: errorType,
      created_by: Number(session.id),
      usuario_id: worker.id
    };
    let result = await supabase.from("incidentes").insert(payload).select("*").single();
    if (isPrimaryKeySequenceConflict(result.error)) {
      result = await supabase
        .from("incidentes")
        .insert({ ...payload, id: await nextTableId("incidentes") })
        .select("*")
        .single();
    }
    if (result.error) {
      sendJson(response, 500, { error: result.error.message });
      return;
    }
    sendJson(response, 201, { incident: { ...result.data, tienda_nombre: store.nombre } });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo guardar la incidencia." });
  }
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".mp4": "video/mp4",
    ".svg": "image/svg+xml"
  };
  return types[extension] || "application/octet-stream";
}

function serveStatic(request, response) {
  if (!fs.existsSync(distDir)) {
    sendJson(response, 404, { error: "Ejecuta npm.cmd run build antes de usar npm.cmd start." });
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host}`);
  const requestedPath = decodeURIComponent(url.pathname);
  const safePath = requestedPath === "/" ? "index.html" : requestedPath.replace(/^\/+/, "");
  let filePath = path.resolve(distDir, safePath);

  if (!filePath.startsWith(distDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(distDir, "index.html");
  }

  response.writeHead(200, { "content-type": contentTypeFor(filePath) });
  fs.createReadStream(filePath).pipe(response);
}

export async function handleRequest(request, response, { serveFiles = true } = {}) {
  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  if (request.url?.startsWith("/api/login") && request.method === "POST") {
    await handleLogin(request, response);
    return;
  }

  if (request.url?.startsWith("/api/users") && request.method === "GET") {
    await handleReadUsers(request, response);
    return;
  }

  if (request.url?.startsWith("/api/brands") && request.method === "GET") {
    await handleReadBrands(request, response);
    return;
  }

  if (request.url?.startsWith("/api/users/") && ["PATCH", "DELETE"].includes(request.method)) {
    const userId = Number(new URL(request.url, `http://${request.headers.host}`).pathname.split("/").pop());
    if (request.method === "PATCH") await handleUpdateUser(request, response, userId);
    else await handleDeleteUser(request, response, userId);
    return;
  }

  if (request.url?.startsWith("/api/users") && request.method === "POST") {
    await handleCreateUser(request, response);
    return;
  }

  if (request.url?.startsWith("/api/tasks/") && ["PATCH", "DELETE"].includes(request.method)) {
    const taskId = Number(new URL(request.url, `http://${request.headers.host}`).pathname.split("/").pop());
    if (request.method === "PATCH") await handleUpdateTask(request, response, taskId);
    else await handleDeleteTask(request, response, taskId);
    return;
  }

  if (request.url?.startsWith("/api/tasks") && request.method === "GET") {
    await handleReadTasks(request, response);
    return;
  }

  if (request.url?.startsWith("/api/tasks") && request.method === "POST") {
    await handleCreateTask(request, response);
    return;
  }

  if (request.url?.startsWith("/api/task-score-ranges") && request.method === "GET") {
    await handleReadTaskScoreRanges(request, response);
    return;
  }

  if (request.url?.startsWith("/api/task-score-ranges") && request.method === "PUT") {
    await handleReplaceTaskScoreRanges(request, response);
    return;
  }

  if (request.url?.startsWith("/api/task-score-ranges") && request.method === "DELETE") {
    await handleDeleteTaskScoreRanges(request, response);
    return;
  }

  if (request.url?.startsWith("/api/stores/") && ["PATCH", "DELETE"].includes(request.method)) {
    const storeId = Number(new URL(request.url, `http://${request.headers.host}`).pathname.split("/").pop());
    if (request.method === "PATCH") await handleUpdateStore(request, response, storeId);
    else await handleDeleteStore(request, response, storeId);
    return;
  }

  if (request.url?.startsWith("/api/stores") && request.method === "GET") {
    await handleReadStores(request, response);
    return;
  }

  if (request.url?.startsWith("/api/stores") && request.method === "POST") {
    await handleCreateStore(request, response);
    return;
  }

  if (request.url?.startsWith("/api/attendances") && request.method === "GET") {
    await handleReadAttendances(request, response);
    return;
  }

  if (request.url?.startsWith("/api/attendances") && request.method === "PUT") {
    await handleMarkAttendance(request, response);
    return;
  }

  if (request.url?.startsWith("/api/activity-logs") && request.method === "GET") {
    await handleReadActivityLogs(request, response);
    return;
  }

  if (request.url?.startsWith("/api/activity-logs") && request.method === "POST") {
    await handleCreateActivityLog(request, response);
    return;
  }

  if (request.url?.startsWith("/api/group-leader/context") && request.method === "GET") {
    await handleGroupLeaderContext(request, response);
    return;
  }

  if (request.url?.startsWith("/api/group-leader/records") && request.method === "POST") {
    await handleCreateGroupLeaderRecord(request, response);
    return;
  }

  if (request.url?.startsWith("/api/incidents/context") && request.method === "GET") {
    await handleIncidentContext(request, response);
    return;
  }

  if (request.url?.startsWith("/api/incidents") && request.method === "POST") {
    await handleCreateIncident(request, response);
    return;
  }

  if (serveFiles) serveStatic(request, response);
  else sendJson(response, 404, { error: "Ruta de API no encontrada." });
}

const isMainModule = modulePath && process.argv[1] && path.resolve(process.argv[1]) === modulePath;
if (isMainModule) {
  const server = http.createServer((request, response) => handleRequest(request, response));
  server.listen(port, "127.0.0.1", () => {
    console.log(`Servidor local listo en http://127.0.0.1:${port}`);
  });
}
