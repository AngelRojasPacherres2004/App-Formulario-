import { useMemo, useState } from "react";
import {
  BadgeCheck,
  ClipboardCheck,
  Filter,
  Hash,
  RefreshCcw,
  Save,
  Search,
  Timer,
  UserRound,
  UsersRound
} from "lucide-react";
import {
  createIncident,
  createGroupLeaderRecord,
  friendlyError,
  loadIncidentContext,
  loadGroupLeaderContext
} from "../lib/repository";
import { formatDateTimeLima, todayLimaISO } from "../lib/dates";
import {
  getGroupLeaderTaskMode,
  getTaskTitle,
  isGroupLeaderTimeTask,
  normalizeMeasurementType,
  normalizeText,
  taskUsesGuideBreakdown,
  taskUsesLote
} from "../lib/scoring";
import { useAsyncData } from "../lib/hooks";
import { Alert, Button, CheckboxInput, DataTable, LoadingBlock, Panel, SelectInput, Tabs, TextArea, TextInput } from "./ui";
import WorkerDashboard from "./WorkerDashboard";

const initialForm = {
  trabajador_id: "",
  tarea_id: "",
  cantidad: "",
  horas: "",
  minutos: "",
  usaCodigoGuia: false,
  codigo_guia: "",
  usaLote: false,
  lote: "",
  detalle: ""
};

const initialFilters = {
  scope: "all",
  workerId: "",
  taskId: "",
  search: ""
};

const historyColumns = [
  "ID",
  "Fecha",
  "Encargado",
  "Operante",
  "Tarea",
  "Cantidad",
  "Tiempo",
  "Número de guía",
  "Código de lote",
  "Detalle"
];

export default function GroupLeaderDashboard({ user }) {
  const [workspace, setWorkspace] = useState("Registrar actividad normal");
  const tabs = ["Registrar actividad normal", "Registrar actividad (tiempo)", "Registrar incidencias"];

  return (
    <div className="stack">
      <Tabs
        tabs={tabs}
        active={workspace}
        onChange={setWorkspace}
      />
      {workspace === "Registrar actividad normal" ? (
        <div className="stack">
          <Panel title="Registrar actividad normal" eyebrow="Registro propio">
            <Alert>Los registros de este apartado quedarán asociados a tu propio usuario, no al operante.</Alert>
          </Panel>
          <WorkerDashboard user={user} embedded />
        </div>
      ) : workspace === "Registrar actividad (tiempo)" ? (
        <GroupTimeDashboard user={user} />
      ) : (
        <IncidentDashboard user={user} />
      )}
    </div>
  );
}

const initialIncidentForm = {
  usuario_id: "",
  turno: "turno regular",
  tarea_id: "",
  tienda_id: "",
  numero_guia: "",
  tipo_error: "CONTENIDO",
  observacion: ""
};

