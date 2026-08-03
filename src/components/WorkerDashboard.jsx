import { useMemo, useState } from "react";
import { CheckCircle2, Minus, Plus, RefreshCcw, Save, X } from "lucide-react";
import {
  createWorkerActivityLog,
  friendlyError,
  getTasksForUser,
  listBrands,
  listTiendas,
  listTaskScoreRanges,
  listTasks,
  listWorkerActivityLogs
} from "../lib/repository";
import { formatDateTimeLima, todayLimaISO } from "../lib/dates";
import {
  calculatePoints,
  displayShiftFromQuantity,
  FULL_SHIFT,
  getActivityCaptureMode,
  getTaskTitle,
  isGroupLeaderTimeTask,
  isFullShift,
  NO_TASK_OPTION,
  normalizeMeasurementType,
  SIMPLE_SHIFT,
  taskUsesBrandsByDefault,
  taskUsesGuideBreakdown,
  taskUsesLote,
  taskUsesStore
} from "../lib/scoring";
import { useAsyncData } from "../lib/hooks";
import {
  Alert,
  Button,
  CheckboxInput,
  DataTable,
  IconButton,
  LoadingBlock,
  Panel,
  SelectInput,
  Tabs,
  TextArea,
  TextInput
} from "./ui";
import { BrandDistribution, brandTotal, emptyBrandShare } from "./BrandDistribution";
import { emptyGuideShare, GuideDistribution, guideTotal } from "./GuideDistribution";

function emptyRecord() {
  return {
    taskKey: "",
    cantidad: "",
    usaMarcas: false,
    lote: "",
    tiendaId: "",
    usaGuias: false,
    guias: [emptyGuideShare()],
    marcas: [emptyBrandShare()],
    cumplimiento: true,
    turno: SIMPLE_SHIFT,
    detalle: ""
  };
}

export default function WorkerDashboard({ user, embedded = false }) {
  const [tab, setTab] = useState("Registrar actividad");

  return (
    <div className={embedded ? "stack embedded-worker" : "stack"}>
      <Tabs tabs={["Registrar actividad", "Historial"]} active={tab} onChange={setTab} />
      {tab === "Registrar actividad" ? <RegisterActivity user={user} /> : <WorkerHistory user={user} />}
    </div>
  );
}

