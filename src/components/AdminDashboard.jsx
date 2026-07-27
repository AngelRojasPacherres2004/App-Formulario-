import { useEffect, useMemo, useState } from "react";
import { Plus, RefreshCcw, Save, Trash2 } from "lucide-react";
import {
  createTask,
  createTienda,
  createUser,
  deleteTask,
  deleteTienda,
  deleteUser,
  friendlyError,
  getAttendanceForDate,
  listAllActivityLogs,
  listAttendances,
  listTasks,
  listTiendas,
  listWorkers,
  markAttendance,
  selectUsers,
  setTaskScoringRules,
  updateTask,
  updateTienda,
  updateUser
} from "../lib/repository";
import { birthdayMaxISO, formatDateTimeLima, todayLimaISO } from "../lib/dates";
import {
  displayShiftFromQuantity,
  emptyQuantityRanges,
  getActivityCaptureMode,
  getTaskTitle,
  isPairUnit,
  MAX_SCORE_QUANTITY,
  normalizeMeasurementType,
  normalizeRole,
  quantityRangesFromRules,
  validateQuantityRanges
} from "../lib/scoring";
import { useAsyncData } from "../lib/hooks";
import {
  Alert,
  Button,
  CheckboxInput,
  DataTable,
  FormActions,
  LoadingBlock,
  Metric,
  Panel,
  SelectInput,
  Tabs,
  TextArea,
  TextInput
} from "./ui";

const roleOptions = ["administrador", "operante", "jefe de equipo", "jefe de grupo", "otros"];
const taskTypes = ["cantidad", "fijo", "turno", "tiempo"];

export default function AdminDashboard({ section }) {
  if (section === "Usuarios") return <UsersPanel />;
  if (section === "Tareas") return <TasksPanel />;
  if (section === "Asistencia") return <AttendancePanel />;
  if (section === "Tiendas") return <StoresPanel />;
  return <WorkerPointsPanel />;
}

function boolValue(value) {
  return !["false", "0", "no"].includes(String(value ?? true).trim().toLowerCase());
}

function StatusAlert({ status }) {
  if (!status?.message) return null;
  return <Alert type={status.type}>{status.message}</Alert>;
}