function IncidentDashboard({ user }) {
  const [form, setForm] = useState(initialIncidentForm);
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const { data, loading, error, reload } = useAsyncData(
    loadIncidentContext,
    [user?.id],
    { workers: [], tasks: [], stores: [], incidents: [] }
  );

  const workers = data.workers || [];
  const tasks = data.tasks || [];
  const stores = data.stores || [];
  const incidents = data.incidents || [];
  const storeNames = useMemo(
    () => new Map(stores.map((store) => [Number(store.id), store.nombre])),
    [stores]
  );

  function updateForm(changes) {
    setForm((current) => ({ ...current, ...changes }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setStatus(null);

    if (!workers.some((worker) => String(worker.id) === String(form.usuario_id))) {
      setStatus({ type: "error", message: "Selecciona un operante." });
      return;
    }
    if (!tasks.some((task) => String(task.id) === String(form.tarea_id))) {
      setStatus({ type: "error", message: "Selecciona una tarea." });
      return;
    }
    if (!stores.some((store) => String(store.id) === String(form.tienda_id))) {
      setStatus({ type: "error", message: "Selecciona una tienda." });
      return;
    }
    if (!form.numero_guia.trim()) {
      setStatus({ type: "error", message: "Ingresa el número de guía." });
      return;
    }
    if (!form.tipo_error.trim()) {
      setStatus({ type: "error", message: "Ingresa el tipo de error." });
      return;
    }

    setSaving(true);
    try {
      await createIncident({
        usuario_id: Number(form.usuario_id),
        turno: form.turno,
        tarea_id: Number(form.tarea_id),
        tienda_id: Number(form.tienda_id),
        numero_guia: form.numero_guia.trim(),
        tipo_error: form.tipo_error.trim(),
        observacion: form.observacion.trim() || null
      });
      setForm(initialIncidentForm);
      setStatus({ type: "success", message: "Incidencia registrada correctamente." });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  const rows = incidents.map((incident) => ({
    ID: incident.id,
    Fecha: formatDateTimeLima(incident.created_at),
    Turno: incident.turno,
    Operante: incident.nombre,
    Tarea: incident.tarea_nombre,
    Tienda: incident.tienda_nombre || storeNames.get(Number(incident.tienda_id)) || incident.tienda_id,
    "Número de guía": incident.numero_guia,
    "Tipo de error": incident.tipo_error,
    Observación: incident.observacion
  }));

  return (
    <div className="stack">
      <Panel
        title="Registrar incidencia"
        eyebrow="Jefe de equipo"
        actions={<Button variant="secondary" icon={RefreshCcw} onClick={reload}>Actualizar</Button>}
      >
        {loading ? <LoadingBlock /> : null}
        {error ? <Alert type="error">{error}</Alert> : null}
        {status ? <Alert type={status.type}>{status.message}</Alert> : null}
        {!loading && !workers.length ? <Alert>No hay operantes activos.</Alert> : null}
        {!loading && !stores.length ? <Alert>No hay tiendas activas registradas.</Alert> : null}

        <form className="form-grid" onSubmit={handleSubmit}>
          <SelectInput
            label="Operante"
            value={form.usuario_id}
            onChange={(usuario_id) => updateForm({ usuario_id })}
            options={[
              { value: "", label: "Selecciona un operante" },
              ...workers.map((worker) => ({
                value: String(worker.id),
                label: `${worker.id} - ${worker.nombre || worker.email}`
              }))
            ]}
          />
          <SelectInput
            label="Turno"
            value={form.turno}
            onChange={(turno) => updateForm({ turno })}
            options={["turno regular", "incidencia", "turno extra"]}
          />
          <SelectInput
            label="Tarea"
            value={form.tarea_id}
            onChange={(tarea_id) => updateForm({ tarea_id })}
            options={[
              { value: "", label: "Selecciona una tarea" },
              ...tasks.map((task) => ({ value: String(task.id), label: `${task.id} - ${getTaskTitle(task)}` }))
            ]}
          />
          <SelectInput
            label="Tienda"
            value={form.tienda_id}
            onChange={(tienda_id) => updateForm({ tienda_id })}
            options={[
              { value: "", label: "Selecciona una tienda" },
              ...stores.map((store) => ({ value: String(store.id), label: store.nombre }))
            ]}
          />
          <TextInput
            label="Número de guía"
            value={form.numero_guia}
            onChange={(numero_guia) => updateForm({ numero_guia })}
            placeholder="Ej. GUIA-001"
          />
          <SelectInput
            label="Tipo de error"
            value={form.tipo_error}
            onChange={(tipo_error) => updateForm({ tipo_error })}
            options={["CONTENIDO", "LIBERADO"]}
          />
          <TextArea
            label="Observación"
            value={form.observacion}
            onChange={(observacion) => updateForm({ observacion })}
            placeholder="Detalle opcional"
          />
          <div className="form-span form-actions">
            <Button type="submit" icon={Save} loading={saving}>Guardar incidencia</Button>
          </div>
        </form>
      </Panel>

      <Panel title="Historial de incidencias" eyebrow="Datos registrados">
        <DataTable rows={rows} empty="Todavía no hay incidencias registradas." compact />
      </Panel>
    </div>
  );
}

function GroupTimeDashboard({ user }) {
  const [form, setForm] = useState(initialForm);
  const [filters, setFilters] = useState(initialFilters);
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);

  const { data, loading, error, reload } = useAsyncData(
    loadGroupLeaderContext,
    [user?.id],
    { workers: [], tasks: [], leaders: [], records: [] }
  );

  const workers = data.workers || [];
  const tasks = data.tasks || [];
  const records = data.records || [];

  const selectedTask = useMemo(
    () => tasks.find((task) => String(task.id) === String(form.tarea_id)),
    [tasks, form.tarea_id]
  );
  const selectedWorker = useMemo(
    () => workers.find((worker) => String(worker.id) === String(form.trabajador_id)),
    [workers, form.trabajador_id]
  );
  const taskMode = resolveGroupTaskMode(selectedTask);

  const metrics = useMemo(() => {
    const today = todayLimaISO();
    return {
      total: records.length,
      today: records.filter((record) => String(record.fecha_registro || "").slice(0, 10) === today).length,
      mine: records.filter((record) => String(record.encargado_id) === String(user.id)).length,
      adicionales: records.filter((record) => record.codigo_guia || record.lote).length
    };
  }, [records, user.id]);

  const filteredRecords = useMemo(() => {
    const term = normalizeText(filters.search);

    return records.filter((record) => {
      if (filters.scope === "mine" && String(record.encargado_id) !== String(user.id)) return false;
      if (filters.workerId && String(record.trabajador_id) !== String(filters.workerId)) return false;
      if (filters.taskId && String(record.tarea_id) !== String(filters.taskId)) return false;
      if (!term) return true;

      return normalizeText(
        [
          record.id,
          record.encargado_nombre,
          record.encargado_email,
          record.trabajador_nombre,
          record.trabajador_email,
          record.tarea_nombre,
          record.codigo_guia,
          record.lote,
          record.detalle
        ].join(" ")
      ).includes(term);
    });
  }, [filters, records, user.id]);

  const rows = filteredRecords.map((record) => ({
    id: record.id,
    ID: record.id,
    Fecha: formatDateTimeLima(record.created_at) || record.fecha_registro,
    Encargado: record.encargado_nombre || record.encargado_email,
    Operante: record.trabajador_nombre || record.trabajador_email,
    Tarea: record.tarea_nombre,
    Cantidad: formatNumber(record.cantidad),
    Tiempo: formatDuration(record.tiempo_minutos),
    "Número de guía": record.codigo_guia,
    "Código de lote": record.lote,
    Detalle: record.detalle
  }));

  function updateForm(changes) {
    setForm((current) => ({ ...current, ...changes }));
  }

  function updateFilters(changes) {
    setFilters((current) => ({ ...current, ...changes }));
  }

  function resetForm() {
    setForm(initialForm);
  }

  function validate() {
    if (!selectedWorker) return "Selecciona un operante.";
    if (!selectedTask) return "Selecciona una tarea.";
    if (!isGroupLeaderTimeTask(selectedTask)) return "Esta tarea no pertenece al registro por tiempo.";
    if (form.usaCodigoGuia && !taskUsesGuideBreakdown(selectedTask)) return "Esta tarea no permite numero de guia.";
    if (form.usaLote && !taskUsesLote(selectedTask)) return "Esta tarea no permite lote.";
    if (taskMode.requiresQuantity && (!form.cantidad || Number(form.cantidad) <= 0)) {
      return "Ingresa una cantidad mayor a cero.";
    }
    if (taskMode.requiresQuantity && !Number.isInteger(Number(form.cantidad))) {
      return "La cantidad debe ser un número entero.";
    }
    if (form.usaCodigoGuia && !form.codigo_guia.trim()) {
      return "Ingresa el número de guía.";
    }
    if (form.usaLote && !form.lote.trim()) {
      return "Ingresa el código de lote.";
    }
    if (taskMode.requiresTime) {
      const hours = Number(form.horas || 0);
      const minutes = Number(form.minutos || 0);
      const totalMinutes = hours * 60 + minutes;
      if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return "Horas y minutos deben ser números enteros.";
      if (minutes < 0 || minutes > 59) return "Los minutos deben estar entre 0 y 59.";
      if (totalMinutes <= 0) return "Ingresa el tiempo realizado.";
    }
    return "";
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setStatus(null);

    const validation = validate();
    if (validation) {
      setStatus({ type: "error", message: validation });
      return;
    }

    const totalMinutes = taskMode.requiresTime ? Number(form.horas || 0) * 60 + Number(form.minutos || 0) : null;

    setSaving(true);
    try {
      const payload = {
        encargado_id: user.id,
        trabajador_id: Number(form.trabajador_id),
        tarea_id: Number(form.tarea_id),
        tarea_nombre: getTaskTitle(selectedTask),
        fecha_registro: todayLimaISO(),
        cantidad: Number(form.cantidad),
        tiempo_minutos: totalMinutes,
        codigo_guia: taskUsesGuideBreakdown(selectedTask) && form.usaCodigoGuia ? form.codigo_guia.trim() : null,
        lote: taskUsesLote(selectedTask) && form.usaLote ? form.lote.trim().toUpperCase() : null,
        detalle: form.detalle.trim() || null
      };

      await createGroupLeaderRecord(payload);
      setStatus({ type: "success", message: "Registro guardado correctamente." });
      resetForm();
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="group-dashboard stack">
      <section className="group-hero">
        <div>
          <p className="eyebrow">{user.rol || "Jefe de equipo"}</p>
          <h2>Registrar actividad por tiempo</h2>
          <span>{user.nombre || user.email}</span>
        </div>
        <div className="group-metrics" aria-label="Resumen de registros">
          <MetricTile icon={ClipboardCheck} label="Registros" value={metrics.total} />
          <MetricTile icon={Timer} label="Hoy" value={metrics.today} />
          <MetricTile icon={UserRound} label="Mios" value={metrics.mine} />
          <MetricTile icon={Hash} label="Con guía/lote" value={metrics.adicionales} />
        </div>
      </section>

      <div className="group-layout">
        <Panel
          title="Nuevo registro independiente"
          eyebrow="Cantidad y tiempo"
          className="group-form-panel"
          actions={<Button variant="secondary" icon={RefreshCcw} onClick={reload}>Actualizar</Button>}
        >
          {loading ? <LoadingBlock /> : null}
          {error ? <Alert type="error">{error}</Alert> : null}
          {status ? <Alert type={status.type}>{status.message}</Alert> : null}
          <Alert>
            Este formulario crea un registro de actividad por tiempo para el operante seleccionado.
          </Alert>
          {!loading && !workers.length ? <Alert>No hay trabajadores operantes activos.</Alert> : null}
          {!loading && !tasks.length ? <Alert>No hay tareas registradas en la base de datos.</Alert> : null}

          <form className="group-form form-grid" onSubmit={handleSubmit}>
            <SelectInput
              label="Operante"
              value={form.trabajador_id}
              onChange={(trabajador_id) => updateForm({ trabajador_id })}
              options={[
                { value: "", label: "Selecciona operante" },
                ...workers.map((worker) => ({
                  value: String(worker.id),
                  label: `${worker.nombre || worker.email} - ${worker.email || `ID ${worker.id}`}`
                }))
              ]}
            />
            <SelectInput
              label="Tarea"
              value={form.tarea_id}
              onChange={(tarea_id) =>
                setForm({
                  ...initialForm,
                  trabajador_id: form.trabajador_id,
                  tarea_id
                })
              }
              options={[
                { value: "", label: "Selecciona tarea" },
                ...tasks.map((task) => ({
                  value: String(task.id),
                  label: `${getTaskTitle(task) || "Sin nombre"} - ID ${task.id}`
                }))
              ]}
            />

            {selectedTask ? <DynamicGroupFields mode={taskMode} task={selectedTask} form={form} updateForm={updateForm} /> : null}

            <TextArea
              label="Detalle"
              value={form.detalle}
              onChange={(detalle) => updateForm({ detalle })}
              placeholder={taskMode.completedOnly ? "Realizado" : "Comentario opcional"}
            />

            <div className="form-span form-note group-registrar">
              <BadgeCheck />
              <span>
                Registrado por: <strong>{user.nombre || user.email}</strong>
              </span>
            </div>

            <div className="form-span form-actions">
              <Button type="submit" icon={Save} loading={saving}>Guardar registro</Button>
            </div>
          </form>
        </Panel>

        <Panel title="Seleccion actual" eyebrow="Reglas de tarea" className="group-context-panel">
          <div className="selection-list">
            <SelectionLine icon={UsersRound} label="Operante" value={selectedWorker?.nombre || selectedWorker?.email || "-"} />
            <SelectionLine icon={ClipboardCheck} label="Tarea" value={getTaskTitle(selectedTask) || "-"} />
            <SelectionLine icon={Filter} label="Tipo" value={taskMode.label} />
          </div>
          <div className="mode-pills">
            {modePills(taskMode).map((pill) => (
              <span key={pill}>{pill}</span>
            ))}
          </div>
        </Panel>
      </div>

      <Panel
        title="Historial registrado"
        eyebrow="Datos de la base"
        actions={<Button variant="secondary" icon={RefreshCcw} onClick={reload}>Actualizar</Button>}
      >
        <div className="history-toolbar">
          <div className="scope-switch" aria-label="Alcance de registros">
            <button
              type="button"
              className={filters.scope === "all" ? "active" : ""}
              onClick={() => updateFilters({ scope: "all" })}
            >
              Todos
            </button>
            <button
              type="button"
              className={filters.scope === "mine" ? "active" : ""}
              onClick={() => updateFilters({ scope: "mine" })}
            >
              Mios
            </button>
          </div>
          <SelectInput
            label="Operante"
            value={filters.workerId}
            onChange={(workerId) => updateFilters({ workerId })}
            options={[
              { value: "", label: "Todos" },
              ...workers.map((worker) => ({
                value: String(worker.id),
                label: worker.nombre || worker.email || `ID ${worker.id}`
              }))
            ]}
          />
          <SelectInput
            label="Tarea"
            value={filters.taskId}
            onChange={(taskId) => updateFilters({ taskId })}
            options={[
              { value: "", label: "Todas" },
              ...tasks.map((task) => ({
                value: String(task.id),
                label: getTaskTitle(task) || `ID ${task.id}`
              }))
            ]}
          />
          <label className="field search-field">
            <span className="field-label">Buscar</span>
            <span className="search-input">
              <Search />
              <input
                className="input"
                value={filters.search}
                onChange={(event) => updateFilters({ search: event.target.value })}
                placeholder="Nombre, tarea, guia, lote"
              />
            </span>
          </label>
        </div>

        <DataTable rows={rows} columns={historyColumns} empty="Sin registros para los filtros actuales." compact />
      </Panel>
    </div>
  );
}

function DynamicGroupFields({ mode, task, form, updateForm }) {
  if (mode.completedOnly) {
    return (
      <div className="form-span">
        <Alert>Esta tarea se guarda como realizado.</Alert>
      </div>
    );
  }

  return (
    <>
      {mode.requiresQuantity ? (
        <TextInput
          label="Cantidad realizada"
          type="number"
          min="1"
          step="1"
          value={form.cantidad}
          onChange={(cantidad) => updateForm({ cantidad })}
        />
      ) : null}
      {mode.requiresTime ? (
        <>
          <TextInput
            label="Horas"
            type="number"
            min="0"
            step="1"
            value={form.horas}
            onChange={(horas) => updateForm({ horas })}
          />
          <TextInput
            label="Minutos"
            type="number"
            min="0"
            max="59"
            step="1"
            value={form.minutos}
            onChange={(minutos) => updateForm({ minutos })}
          />
        </>
      ) : null}
      {taskUsesGuideBreakdown(task) ? (
        <>
          <CheckboxInput
            label="Añadir número de guía"
            checked={form.usaCodigoGuia}
            onChange={(usaCodigoGuia) => updateForm({ usaCodigoGuia, codigo_guia: usaCodigoGuia ? form.codigo_guia : "" })}
            hint="Disponible solo para las dos tareas de Revisión de Guía."
          />
          {form.usaCodigoGuia ? (
            <TextInput
              label="Número de guía"
              value={form.codigo_guia}
              onChange={(codigo_guia) => updateForm({ codigo_guia })}
              placeholder="Ej. GUIA-001"
            />
          ) : null}
        </>
      ) : null}
      {taskUsesLote(task) ? (
        <CheckboxInput
          label="Añadir código de lote"
          checked={form.usaLote}
          onChange={(usaLote) => updateForm({ usaLote, lote: usaLote ? form.lote : "" })}
          hint="Disponible solo para Etiquetado."
        />
      ) : null}
      {taskUsesLote(task) && form.usaLote ? (
        <TextInput
          label="Código de lote"
          value={form.lote}
          onChange={(lote) => updateForm({ lote: lote.toUpperCase() })}
          placeholder="Ej. A05"
        />
      ) : null}
    </>
  );
}

function resolveGroupTaskMode(task) {
  if (!task) {
    return {
      mode: "none",
      label: "-",
      requiresQuantity: true,
      requiresGuideCode: false,
      requiresTime: false,
      requiresLote: false,
      completedOnly: false
    };
  }

  const mode = getGroupLeaderTaskMode(getTaskTitle(task));
  const measurementType = normalizeMeasurementType(task?.tipo_medicion);
  const extraName = normalizeText(task?.nombre_dato_extra);

  if (isGroupLeaderTimeTask(task)) {
    return {
      ...mode,
      mode: "tiempo",
      label: "Cantidad y tiempo",
      requiresQuantity: true,
      requiresGuideCode: taskUsesGuideBreakdown(task),
      requiresTime: true,
      requiresLote: taskUsesLote(task),
      completedOnly: false
    };
  }

  if (extraName.includes("lote")) {
    return {
      ...mode,
      mode: "lote",
      label: "Lote",
      requiresQuantity: true,
      requiresTime: false,
      requiresLote: true,
      completedOnly: false
    };
  }

  if (measurementType === "turno" && mode.mode === "cantidad") {
    return {
      mode: "turno",
      label: "Turno realizado",
      requiresQuantity: false,
      requiresGuideCode: false,
      requiresTime: false,
      requiresLote: false,
      completedOnly: true
    };
  }

  return mode;
}

function modePills(mode) {
  if (mode.mode === "none") return ["Sin tarea"];

  const pills = [];
  if (mode.completedOnly) pills.push("Realizado");
  if (mode.requiresQuantity) pills.push("Cantidad");
  if (mode.requiresTime) pills.push("Tiempo");
  if (mode.requiresGuideCode) pills.push("Codigo guia");
  if (mode.requiresLote) pills.push("Lote");
  return pills.length ? pills : ["Registro"];
}

function MetricTile({ icon: Icon, label, value }) {
  return (
    <div className="group-metric">
      <Icon />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SelectionLine({ icon: Icon, label, value }) {
  return (
    <div className="selection-line">
      <Icon />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatNumber(value) {
  if (value === null || value === undefined || value === "") return "";
  return Number(value).toLocaleString("es-PE");
}

function formatDuration(value) {
  const total = Number(value || 0);
  if (!total) return "";
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (!hours) return `${minutes} min`;
  if (!minutes) return `${hours} h`;
  return `${hours} h ${minutes} min`;
}