function RegisterActivity({ user }) {
  const { data, loading, error, reload } = useAsyncData(
    async () => {
      const [tasks, brands, stores] = await Promise.all([getTasksForUser(user), listBrands(), listTiendas()]);
      return { tasks, brands, stores: stores.filter((store) => String(store.activo ?? true) !== "false") };
    },
    [user?.id],
    { tasks: [], brands: [], stores: [] }
  );
  const tasks = data.tasks || [];
  const brands = data.brands || [];
  const stores = data.stores || [];
  const [records, setRecords] = useState([emptyRecord()]);
  const [status, setStatus] = useState(null);
  const [successDialog, setSuccessDialog] = useState(null);
  const [saving, setSaving] = useState(false);

  const taskMap = useMemo(() => {
    return Object.fromEntries(
      tasks
        .slice()
        .sort((a, b) => Number(a.id || 0) - Number(b.id || 0))
        .map((task) => [`${task.id} - ${getTaskTitle(task) || "Sin titulo"}`, task])
    );
  }, [tasks]);

  const taskKeys = Object.keys(taskMap);

  function updateRecord(index, changes) {
    setRecords((current) =>
      current.map((record, recordIndex) => (recordIndex === index ? { ...record, ...changes } : record))
    );
  }

  function handleTaskChange(index, taskKey) {
    const task = taskMap[taskKey];
    setRecords((current) =>
      current.map((record, recordIndex) =>
        recordIndex === index
          ? {
              ...emptyRecord(),
              taskKey,
              usaMarcas: taskUsesBrandsByDefault(task),
              usaGuias: taskUsesGuideBreakdown(task)
            }
          : record
      )
    );
  }

  function addRecord() {
    if (records.length >= taskKeys.length) return;
    setRecords([...records, emptyRecord()]);
  }

  function removeRecord() {
    if (records.length <= 1) return;
    setRecords(records.slice(0, -1));
  }

  function removeRecordAt(index) {
    setRecords((current) => {
      if (current.length === 1) return [emptyRecord()];
      return current.filter((_, recordIndex) => recordIndex !== index);
    });
    setStatus(null);
  }

  function selectedTaskFor(record) {
    return taskMap[record.taskKey] || null;
  }

  function recordPayloadShape(record) {
    const task = selectedTaskFor(record);
    const title = getTaskTitle(task);
    const dbType = normalizeMeasurementType(task?.tipo_medicion);
    const [fallbackType, fallbackUnit] = getActivityCaptureMode(title);
    const type = isGroupLeaderTimeTask(task) ? "tiempo" : task?.tipo_medicion ? dbType : normalizeMeasurementType(fallbackType);
    const unit = task?.unidad_medida || task?.unidad_base || task?.unidad || fallbackUnit;
    const marcas = taskUsesBrandsByDefault(task) && record.usaMarcas
      ? record.marcas.map((item) => ({ marca_id: Number(item.marca_id), cantidad: Number(item.cantidad) }))
      : [];
    const guias = taskUsesGuideBreakdown(task) && record.usaGuias
      ? record.guias.map((item) => ({ numero_guia: String(item.numero_guia || "").trim(), cantidad: Number(item.cantidad) }))
      : [];
    const usesStore = taskUsesStore(task);
    const tiendaId = usesStore && record.tiendaId ? Number(record.tiendaId) : null;
    const lote = taskUsesLote(task) ? String(record.lote || "").trim().toUpperCase() || null : null;

    let cantidad = null;
    let cantidadPuntaje = null;
    let tiempoMinutos = null;
    let cumplimiento = record.cumplimiento;
    let turno = null;

    if (type === "cantidad") {
      cantidad = guias.length ? guideTotal(guias) : record.cantidad === "" ? null : Number(record.cantidad);
      cumplimiento = true;
    }
    if (type === "tiempo") {
      cantidad = record.cantidad === "" ? null : Number(record.cantidad);
      tiempoMinutos = null;
      cumplimiento = true;
    }
    if (type === "fijo") {
      cumplimiento = true;
    }
    if (type === "turno") {
      turno = record.turno;
      cantidadPuntaje = record.turno === FULL_SHIFT ? 2 : 1;
      cumplimiento = true;
    }

    return {
      task,
      title,
      type,
      unit,
      cantidad,
      cantidadPuntaje,
      tiempoMinutos,
      cumplimiento,
      turno,
      marcas,
      guias,
      usesStore,
      tiendaId,
      lote
    };
  }

  function validateRecords() {
    if (!records.length || records.some((record) => !record.taskKey || record.taskKey === NO_TASK_OPTION)) {
      return "Debe seleccionar una tarea en cada registro.";
    }

    const seen = new Set();
    for (const record of records) {
      if (seen.has(record.taskKey)) return "No puedes repetir la misma tarea en el mismo envio.";
      seen.add(record.taskKey);

      const shape = recordPayloadShape(record);
      if (shape.usesStore && !stores.some((store) => String(store.id) === String(record.tiendaId))) {
        return `Selecciona una tienda valida para ${shape.title}.`;
      }
      if (shape.guias.length) {
        if (shape.guias.some((item) => !item.numero_guia || !Number.isFinite(item.cantidad) || item.cantidad <= 0)) {
          return `Completa cada número de guía y su cantidad para ${shape.title}.`;
        }
        const normalizedGuides = shape.guias.map((item) => item.numero_guia.toLowerCase());
        if (new Set(normalizedGuides).size !== normalizedGuides.length) {
          return `No puedes repetir un número de guía en ${shape.title}.`;
        }
      }
      if (taskUsesBrandsByDefault(shape.task) && record.usaMarcas) {
        const total = Number(record.cantidad || 0);
        const distributed = brandTotal(record.marcas);
        if (total <= 0) return `Ingresa primero la cantidad total para ${shape.title}.`;
        if (!record.marcas.length || record.marcas.some((item) => !item.marca_id || Number(item.cantidad) <= 0)) {
          return `Completa cada marca y su cantidad para ${shape.title}.`;
        }
        if (new Set(record.marcas.map((item) => String(item.marca_id))).size !== record.marcas.length) {
          return `No puedes repetir una marca en ${shape.title}.`;
        }
        if (distributed !== total) {
          return `La distribución por marcas de ${shape.title} debe sumar exactamente ${total}. Actualmente suma ${distributed}.`;
        }
      }
      if (shape.type === "cantidad" && !record.usaMarcas && !shape.guias.length && (record.cantidad === "" || Number(record.cantidad) < 0)) {
        return `Ingresa una cantidad valida para ${shape.title}.`;
      }
      if (shape.type === "tiempo" && (record.cantidad === "" || Number(record.cantidad) <= 0)) {
        return `Ingresa la cantidad realizada para ${shape.title}.`;
      }
    }

    if (records.some((record) => isFullShift(record.turno)) && records.length > 1) {
      return "Si seleccionas turno completo, no puedes registrar otras actividades el mismo dia.";
    }

    return "";
  }

  async function handleSave() {
    setStatus(null);
    setSuccessDialog(null);
    const validation = validateRecords();
    if (validation) {
      setStatus({ type: "error", message: validation });
      return;
    }

    setSaving(true);
    try {
      const today = todayLimaISO();
      const existingLogs = await listWorkerActivityLogs(user.id);
      const logsToday = existingLogs.filter((log) => String(log.fecha_registro) === today);
      const hasFullShiftInBatch = records.some((record) => isFullShift(record.turno));

      if (logsToday.length) {
        if (hasFullShiftInBatch) {
          setStatus({ type: "error", message: "No puedes registrar turno completo porque ya tienes actividades hoy." });
          return;
        }
        if (logsToday.some((log) => isFullShift(log.turno))) {
          setStatus({ type: "error", message: "Ya registraste turno completo hoy. No puedes anadir mas actividades." });
          return;
        }
      }

      let saved = 0;
      let totalPoints = 0;
      const failures = [];

      for (const record of records) {
        try {
          const shape = recordPayloadShape(record);
          const taskForPoints = { ...shape.task };
          if (shape.type === "cantidad") {
            taskForPoints.rangos_puntaje = await listTaskScoreRanges(shape.task.id);
          }
          const points = calculatePoints(
            taskForPoints,
            shape.cantidadPuntaje ?? shape.cantidad,
            shape.tiempoMinutos,
            shape.cumplimiento
          );
          const activityPayload = {
            trabajador_id: user.id,
            usuario_id: user.id,
            tarea_id: shape.task.id,
            actividad_nombre: shape.title,
            fecha_registro: today,
            cantidad: shape.cantidad,
            tipo_medicion: shape.type,
            cumplimiento: shape.cumplimiento,
            detalle: record.detalle.trim() || null,
            turno: shape.turno,
            tienda_id: shape.tiendaId,
            lote: shape.lote,
            puntos_obtenidos: points,
            marcas: shape.marcas,
            guias: shape.guias
          };
          if (shape.tiempoMinutos !== null && shape.tiempoMinutos !== undefined) {
            activityPayload.tiempo_minutos = shape.tiempoMinutos;
          }
          await createWorkerActivityLog(activityPayload);
          saved += 1;
          totalPoints += Number(points || 0);
        } catch (err) {
          failures.push({ tarea: selectedTaskFor(record)?.titulo || record.taskKey, error: friendlyError(err) });
        }
      }

      if (failures.length) {
        setStatus({
          type: "error",
          message: `${failures.length} registros fallaron. ${failures[0]?.error || "Revisa la base de datos."}`
        });
        return;
      }

      setRecords([emptyRecord()]);
      setSuccessDialog({ saved, totalPoints });
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel
      title="Registrar lo realizado"
      eyebrow="Operaciones"
      actions={<Button variant="secondary" icon={RefreshCcw} onClick={reload}>Actualizar tareas</Button>}
    >
      {loading ? <LoadingBlock /> : null}
      {error ? <Alert type="error">{error}</Alert> : null}
      {status ? <Alert type={status.type}>{status.message}</Alert> : null}
      {!loading && !tasks.length ? <Alert>No tienes tareas asignadas para registrar actividades.</Alert> : null}

      <div className="record-toolbar">
        <Button variant="secondary" icon={Plus} onClick={addRecord} disabled={records.length >= taskKeys.length}>
          Agregar tarea
        </Button>
        <Button variant="ghost" icon={Minus} onClick={removeRecord} disabled={records.length <= 1}>
          Quitar tarea
        </Button>
        <span>Registros a cargar: {records.length}</span>
      </div>

      <div className="records-list">
        {records.map((record, index) => {
          const selectedKeys = records.map((item, itemIndex) => (itemIndex === index ? null : item.taskKey)).filter(Boolean);
          const availableOptions = taskKeys.filter((key) => !selectedKeys.includes(key));
          const selectedTask = selectedTaskFor(record);
          return (
            <div className="record-card" key={index}>
              <div className="record-card-header">
                <div className="record-title">Registro {index + 1}</div>
                <IconButton
                  type="button"
                  className="record-remove-btn"
                  label={`Quitar registro ${index + 1}`}
                  icon={X}
                  onClick={() => removeRecordAt(index)}
                />
              </div>
              <SelectInput
                label="Tarea realizada"
                value={record.taskKey || (index === 0 ? NO_TASK_OPTION : "")}
                onChange={(taskKey) => handleTaskChange(index, taskKey)}
                options={[
                  ...(index === 0 ? [] : [{ value: "", label: "Selecciona una tarea" }]),
                  ...(index === 0 ? [{ value: NO_TASK_OPTION, label: "Ninguno" }] : []),
                  ...availableOptions.map((key) => ({ value: key, label: key }))
                ]}
              />
              {!selectedTask || record.taskKey === NO_TASK_OPTION ? (
                <Alert>Selecciona una tarea para completar este registro.</Alert>
              ) : (
                <DynamicRecordFields
                  record={record}
                  task={selectedTask}
                  brands={brands}
                  stores={stores}
                  onChange={(changes) => updateRecord(index, changes)}
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="form-actions sticky-actions">
        <Button icon={Save} loading={saving} onClick={handleSave} disabled={!tasks.length}>Guardar registros</Button>
      </div>

      {successDialog ? (
        <div className="save-success-overlay" role="presentation">
          <section
            className="save-success-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="save-success-title"
            aria-describedby="save-success-description"
          >
            <div className="save-success-icon" aria-hidden="true">
              <CheckCircle2 />
            </div>
            <div className="save-success-copy">
              <p className="eyebrow">Proceso completado</p>
              <h2 id="save-success-title">¡Registros guardados correctamente!</h2>
              <p id="save-success-description">
                Se guardaron {successDialog.saved} registro{successDialog.saved === 1 ? "" : "s"} sin errores.
              </p>
              <strong>Puntos acumulados: {successDialog.totalPoints}</strong>
            </div>
            <Button
              type="button"
              className="save-success-confirm"
              autoFocus
              onClick={() => setSuccessDialog(null)}
            >
              OK, continuar
            </Button>
          </section>
        </div>
      ) : null}
    </Panel>
  );
}

function DynamicRecordFields({ record, task, brands, stores, onChange }) {
  const title = getTaskTitle(task);
  const dbType = normalizeMeasurementType(task?.tipo_medicion);
  const [fallbackType, fallbackUnit] = getActivityCaptureMode(title);
  const type = isGroupLeaderTimeTask(task) ? "tiempo" : task?.tipo_medicion ? dbType : normalizeMeasurementType(fallbackType);
  const unit = task?.unidad_medida || task?.unidad_base || task?.unidad || fallbackUnit || "unidades";
  const usesGuideBreakdown = taskUsesGuideBreakdown(task);
  const usesStore = taskUsesStore(task);

  if (type === "cantidad") {
    return (
      <div className="form-grid">
        {!usesGuideBreakdown || !record.usaGuias ? (
          <TextInput
            label={`Cantidad (${unit})`}
            type="number"
            min="0"
            value={record.cantidad}
            onChange={(cantidad) => onChange({ cantidad })}
          />
        ) : null}
        {taskUsesBrandsByDefault(task) ? <BrandFields record={record} brands={brands} onChange={onChange} /> : null}
        {usesGuideBreakdown ? <GuideFields record={record} onChange={onChange} /> : null}
        {taskUsesLote(task) ? <LoteField record={record} onChange={onChange} /> : null}
        <OptionalContextFields record={record} stores={stores} onChange={onChange} showStore={usesStore} />
        <TextArea label="Detalle" value={record.detalle} onChange={(detalle) => onChange({ detalle })} placeholder="Comentarios opcionales" />
      </div>
    );
  }

  if (type === "tiempo") {
    return (
      <div className="form-grid">
        <TextInput
          label="Cantidad realizada"
          type="number"
          min="1"
          step="1"
          value={record.cantidad}
          onChange={(cantidad) => onChange({ cantidad })}
        />
        {taskUsesBrandsByDefault(task) ? <BrandFields record={record} brands={brands} onChange={onChange} /> : null}
        {taskUsesLote(task) ? <LoteField record={record} onChange={onChange} /> : null}
        <OptionalContextFields record={record} stores={stores} onChange={onChange} showStore={usesStore} />
        <TextArea label="Detalle" value={record.detalle} onChange={(detalle) => onChange({ detalle })} placeholder="Comentarios opcionales" />
      </div>
    );
  }

  if (type === "fijo") {
    return (
      <div className="form-grid">
        <CheckboxInput
          label="Cumplido"
          checked
          disabled
          hint="Esta tarea siempre se registra como cumplida."
        />
        <OptionalContextFields record={record} stores={stores} onChange={onChange} showStore={usesStore} />
        <TextArea label="Detalle" value={record.detalle} onChange={(detalle) => onChange({ detalle })} placeholder="Comentarios opcionales" />
        <Alert>Esta tarea usa el puntaje fijo definido por administracion.</Alert>
      </div>
    );
  }

  return (
    <div className="form-grid">
      <SelectInput
        label="Turno"
        value={record.turno}
        onChange={(turno) => onChange({ turno })}
        options={[SIMPLE_SHIFT, FULL_SHIFT]}
      />
      <OptionalContextFields record={record} stores={stores} onChange={onChange} showStore={usesStore} />
      <TextArea label="Detalle" value={record.detalle} onChange={(detalle) => onChange({ detalle })} placeholder="Comentarios opcionales" />
      <Alert>
        Puntaje configurado: simple {task.puntaje_turno_simple || task.puntos_turno_simple || 0}, completo{" "}
        {task.puntaje_turno_completo || task.puntos_turno_completo || 0}.
      </Alert>
    </div>
  );
}

function OptionalContextFields({ record, stores, onChange, showStore = false }) {
  return (
    <>
      {showStore ? (
        <SelectInput
          label="Tienda"
          value={record.tiendaId}
          onChange={(tiendaId) => onChange({ tiendaId })}
          options={[
            { value: "", label: "Selecciona una tienda" },
            ...stores.map((store) => ({ value: String(store.id), label: store.nombre }))
          ]}
        />
      ) : null}
    </>
  );
}

function GuideFields({ record, onChange }) {
  return (
    <>
      <CheckboxInput
        label="Registrar varias guías"
        checked={record.usaGuias}
        onChange={(usaGuias) => onChange({
          usaGuias,
          guias: record.guias?.length ? record.guias : [emptyGuideShare()]
        })}
        hint="Disponible solo para Revisión de Guía. El puntaje se calculará una sola vez con la suma total."
      />
      {record.usaGuias ? (
        <GuideDistribution items={record.guias} onChange={(guias) => onChange({ guias })} />
      ) : null}
    </>
  );
}

function LoteField({ record, onChange }) {
  return (
    <TextInput
      label="Lote"
      value={record.lote}
      onChange={(lote) => onChange({ lote: lote.toUpperCase() })}
      placeholder="Ej. A05"
    />
  );
}

function BrandFields({ record, brands, onChange }) {
  return (
    <>
      <CheckboxInput
        label="Añadir marcas"
        checked={record.usaMarcas}
        onChange={(usaMarcas) =>
          onChange({
            usaMarcas,
            usaGuias: usaMarcas ? false : record.usaGuias,
            marcas: record.marcas?.length ? record.marcas : [emptyBrandShare()]
          })
        }
        hint="Actívalo para repartir la cantidad entre las marcas existentes."
      />
      {record.usaMarcas ? (
        <BrandDistribution
          brands={brands}
          items={record.marcas}
          expectedTotal={record.cantidad}
          onChange={(marcas) => onChange({ marcas })}
        />
      ) : null}
    </>
  );
}

export function WorkerHistory({ user }) {
  const { data, loading, error, reload } = useAsyncData(
    async () => {
      const [logs, tasks, stores] = await Promise.all([listWorkerActivityLogs(user.id), listTasks(), listTiendas()]);
      return { logs, tasks, stores };
    },
    [user?.id],
    { logs: [], tasks: [], stores: [] }
  );

  const taskNameById = Object.fromEntries((data.tasks || []).map((task) => [task.id, getTaskTitle(task) || `Tarea ${task.id}`]));
  const storeNameById = Object.fromEntries((data.stores || []).map((store) => [store.id, store.nombre]));
  const rows = (data.logs || []).map((log) => {
    const taskName = taskNameById[log.tarea_id] || log.actividad_nombre || "";
    const [tipoAct] = getActivityCaptureMode(taskName);
    return {
      Fecha: formatDateTimeLima(log.created_at) || log.fecha_registro,
      Tarea: taskName,
      Cantidad: log.cantidad ?? "",
      Turno: log.turno || (tipoAct === "turno" ? displayShiftFromQuantity(log.cantidad) : ""),
      Cumplimiento: log.cumplimiento,
      Puntos: log.puntos_obtenidos,
      Tienda: storeNameById[log.tienda_id] || "",
      Guia: log.numero_guia || "",
      Lote: log.lote || "",
      Marcas: (log.marcas || []).map((item) => `${item.marca_nombre}: ${item.cantidad}`).join(", "),
      Detalle: log.detalle
    };
  });

  return (
    <Panel title="Historial" eyebrow="Registros" actions={<Button variant="secondary" icon={RefreshCcw} onClick={reload}>Actualizar</Button>}>
      {loading ? <LoadingBlock /> : null}
      {error ? <Alert type="error">{error}</Alert> : null}
      {!loading && !rows.length ? <Alert>Aun no tienes registros.</Alert> : null}
      <DataTable rows={rows} />
    </Panel>
  );
}