function UsersPanel() {
  const { data: users = [], loading, error, reload } = useAsyncData(selectUsers, [], []);
  const [tab, setTab] = useState("Crear");
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [createForm, setCreateForm] = useState({
    nombre: "",
    email: "",
    password: "",
    fecha_cumpleanos: "",
    sueldo: "0.00",
    rol: "operante",
    activo: true
  });
  const [editId, setEditId] = useState("");
  const [editForm, setEditForm] = useState({
    nombre: "",
    email: "",
    fecha_cumpleanos: "",
    rol: "operante",
    activo: true,
    password: "",
    sueldo: "0.00",
    fecha_ingreso: "",
    fecha_salida: ""
  });

  const selectedUser = users.find((user) => String(user.id) === String(editId));

  useEffect(() => {
    if (!selectedUser) return;
    setEditForm({
      nombre: selectedUser.nombre || "",
      email: selectedUser.email || "",
      fecha_cumpleanos: selectedUser.fecha_cumpleanos || "",
      rol: normalizeRole(selectedUser.rol) || "operante",
      activo: boolValue(selectedUser.activo),
      password: "",
      sueldo: Number(selectedUser.sueldo || 0).toFixed(2),
      fecha_ingreso: selectedUser.fecha_ingreso || "",
      fecha_salida: selectedUser.fecha_salida || ""
    });
  }, [selectedUser?.id]);

  async function handleCreate(event) {
    event.preventDefault();
    setStatus(null);
    if (!createForm.nombre.trim() || !createForm.email.trim() || !createForm.password) {
      setStatus({ type: "error", message: "Nombre, usuario y contrasena son obligatorios." });
      return;
    }
    setSaving(true);
    try {
      await createUser(
        {
          nombre: createForm.nombre.trim(),
          email: createForm.email.trim().toLowerCase(),
          rol: createForm.rol,
          activo: createForm.activo,
          fecha_cumpleanos: createForm.fecha_cumpleanos || null,
          sueldo: Number(createForm.sueldo)
        },
        createForm.password
      );
      setCreateForm({
        nombre: "",
        email: "",
        password: "",
        fecha_cumpleanos: "",
        sueldo: "0.00",
        rol: "operante",
        activo: true
      });
      setStatus({ type: "success", message: "Usuario creado correctamente." });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  async function handleEdit(event) {
    event.preventDefault();
    if (!selectedUser) return;
    setStatus(null);
    if (!editForm.nombre.trim() || !editForm.email.trim()) {
      setStatus({ type: "error", message: "Nombre y usuario son obligatorios." });
      return;
    }
    if (editForm.fecha_salida && !editForm.fecha_ingreso) {
      setStatus({ type: "error", message: "Ingresa la fecha de ingreso antes de registrar la salida." });
      return;
    }
    if (editForm.fecha_ingreso && editForm.fecha_salida && editForm.fecha_salida < editForm.fecha_ingreso) {
      setStatus({ type: "error", message: "La fecha de salida no puede ser anterior a la fecha de ingreso." });
      return;
    }
    setSaving(true);
    try {
      await updateUser(
        selectedUser.id,
        {
          nombre: editForm.nombre.trim(),
          email: editForm.email.trim().toLowerCase(),
          rol: editForm.rol,
          activo: editForm.fecha_ingreso ? !editForm.fecha_salida : editForm.activo,
          fecha_cumpleanos: editForm.fecha_cumpleanos || null,
          sueldo: Number(editForm.sueldo),
          fecha_ingreso: editForm.fecha_ingreso || null,
          fecha_salida: editForm.fecha_salida || null
        },
        editForm.password.trim() || null
      );
      setStatus({ type: "success", message: "Usuario actualizado correctamente." });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!selectedUser) return;
    setStatus(null);
    setSaving(true);
    try {
      const result = await deleteUser(selectedUser.id);
      setEditId("");
      setStatus({
        type: result?.archived ? "warning" : "success",
        message: result?.archived
          ? "El usuario tiene historial relacionado, por eso fue desactivado en lugar de borrar sus registros."
          : "Usuario eliminado correctamente."
      });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  const rows = users.map((user) => ({
    id: user.id,
    Nombre: user.nombre,
    Usuario: user.email,
    Rol: normalizeRole(user.rol),
    Sueldo: Number(user.sueldo || 0).toLocaleString("es-PE", { style: "currency", currency: "PEN" }),
    Activo: boolValue(user.activo),
    "Fecha nacimiento": user.fecha_cumpleanos || ""
  }));

  return (
    <div className="stack">
      <Panel title="Gestion de usuarios" eyebrow="Administracion">
        {loading ? <LoadingBlock /> : <DataTable rows={rows} />}
        {error ? <Alert type="error">{error}</Alert> : null}
      </Panel>

      <Panel actions={<Button variant="secondary" icon={RefreshCcw} onClick={reload}>Actualizar</Button>}>
        <Tabs tabs={["Crear", "Editar", "Eliminar"]} active={tab} onChange={setTab} />
        <StatusAlert status={status} />

        {tab === "Crear" ? (
          <form className="form-grid" onSubmit={handleCreate}>
            <TextInput label="Nombre" value={createForm.nombre} onChange={(nombre) => setCreateForm({ ...createForm, nombre })} />
            <TextInput label="Usuario o correo" value={createForm.email} onChange={(email) => setCreateForm({ ...createForm, email })} />
            <TextInput
              label="Contrasena"
              type="password"
              value={createForm.password}
              onChange={(password) => setCreateForm({ ...createForm, password })}
            />
            <TextInput
              label="Fecha de nacimiento"
              type="date"
              min="1900-01-01"
              max={birthdayMaxISO()}
              value={createForm.fecha_cumpleanos}
              onChange={(fecha_cumpleanos) => setCreateForm({ ...createForm, fecha_cumpleanos })}
            />
            <TextInput
              label="Sueldo"
              type="number"
              min="0"
              max="9999999999.99"
              step="0.01"
              value={createForm.sueldo}
              onChange={(sueldo) => setCreateForm({ ...createForm, sueldo })}
            />
            <SelectInput label="Rol" value={createForm.rol} onChange={(rol) => setCreateForm({ ...createForm, rol })} options={roleOptions} />
            <CheckboxInput label="Activo" checked={createForm.activo} onChange={(activo) => setCreateForm({ ...createForm, activo })} />
            <div className="form-span">
              <Button type="submit" icon={Plus} loading={saving}>Crear usuario</Button>
            </div>
          </form>
        ) : null}

        {tab !== "Crear" ? (
          <div className="stack">
            <SelectInput
              label={tab === "Editar" ? "Usuario" : "Usuario a eliminar"}
              value={editId}
              onChange={setEditId}
              options={[
                { value: "", label: "Selecciona un usuario" },
                ...users.map((user) => ({ value: String(user.id), label: `${user.id} - ${user.email}` }))
              ]}
            />
            {tab === "Editar" && selectedUser ? (
              <form className="form-grid" onSubmit={handleEdit}>
                <TextInput label="Nombre" value={editForm.nombre} onChange={(nombre) => setEditForm({ ...editForm, nombre })} />
                <TextInput label="Usuario o correo" value={editForm.email} onChange={(email) => setEditForm({ ...editForm, email })} />
                <TextInput
                  label="Fecha de nacimiento"
                  type="date"
                  min="1900-01-01"
                  max={birthdayMaxISO()}
                  value={editForm.fecha_cumpleanos || ""}
                  onChange={(fecha_cumpleanos) => setEditForm({ ...editForm, fecha_cumpleanos })}
                />
                <TextInput
                  label="Sueldo"
                  type="number"
                  min="0"
                  max="9999999999.99"
                  step="0.01"
                  value={editForm.sueldo}
                  onChange={(sueldo) => setEditForm({ ...editForm, sueldo })}
                />
                <SelectInput label="Rol" value={editForm.rol} onChange={(rol) => setEditForm({ ...editForm, rol })} options={roleOptions} />
                <TextInput
                  label="Nueva contrasena"
                  type="password"
                  value={editForm.password}
                  onChange={(password) => setEditForm({ ...editForm, password })}
                  placeholder="Opcional"
                />
                <TextInput
                  label="Fecha de ingreso"
                  type="date"
                  value={editForm.fecha_ingreso}
                  onChange={(fecha_ingreso) => setEditForm({ ...editForm, fecha_ingreso })}
                />
                <TextInput
                  label="Fecha de salida"
                  type="date"
                  min={editForm.fecha_ingreso || undefined}
                  value={editForm.fecha_salida}
                  onChange={(fecha_salida) => setEditForm({ ...editForm, fecha_salida })}
                />
                <div className="form-span">
                  <Alert>
                    La fecha de salida es opcional. Si queda vacia, el usuario permanecera activo; al registrar una salida se desactivara.
                  </Alert>
                </div>
                <div className="form-span">
                  <FormActions saving={saving} saveLabel="Guardar cambios" />
                </div>
              </form>
            ) : null}
            {tab === "Eliminar" && selectedUser ? (
              <div className="danger-zone">
                <p>Eliminaras a {selectedUser.email}. Esta accion depende de las reglas de la base de datos.</p>
                <Button variant="danger" icon={Trash2} loading={saving} onClick={handleDelete}>Eliminar usuario</Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </Panel>
    </div>
  );
}

function defaultTaskForm() {
  return {
    titulo: "",
    activo: true,
    tipo_tarea: "General",
    tipo_medicion: "cantidad",
    unidad_base: "Ninguna",
    requiere_marca: false,
    requiere_tiempo: false,
    requiere_lote: false,
    requiere_numero_guia: false,
    ranges: emptyQuantityRanges(),
    puntaje_fijo: 1,
    puntaje_turno_simple: 1,
    puntaje_turno_completo: 1
  };
}

function taskPayloadFromForm(form) {
  const tipo = normalizeMeasurementType(form.tipo_medicion);
  const usesPairs = isPairUnit(form.unidad_base);
  return {
    nombre: form.titulo.trim(),
    titulo: form.titulo.trim(),
    activo: Boolean(form.activo),
    tipo_tarea: form.tipo_tarea || "General",
    tipo_medicion: tipo,
    unidad_medida: form.unidad_base.trim() || "Ninguna",
    unidad_base: form.unidad_base.trim() || null,
    requiere_marca: usesPairs || Boolean(form.requiere_marca),
    requiere_tiempo: Boolean(form.requiere_tiempo || tipo === "tiempo"),
    requiere_lote: Boolean(form.requiere_lote),
    requiere_numero_guia: Boolean(form.requiere_numero_guia)
  };
}

function scoringRulesFromForm(form) {
  const tipo = normalizeMeasurementType(form.tipo_medicion);
  if (tipo === "cantidad") {
    return form.ranges.map((range, index) => ({
      tipo_regla: "CANTIDAD",
      desde: Number(range.desde),
      hasta: range.hasta === "" || range.hasta === null ? null : Number(range.hasta),
      turno: null,
      puntos: index + 1
    }));
  }
  if (tipo === "fijo") {
    return [{ tipo_regla: "FIJO", desde: null, hasta: null, turno: null, puntos: Number(form.puntaje_fijo) }];
  }
  if (tipo === "turno") {
    return [
      { tipo_regla: "TURNO", desde: null, hasta: null, turno: "Simple", puntos: Number(form.puntaje_turno_simple) },
      { tipo_regla: "TURNO", desde: null, hasta: null, turno: "Completo", puntos: Number(form.puntaje_turno_completo) }
    ];
  }
  return [];
}

async function loadTaskBundle() {
  const tasks = await listTasks();
  const rulesByTaskId = {};
  tasks.forEach((task) => {
    rulesByTaskId[String(task.id)] = task.reglas_puntaje || [];
  });
  return { tasks, rulesByTaskId };
}

function TasksPanel() {
  const { data, loading, error, reload } = useAsyncData(loadTaskBundle, [], { tasks: [], rulesByTaskId: {} });
  const [tab, setTab] = useState("Crear tarea");
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [createForm, setCreateForm] = useState(defaultTaskForm());
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [editForm, setEditForm] = useState(defaultTaskForm());

  const tasks = data?.tasks || [];
  const rulesByTaskId = data?.rulesByTaskId || {};
  const selectedTask = tasks.find((task) => String(task.id) === String(selectedTaskId));

  useEffect(() => {
    if (!selectedTask) return;
    const rules = rulesByTaskId[String(selectedTask.id)] || [];
    setEditForm({
      titulo: getTaskTitle(selectedTask),
      activo: boolValue(selectedTask.activo),
      tipo_tarea: selectedTask.tipo_tarea || "General",
      tipo_medicion: normalizeMeasurementType(selectedTask.tipo_medicion),
      unidad_base: selectedTask.unidad_medida || selectedTask.unidad_base || selectedTask.unidad || "Ninguna",
      requiere_marca: Boolean(selectedTask.requiere_marca),
      requiere_tiempo: Boolean(selectedTask.requiere_tiempo),
      requiere_lote: Boolean(selectedTask.requiere_lote),
      requiere_numero_guia: Boolean(selectedTask.requiere_numero_guia),
      ranges: quantityRangesFromRules(rules),
      puntaje_fijo: Number(selectedTask.puntaje_fijo || selectedTask.puntaje || 1),
      puntaje_turno_simple: Number(selectedTask.puntaje_turno_simple || selectedTask.puntos_turno_simple || 1),
      puntaje_turno_completo: Number(selectedTask.puntaje_turno_completo || selectedTask.puntos_turno_completo || 1)
    });
  }, [selectedTask?.id, rulesByTaskId]);

  async function handleCreate(event) {
    event.preventDefault();
    setStatus(null);
    if (!createForm.titulo.trim()) {
      setStatus({ type: "error", message: "El nombre de tarea es obligatorio." });
      return;
    }
    const rangesError = normalizeMeasurementType(createForm.tipo_medicion) === "cantidad"
      ? validateQuantityRanges(createForm.ranges)
      : "";
    if (rangesError) {
      setStatus({ type: "error", message: rangesError });
      return;
    }
    setSaving(true);
    try {
      const created = await createTask(taskPayloadFromForm(createForm));
      if (created?.id) await setTaskScoringRules(created.id, scoringRulesFromForm(createForm));
      setCreateForm(defaultTaskForm());
      setStatus({ type: "success", message: "Tarea creada correctamente." });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  async function handleEdit(event) {
    event.preventDefault();
    if (!selectedTask) return;
    setStatus(null);
    if (!editForm.titulo.trim()) {
      setStatus({ type: "error", message: "El nombre de tarea es obligatorio." });
      return;
    }
    const rangesError = normalizeMeasurementType(editForm.tipo_medicion) === "cantidad"
      ? validateQuantityRanges(editForm.ranges)
      : "";
    if (rangesError) {
      setStatus({ type: "error", message: rangesError });
      return;
    }
    setSaving(true);
    try {
      await updateTask(selectedTask.id, taskPayloadFromForm(editForm), selectedTask);
      await setTaskScoringRules(selectedTask.id, scoringRulesFromForm(editForm));
      setStatus({ type: "success", message: "Tarea actualizada correctamente." });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteTask() {
    if (!selectedTask) return;
    setStatus(null);
    setSaving(true);
    try {
      const result = await deleteTask(selectedTask.id);
      setSelectedTaskId("");
      setStatus({
        type: result?.archived ? "warning" : "success",
        message: result?.archived
          ? "La tarea tiene registros relacionados, por eso fue desactivada para conservar el historial."
          : "Tarea eliminada correctamente."
      });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  const summaryRows = tasks.map((task) => {
    const tipo = normalizeMeasurementType(task.tipo_medicion);
    const row = { Actividad: getTaskTitle(task), "Tipo de puntaje": tipo };
    for (let point = 1; point <= 10; point += 1) row[`${point} punto`] = "";
    if (tipo === "cantidad") {
      quantityRangesFromRules(rulesByTaskId[String(task.id)] || []).forEach((range, index) => {
        if (range.desde === "") return;
        row[`${index + 1} punto`] = `${range.desde} - ${range.hasta === "" || range.hasta === null ? "sin limite" : range.hasta}`;
      });
    }
    if (tipo === "fijo") {
      const score = Number(task.puntaje_fijo || task.puntaje || 0);
      if (score >= 1 && score <= 10) row[`${score} punto`] = "SI";
    }
    if (tipo === "turno") {
      const simple = Number(task.puntaje_turno_simple || task.puntos_turno_simple || 0);
      const complete = Number(task.puntaje_turno_completo || task.puntos_turno_completo || 0);
      if (simple >= 1 && simple <= 10) row[`${simple} punto`] = "S";
      if (complete >= 1 && complete <= 10) row[`${complete} punto`] = "C";
    }
    return row;
  });

  return (
    <div className="stack">
      <Panel title="Configuracion de puntajes" eyebrow="Tareas">
        {loading ? <LoadingBlock /> : <DataTable rows={summaryRows} compact />}
        {error ? <Alert type="error">{error}</Alert> : null}
      </Panel>

      <Panel actions={<Button variant="secondary" icon={RefreshCcw} onClick={reload}>Actualizar</Button>}>
        <Tabs tabs={["Crear tarea", "Editar tarea", "Eliminar tarea"]} active={tab} onChange={setTab} />
        <StatusAlert status={status} />

        {tab === "Crear tarea" ? (
          <TaskForm form={createForm} setForm={setCreateForm} onSubmit={handleCreate} saving={saving} submitLabel="Crear tarea" />
        ) : (
          <div className="stack">
            <SelectInput
              label={tab === "Editar tarea" ? "Selecciona una tarea" : "Tarea a eliminar"}
              value={selectedTaskId}
              onChange={setSelectedTaskId}
              options={[
                { value: "", label: "Selecciona una tarea" },
                ...tasks.map((task) => ({ value: String(task.id), label: `${task.id} - ${getTaskTitle(task) || "Sin titulo"}` }))
              ]}
            />
            {tab === "Editar tarea" && selectedTask ? (
              <TaskForm form={editForm} setForm={setEditForm} onSubmit={handleEdit} saving={saving} submitLabel="Guardar cambios" />
            ) : null}
            {tab === "Eliminar tarea" && selectedTask ? (
              <div className="danger-zone">
                <p>
                  Eliminaras la tarea {getTaskTitle(selectedTask)}. Si tiene actividades o incidencias relacionadas,
                  se desactivara para conservar el historial.
                </p>
                <Button variant="danger" icon={Trash2} loading={saving} onClick={handleDeleteTask}>Eliminar tarea</Button>
              </div>
            ) : null}
          </div>
        )}
      </Panel>
    </div>
  );
}

function TaskForm({ form, setForm, onSubmit, saving, submitLabel }) {
  return (
    <form className="stack" onSubmit={onSubmit} noValidate>
      <div className="form-grid">
        <TextInput label="Nombre de tarea" value={form.titulo} onChange={(titulo) => setForm({ ...form, titulo })} />
        <SelectInput
          label="Categoria"
          value={form.tipo_tarea}
          onChange={(tipo_tarea) => setForm({ ...form, tipo_tarea })}
          options={["Ingreso", "Despacho", "General"]}
        />
        <SelectInput
          label="Tipo de puntaje"
          value={form.tipo_medicion}
          onChange={(tipo_medicion) => setForm({ ...form, tipo_medicion })}
          options={taskTypes}
        />
        <TextInput
          label="Unidad base"
          value={form.unidad_base}
          onChange={(unidad_base) =>
            setForm({
              ...form,
              unidad_base,
              requiere_marca: isPairUnit(unidad_base) || form.requiere_marca
            })
          }
          placeholder="Pares, cajas, bultos o Ninguna"
        />
        <CheckboxInput label="Tarea activa" checked={form.activo} onChange={(activo) => setForm({ ...form, activo })} />
        <CheckboxInput
          label="Requiere marca"
          checked={isPairUnit(form.unidad_base) || form.requiere_marca}
          disabled={isPairUnit(form.unidad_base)}
          onChange={(requiere_marca) => setForm({ ...form, requiere_marca })}
          hint={isPairUnit(form.unidad_base) ? "Las tareas medidas en pares usan marcas automaticamente." : undefined}
        />
        <CheckboxInput label="Requiere tiempo" checked={form.requiere_tiempo} onChange={(requiere_tiempo) => setForm({ ...form, requiere_tiempo })} />
        <CheckboxInput label="Requiere lote" checked={form.requiere_lote} onChange={(requiere_lote) => setForm({ ...form, requiere_lote })} />
        <CheckboxInput label="Requiere numero de guia" checked={form.requiere_numero_guia} onChange={(requiere_numero_guia) => setForm({ ...form, requiere_numero_guia })} />
      </div>
      <ScoreFields form={form} setForm={setForm} />
      <div className="form-actions">
        <Button type="submit" icon={Save} loading={saving}>{submitLabel}</Button>
      </div>
    </form>
  );
}

function ScoreFields({ form, setForm }) {
  const tipo = normalizeMeasurementType(form.tipo_medicion);
  if (tipo === "cantidad") {
    return (
      <div className="score-matrix">
        <div className="matrix-title">Rangos de cantidad para puntajes del 1 al 10</div>
        <Alert>Define desde y hasta para cada puntaje. En 10 puntos puedes dejar “Hasta” vacio para indicar que no tiene limite.</Alert>
        <div className="score-grid">
          {form.ranges.map((range, index) => (
            <label key={index} className="score-cell">
              <span>{index + 1} punto{index ? "s" : ""}</span>
              <div className="range-inputs">
                <input
                  aria-label={`Desde para ${index + 1} puntos`}
                  type="number"
                  min="0"
                  max={MAX_SCORE_QUANTITY}
                  step="1"
                  placeholder="Desde"
                  value={range.desde}
                  onChange={(event) => {
                    const ranges = form.ranges.map((item, itemIndex) => itemIndex === index ? { ...item, desde: event.target.value } : item);
                    setForm({ ...form, ranges });
                  }}
                />
                <input
                  aria-label={`Hasta para ${index + 1} puntos`}
                  type="number"
                  min="0"
                  max={MAX_SCORE_QUANTITY}
                  step="1"
                  placeholder={index === 9 ? "Sin limite" : "Hasta"}
                  value={range.hasta}
                  onChange={(event) => {
                    const ranges = form.ranges.map((item, itemIndex) => itemIndex === index ? { ...item, hasta: event.target.value } : item);
                    setForm({ ...form, ranges });
                  }}
                />
              </div>
            </label>
          ))}
        </div>
      </div>
    );
  }
  if (tipo === "fijo") {
    return (
      <SelectInput
        label="Puntaje fijo"
        value={String(form.puntaje_fijo)}
        onChange={(value) => setForm({ ...form, puntaje_fijo: Number(value) })}
        options={Array.from({ length: 10 }, (_, index) => String(index + 1))}
      />
    );
  }
  if (tipo === "turno") {
    return (
      <div className="form-grid">
        <SelectInput
          label="Puntaje turno simple"
          value={String(form.puntaje_turno_simple)}
          onChange={(value) => setForm({ ...form, puntaje_turno_simple: Number(value) })}
          options={Array.from({ length: 10 }, (_, index) => String(index + 1))}
        />
        <SelectInput
          label="Puntaje turno completo"
          value={String(form.puntaje_turno_completo)}
          onChange={(value) => setForm({ ...form, puntaje_turno_completo: Number(value) })}
          options={Array.from({ length: 10 }, (_, index) => String(index + 1))}
        />
      </div>
    );
  }
  return <Alert>Las tareas por tiempo usan la matriz historica de minutos.</Alert>;
}

function AttendancePanel() {
  const [selectedDate, setSelectedDate] = useState(todayLimaISO());
  const [attendanceValues, setAttendanceValues] = useState({});
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);

  const { data, loading, error, reload } = useAsyncData(
    async () => {
      const [workers, current, attendances] = await Promise.all([
        listWorkers(),
        getAttendanceForDate(selectedDate),
        listAttendances()
      ]);
      return { workers, current, attendances };
    },
    [selectedDate],
    { workers: [], current: [], attendances: [] }
  );

  useEffect(() => {
    const currentMap = Object.fromEntries((data.current || []).map((row) => [row.usuario_id, row.estado === "Presente"]));
    const nextValues = {};
    (data.workers || []).forEach((worker) => {
      nextValues[worker.id] = Boolean(currentMap[worker.id]);
    });
    setAttendanceValues(nextValues);
  }, [data.current, data.workers]);

  const currentMarks = useMemo(
    () => Object.fromEntries((data.current || []).map((row) => [row.usuario_id, row.estado === "Presente"])),
    [data.current]
  );

  async function handleSave() {
    setStatus(null);
    setSaving(true);
    try {
      for (const worker of data.workers || []) {
        const nextValue = Boolean(attendanceValues[worker.id]);
        if (Boolean(currentMarks[worker.id]) !== nextValue) {
          await markAttendance(worker.id, selectedDate, nextValue);
        }
      }
      setStatus({ type: "success", message: "Asistencia guardada correctamente." });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  const workerNameById = Object.fromEntries((data.workers || []).map((worker) => [worker.id, worker.nombre || worker.email]));
  const workerEmailById = Object.fromEntries((data.workers || []).map((worker) => [worker.id, worker.email]));
  const attendanceRows = (data.attendances || []).map((item) => ({
    Fecha: item.fecha,
    Trabajador: workerNameById[item.usuario_id],
    Email: workerEmailById[item.usuario_id],
    Estado: item.estado || "Presente",
    "Marcado en": String(item.estado || "").toLowerCase() === "ausente" ? "" : formatDateTimeLima(item.created_at)
  }));

  function exportAttendance() {
    const columns = ["Fecha", "Trabajador", "Email", "Estado", "Marcado en"];
    const header = columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("");
    const body = attendanceRows
      .map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(row[column] ?? "")}</td>`).join("")}</tr>`)
      .join("");
    const html = `<!doctype html><html><head><meta charset="UTF-8"></head><body><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></body></html>`;
    const blob = new Blob([html], { type: "application/vnd.ms-excel;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `asistencia_${selectedDate}.xls`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="stack">
      <Panel title="Gestion de asistencia" eyebrow="Control diario">
        <div className="toolbar">
          <TextInput label="Fecha" type="date" value={selectedDate} onChange={setSelectedDate} />
          <Button variant="secondary" icon={RefreshCcw} onClick={reload}>Actualizar</Button>
        </div>
        <StatusAlert status={status} />
        {loading ? <LoadingBlock /> : null}
        {error ? <Alert type="error">{error}</Alert> : null}
        {!loading && !(data.workers || []).length ? <Alert>No hay trabajadores registrados.</Alert> : null}
        <div className="attendance-list">
          {(data.workers || []).map((worker) => (
            <label key={worker.id} className="attendance-row">
              <span>
                <strong>{worker.nombre || "Sin nombre"}</strong>
                <small>{worker.email}</small>
              </span>
              <input
                type="checkbox"
                checked={Boolean(attendanceValues[worker.id])}
                onChange={(event) => setAttendanceValues({ ...attendanceValues, [worker.id]: event.target.checked })}
              />
            </label>
          ))}
        </div>
        <div className="form-actions">
          <Button icon={Save} loading={saving} onClick={handleSave}>Guardar asistencia</Button>
        </div>
      </Panel>

      <Panel
        title="Historial de asistencia"
        actions={attendanceRows.length ? <Button variant="secondary" onClick={exportAttendance}>Exportar Excel</Button> : null}
      >
        <DataTable rows={attendanceRows} />
      </Panel>
    </div>
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function StoresPanel() {
  const { data: stores = [], loading, error, reload } = useAsyncData(listTiendas, [], []);
  const [tab, setTab] = useState("Crear");
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [nombre, setNombre] = useState("");
  const [activo, setActivo] = useState(true);
  const [selectedId, setSelectedId] = useState("");

  const selectedStore = stores.find((store) => String(store.id) === String(selectedId));

  useEffect(() => {
    if (!selectedStore) return;
    setNombre(selectedStore.nombre || "");
    setActivo(boolValue(selectedStore.activo));
  }, [selectedStore?.id]);

  async function submitCreate(event) {
    event.preventDefault();
    if (!nombre.trim()) {
      setStatus({ type: "error", message: "El nombre de tienda es obligatorio." });
      return;
    }
    setSaving(true);
    try {
      await createTienda({ nombre: nombre.trim(), activo });
      setNombre("");
      setActivo(true);
      setStatus({ type: "success", message: "Tienda creada correctamente." });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  async function submitEdit(event) {
    event.preventDefault();
    if (!selectedStore) return;
    if (!nombre.trim()) {
      setStatus({ type: "error", message: "El nombre de tienda es obligatorio." });
      return;
    }
    setSaving(true);
    try {
      await updateTienda(selectedStore.id, { nombre: nombre.trim(), activo });
      setStatus({ type: "success", message: "Tienda actualizada correctamente." });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  async function submitDelete() {
    if (!selectedStore) return;
    setSaving(true);
    try {
      const result = await deleteTienda(selectedStore.id);
      setSelectedId("");
      setNombre("");
      setStatus({
        type: result?.archived ? "warning" : "success",
        message: result?.archived
          ? "La tienda tiene historial relacionado y fue desactivada en lugar de eliminarse."
          : "Tienda eliminada correctamente."
      });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stack">
      <Panel title="Gestion de tiendas" eyebrow="Catalogo">
        {loading ? <LoadingBlock /> : <DataTable rows={stores} />}
        {error ? <Alert type="error">{error}</Alert> : null}
      </Panel>
      <Panel actions={<Button variant="secondary" icon={RefreshCcw} onClick={reload}>Actualizar</Button>}>
        <Tabs tabs={["Crear", "Editar", "Eliminar"]} active={tab} onChange={setTab} />
        <StatusAlert status={status} />
        <form className="form-grid" onSubmit={tab === "Crear" ? submitCreate : submitEdit}>
          {tab !== "Crear" ? (
            <SelectInput
              label="Tienda"
              value={selectedId}
              onChange={setSelectedId}
              options={[
                { value: "", label: "Selecciona una tienda" },
                ...stores.map((store) => ({ value: String(store.id), label: `${store.id} - ${store.nombre}` }))
              ]}
            />
          ) : null}
          {tab !== "Eliminar" ? (
            <>
              <TextInput label="Nombre de tienda" value={nombre} onChange={setNombre} />
              <CheckboxInput label="Activo" checked={activo} onChange={setActivo} />
              <div className="form-span">
                <Button type="submit" icon={Save} loading={saving}>{tab === "Crear" ? "Crear tienda" : "Guardar cambios"}</Button>
              </div>
            </>
          ) : selectedStore ? (
            <div className="danger-zone form-span">
              <p>Eliminaras la tienda {selectedStore.nombre}.</p>
              <Button type="button" variant="danger" icon={Trash2} loading={saving} onClick={submitDelete}>Eliminar tienda</Button>
            </div>
          ) : null}
        </form>
      </Panel>
    </div>
  );
}

function activityDateISO(log) {
  const registrationDate = String(log.fecha_registro || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(registrationDate)) return registrationDate;
  if (!log.created_at) return "";
  const date = new Date(log.created_at);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function weekBounds(dateISO) {
  const selected = /^\d{4}-\d{2}-\d{2}$/.test(dateISO) ? dateISO : todayLimaISO();
  const date = new Date(`${selected}T12:00:00Z`);
  const mondayOffset = (date.getUTCDay() + 6) % 7;
  const start = new Date(date);
  start.setUTCDate(start.getUTCDate() - mondayOffset);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
}

function PointsUserGroup({ title, eyebrow, workers, rows, emptyMessage }) {
  const summaries = workers.map((worker) => {
    const workerRows = rows.filter((row) => Number(row.workerId) === Number(worker.id));
    return {
      Trabajador: worker.nombre || worker.email,
      Email: worker.email,
      Registros: workerRows.length,
      Puntos: Number(workerRows.reduce((sum, row) => sum + Number(row.Puntos || 0), 0).toFixed(1))
    };
  }).sort((a, b) => b.Puntos - a.Puntos || a.Trabajador.localeCompare(b.Trabajador));

  return (
    <Panel title={title} eyebrow={eyebrow}>
      {!workers.length ? <Alert>{emptyMessage}</Alert> : null}
      <DataTable rows={summaries} />
      <div className="details-list">
        {workers.map((worker) => {
          const workerRows = rows.filter((row) => Number(row.workerId) === Number(worker.id));
          const points = workerRows.reduce((sum, row) => sum + Number(row.Puntos || 0), 0);
          return (
            <details key={worker.id} className="detail-card">
              <summary>
                <span>{worker.nombre || worker.email}</span>
                <strong>{points.toFixed(1)} pts</strong>
              </summary>
              {!workerRows.length ? <Alert>Sin registros en el periodo seleccionado.</Alert> : null}
              <DataTable rows={workerRows.map(({ workerId: _workerId, Trabajador: _worker, Email: _email, ...rest }) => rest)} compact />
            </details>
          );
        })}
      </div>
    </Panel>
  );
}

function WorkerPointsPanel() {
  const { data, loading, error, reload } = useAsyncData(
    async () => {
      const [logs, users, tasks] = await Promise.all([listAllActivityLogs(), selectUsers(), listTasks()]);
      return { logs, users, tasks };
    },
    [],
    { logs: [], users: [], tasks: [] }
  );

  const today = todayLimaISO();
  const [periodType, setPeriodType] = useState("mes");
  const [selectedDay, setSelectedDay] = useState(today);
  const [selectedWeekDay, setSelectedWeekDay] = useState(today);
  const [selectedMonth, setSelectedMonth] = useState(today.slice(0, 7));
  const [rangeStart, setRangeStart] = useState(today);
  const [rangeEnd, setRangeEnd] = useState(today);

  const workers = (data.users || []).filter((user) => ["operante", "jefe de equipo"].includes(normalizeRole(user.rol)));
  const workerIds = new Set(workers.map((worker) => Number(worker.id)));
  const userNameById = Object.fromEntries(workers.map((worker) => [worker.id, worker.nombre || worker.email]));
  const userEmailById = Object.fromEntries(workers.map((worker) => [worker.id, worker.email]));
  const taskNameById = Object.fromEntries((data.tasks || []).map((task) => [task.id, getTaskTitle(task) || `Tarea ${task.id}`]));

  const [weekStart, weekEnd] = weekBounds(selectedWeekDay);
  const rangeInvalid = periodType === "rango" && (!rangeStart || !rangeEnd || rangeStart > rangeEnd);
  const periodLabel = periodType === "dia"
    ? `Día ${selectedDay}`
    : periodType === "semana"
      ? `Semana del ${weekStart} al ${weekEnd}`
      : periodType === "mes"
        ? `Mes ${selectedMonth}`
        : `Del ${rangeStart || "-"} al ${rangeEnd || "-"}`;

  const rows = (data.logs || [])
    .filter((log) => workerIds.has(Number(log.trabajador_id)))
    .filter((log) => {
      if (rangeInvalid) return false;
      const date = activityDateISO(log);
      if (periodType === "dia") return date === selectedDay;
      if (periodType === "semana") return date >= weekStart && date <= weekEnd;
      if (periodType === "mes") return date.startsWith(selectedMonth);
      return date >= rangeStart && date <= rangeEnd;
    })
    .map((log) => {
      const tareaNombre = taskNameById[log.tarea_id] || log.actividad_nombre || "";
      const [tipoAct] = getActivityCaptureMode(tareaNombre);
      const turnoDisplay = log.turno || (tipoAct === "turno" ? displayShiftFromQuantity(log.cantidad) : "");
      return {
        workerId: Number(log.trabajador_id),
        Fecha: formatDateTimeLima(log.created_at) || log.fecha_registro,
        Trabajador: userNameById[log.trabajador_id],
        Email: userEmailById[log.trabajador_id],
        Tarea: tareaNombre,
        Cantidad: log.cantidad ?? "",
        Turno: turnoDisplay,
        "Tiempo (min)": log.tiempo_minutos,
        Cumplimiento: log.cumplimiento,
        Puntos: Number(log.puntos_obtenidos || 0)
      };
    });

  const activeWorkers = workers.filter((worker) => boolValue(worker.activo));
  const inactiveWorkers = workers.filter((worker) => !boolValue(worker.activo));
  const total = rows.reduce((sum, row) => sum + Number(row.Puntos || 0), 0);
  const workersWithRecords = new Set(rows.map((row) => row.workerId)).size;

  return (
    <div className="stack">
      <Panel title="Tareas realizadas y puntos" eyebrow="Rendimiento" actions={<Button variant="secondary" icon={RefreshCcw} onClick={reload}>Actualizar</Button>}>
        {loading ? <LoadingBlock /> : null}
        {error ? <Alert type="error">{error}</Alert> : null}
        <div className="form-grid">
          <SelectInput
            label="Filtrar periodo"
            value={periodType}
            onChange={setPeriodType}
            options={[
              { value: "dia", label: "Día específico" },
              { value: "semana", label: "Semana" },
              { value: "mes", label: "Mes" },
              { value: "rango", label: "Rango personalizado" }
            ]}
          />
          {periodType === "dia" ? <TextInput label="Fecha" type="date" value={selectedDay} onChange={setSelectedDay} /> : null}
          {periodType === "semana" ? (
            <TextInput label="Selecciona un día de la semana" type="date" value={selectedWeekDay} onChange={setSelectedWeekDay} />
          ) : null}
          {periodType === "mes" ? <TextInput label="Mes" type="month" value={selectedMonth} onChange={setSelectedMonth} /> : null}
          {periodType === "rango" ? (
            <>
              <TextInput label="Desde" type="date" value={rangeStart} onChange={setRangeStart} />
              <TextInput label="Hasta" type="date" value={rangeEnd} onChange={setRangeEnd} />
            </>
          ) : null}
        </div>
        {rangeInvalid ? <Alert type="error">El rango personalizado necesita fechas válidas y “Desde” no puede ser posterior a “Hasta”.</Alert> : null}
        {!loading && !rows.length && !rangeInvalid ? <Alert>No hay registros en el periodo seleccionado.</Alert> : null}
        <Alert>Periodo aplicado: {periodLabel}</Alert>
        <div className="metrics-row">
          <Metric label="Puntos totales" value={total.toFixed(0)} tone="accent" />
          <Metric label="Usuarios con registros" value={workersWithRecords} />
          <Metric label="Usuarios activos" value={activeWorkers.length} />
          <Metric label="Usuarios inactivos" value={inactiveWorkers.length} />
        </div>
      </Panel>
      <PointsUserGroup
        title={`Usuarios activos (${activeWorkers.length})`}
        eyebrow="Personal habilitado"
        workers={activeWorkers}
        rows={rows}
        emptyMessage="No hay usuarios activos para mostrar."
      />
      <PointsUserGroup
        title={`Usuarios inactivos (${inactiveWorkers.length})`}
        eyebrow="Personal bloqueado"
        workers={inactiveWorkers}
        rows={rows}
        emptyMessage="No hay usuarios inactivos para mostrar."
      />
    </div>
  );
}
