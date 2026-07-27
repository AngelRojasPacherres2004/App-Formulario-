export const NO_TASK_OPTION = "Ninguno";
export const SIMPLE_SHIFT = "Turno manana o tarde";
export const FULL_SHIFT = "Turno manana y tarde";
export const MAX_SCORE_QUANTITY = 99_999_999.99;

export function normalizeText(value) {
  const replacements = {
    "?": "o",
    "(": " ",
    ")": " ",
    "-": " "
  };

  let text = String(value || "").trim().toLowerCase();
  Object.entries(replacements).forEach(([oldValue, newValue]) => {
    text = text.replaceAll(oldValue, newValue);
  });

  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pointsByThreshold(value, thresholds) {
  let points = 0;
  thresholds.forEach(([minValue, score]) => {
    if (value >= minValue) points = score;
  });
  return points;
}

export function normalizeRole(role) {
  const value = normalizeText(role);
  return value === "trabajador" ? "operante" : value;
}

export function isWorkerRole(role) {
  return ["trabajador", "operante"].includes(normalizeRole(role));
}

export function normalizeMeasurementType(value) {
  const raw = normalizeText(value);
  if (raw === "cantidad") return "cantidad";
  if (raw === "fijo") return "fijo";
  if (raw === "turno") return "turno";
  if (raw === "cumplimiento") return "fijo";
  if (raw === "tiempo") return "tiempo";
  return "cantidad";
}

export function normalizeScoringRule(rule = {}) {
  const type = normalizeText(rule.tipo_regla || rule.tipo || "cantidad").toUpperCase();
  const from = rule.desde ?? rule.cantidad_desde ?? null;
  const to = rule.hasta ?? rule.cantidad_hasta ?? null;

  return {
    ...rule,
    tipo_regla: type,
    desde: from === "" ? null : from,
    hasta: to === "" ? null : to,
    cantidad_desde: from === "" ? null : from,
    cantidad_hasta: to === "" ? null : to,
    puntos: Number.parseInt(rule.puntos || 0, 10),
    turno: rule.turno || null
  };
}

export function applyScoringRules(task, rules = []) {
  const normalizedRules = (rules || []).map(normalizeScoringRule);
  const firstType = normalizedRules[0]?.tipo_regla;
  const enriched = {
    ...task,
    reglas_puntaje: normalizedRules,
    rangos_puntaje: normalizedRules.filter((rule) => rule.tipo_regla === "CANTIDAD")
  };

  if (!firstType && task?.requiere_tiempo) enriched.tipo_medicion = "tiempo";

  if (firstType === "CANTIDAD") enriched.tipo_medicion = "cantidad";
  if (firstType === "FIJO") {
    enriched.tipo_medicion = "fijo";
    enriched.puntaje_fijo = normalizedRules.find((rule) => rule.tipo_regla === "FIJO")?.puntos || 1;
  }
  if (firstType === "TURNO") {
    enriched.tipo_medicion = "turno";
    const simple = normalizedRules.find((rule) => normalizeText(rule.turno) === "simple");
    const complete = normalizedRules.find((rule) => normalizeText(rule.turno) === "completo");
    enriched.puntaje_turno_simple = simple?.puntos || 1;
    enriched.puntaje_turno_completo = complete?.puntos || 1;
  }

  return enriched;
}

export function getTaskTitle(task) {
  return String(task?.titulo || task?.nombre || "");
}

const groupLeaderTimeTaskNames = new Set([
  "etiquetado",
  "envio nuevo",
  "visita de tienda",
  "picking",
  "embalado y rotulado de guia"
]);

const defaultBrandTaskNames = new Set([
  "etiquetado",
  "visita de tienda",
  "pedido mayorista",
  "picking",
  "pistoleado",
  "embalado y rotulado de guia",
  "inventario"
]);

export function isGroupLeaderTimeTask(task) {
  return groupLeaderTimeTaskNames.has(normalizeText(getTaskTitle(task)));
}

export function isPairUnit(value) {
  const words = normalizeText(value).split(" ").filter(Boolean);
  return words.includes("par") || words.includes("pares");
}

export function taskUsesBrandsByDefault(task) {
  if (isPairUnit(task?.unidad_medida || task?.unidad_base || task?.unidad)) return true;
  if (typeof task?.requiere_marca === "boolean") return task.requiere_marca;
  return defaultBrandTaskNames.has(normalizeText(getTaskTitle(task)));
}

export function taskUsesGuideBreakdown(task) {
  return normalizeText(getTaskTitle(task)).startsWith("revision de guia");
}

export function getActivityCaptureMode(taskName) {
  const name = normalizeText(taskName);

  const turnoTasks = [
    "visitar tienda",
    "visita de tienda",
    "apoyo tienda",
    "apoyo a tienda",
    "apoyo inter area",
    "reposicion",
    "repocicion",
    "clasificacion"
  ];
  if (turnoTasks.some((item) => name.includes(item))) return ["turno", null];

  const cumplimientoTasks = [
    "sacar basura",
    "limpieza",
    "transporte de bulto en grupo",
    "transporte de bulto solo",
    "transporte de bulto",
    "cuadre lote supervision",
    "cuadre lote impresion codigos",
    "pedido por mayor",
    "recepcion de guia"
  ];
  if (cumplimientoTasks.some((item) => name.includes(item))) return ["cumplimiento", null];

  const quantityUnits = {
    codificacion: "pares",
    "micro inventario": "pares",
    "levantar informacion merma": "cajas",
    "recepcion de mercaderia descargar": "contenedores"
  };

  const quantityMatch = Object.entries(quantityUnits).find(([key]) => name.includes(key));
  if (quantityMatch) return ["cantidad", quantityMatch[1]];

  const timeTasks = ["pistoleado y embalado despacho", "envio nuevo", "etiquetado"];
  if (timeTasks.some((item) => name.includes(item))) return ["tiempo", "minutos"];

  return ["cantidad", "unidades"];
}

export function getGroupLeaderTaskMode(taskName) {
  const name = normalizeText(taskName);

  const completedOnlyKeywords = ["montacarga"];
  if (completedOnlyKeywords.some((keyword) => name.includes(keyword))) {
    return {
      mode: "realizado",
      label: "Realizado",
      requiresQuantity: false,
      requiresGuideCode: false,
      requiresTime: false,
      requiresLote: false,
      completedOnly: true
    };
  }

  const shiftKeywords = [
    "turno",
    "visita de tienda",
    "apoyo inter area"
  ];
  if (shiftKeywords.some((keyword) => name.includes(keyword))) {
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

  const loteKeywords = ["etiquetado", "codificado", "codificacion"];
  if (loteKeywords.some((keyword) => name.includes(keyword))) {
    return {
      mode: "lote",
      label: "Lote",
      requiresQuantity: true,
      requiresGuideCode: false,
      requiresTime: false,
      requiresLote: true,
      completedOnly: false
    };
  }

  const timeKeywords = [
    "embalado",
    "envio nuevo",
    "reposicion",
    "repocicion",
    "envio tienda",
    "envio a tienda",
    "peakin",
    "picking",
    "pickin"
  ];
  if (timeKeywords.some((keyword) => name.includes(keyword))) {
    return {
      mode: "tiempo",
      label: "Tiempo realizado",
      requiresQuantity: false,
      requiresGuideCode: false,
      requiresTime: true,
      requiresLote: false,
      completedOnly: false
    };
  }

  const guideKeywords = [
    "revision de guia",
    "revicicion de guia",
    "revisicion de guia",
    "recepcion de guia",
    "guia"
  ];
  if (guideKeywords.some((keyword) => name.includes(keyword))) {
    return {
      mode: "guia",
      label: "Codigo de guia",
      requiresQuantity: true,
      requiresGuideCode: true,
      requiresTime: true,
      requiresLote: false,
      completedOnly: false
    };
  }

  return {
    mode: "cantidad",
    label: "Cantidad realizada",
    requiresQuantity: true,
    requiresGuideCode: false,
    requiresTime: false,
    requiresLote: false,
    completedOnly: false
  };
}

function legacyCalculatePoints(taskName, cantidad, tiempoMinutos, cumplimiento) {
  const name = normalizeText(taskName);
  const quantity = Number(cantidad || 0);
  const minutes = Number(tiempoMinutos || 0);

  if (name.includes("visitar tienda") || name.includes("visita de tienda")) {
    if (quantity === 1) return 3;
    if (quantity === 2) return 6;
    return 0;
  }
  if (name.includes("apoyo a tienda") || name.includes("apoyo tienda")) {
    if (quantity === 1) return 4;
    if (quantity === 2) return 8;
    return 0;
  }
  if (name.includes("apoyo inter area")) {
    if (quantity === 1) return 3;
    if (quantity === 2) return 7;
    return 0;
  }
  if (name.includes("reposicion") || name.includes("repocicion")) {
    if (quantity === 1) return 3;
    if (quantity === 2) return 6;
    return 0;
  }
  if (name.includes("clasificacion")) {
    if (quantity === 1) return 3;
    if (quantity === 2) return 6;
    return 0;
  }
  if (name.includes("codificacion") || name.includes("recepcion de guia")) {
    return pointsByThreshold(quantity, [
      [15, 1],
      [50, 2],
      [100, 3],
      [150, 4],
      [300, 5],
      [350, 6],
      [400, 7],
      [450, 8],
      [500, 9],
      [600, 10]
    ]);
  }
  if (name.includes("micro inventario")) {
    return pointsByThreshold(quantity, [
      [50, 1],
      [150, 2],
      [250, 3],
      [350, 4],
      [450, 5],
      [550, 6],
      [650, 7],
      [750, 8],
      [850, 9],
      [1000, 10]
    ]);
  }
  if (name.includes("levantar informacion") || name.includes("merma")) {
    return pointsByThreshold(quantity, [
      [2, 1],
      [4, 2],
      [6, 3],
      [8, 4],
      [10, 5],
      [12, 6],
      [15, 7],
      [20, 10]
    ]);
  }
  if (name.includes("recepcion de mercaderia")) {
    return pointsByThreshold(quantity, [
      [1, 3],
      [2, 6],
      [3, 9]
    ]);
  }
  if (name.includes("pistoleado") || name.includes("embalado") || name.includes("envio nuevo")) {
    return pointsByThreshold(minutes, [
      [10, 1],
      [40, 2],
      [80, 3],
      [120, 4],
      [180, 5],
      [240, 6],
      [300, 7],
      [360, 8],
      [420, 9],
      [480, 10]
    ]);
  }

  const fixed = {
    "sacar basura": 1,
    limpieza: 1,
    "transporte de bulto en grupo": 2,
    "transporte de bulto montacarga": 2,
    "transporte de bulto solo": 4,
    "cuadre lote supervision": 2,
    "cuadre lote impresion codigos": 2,
    "pedido por mayor": 2
  };

  const fixedMatch = Object.entries(fixed).find(([key]) => name.includes(key));
  if (fixedMatch) return cumplimiento ? fixedMatch[1] : 0;
  return cumplimiento ? 1 : 0;
}

export function calculatePoints(task, cantidad, tiempoMinutos, cumplimiento) {
  const taskName = getTaskTitle(task);
  const rawMeasurement = normalizeText(task?.tipo_medicion);
  let tipoMedicion = "";

  if (rawMeasurement === "cumplimiento") tipoMedicion = "fijo";
  else if (["cantidad", "fijo", "tiempo", "turno"].includes(rawMeasurement)) tipoMedicion = rawMeasurement;

  if (!["cantidad", "fijo", "tiempo", "turno"].includes(tipoMedicion)) {
    return legacyCalculatePoints(taskName, cantidad, tiempoMinutos, cumplimiento);
  }

  if (tipoMedicion === "cantidad") {
    const ranges = Array.isArray(task?.reglas_puntaje)
      ? task.reglas_puntaje.filter((rule) => normalizeText(rule?.tipo_regla) === "cantidad")
      : Array.isArray(task?.rangos_puntaje) ? task.rangos_puntaje : [];
    const quantity = Number(cantidad || 0);
    let candidatePoints = 0;

    ranges
      .map((range) => ({
        points: Number.parseInt(range?.puntos || 0, 10),
        from: Number(range?.desde ?? range?.cantidad_desde ?? 0),
        to: (range?.hasta ?? range?.cantidad_hasta) === null || (range?.hasta ?? range?.cantidad_hasta) === undefined
          ? null
          : Number(range?.hasta ?? range?.cantidad_hasta)
      }))
      .sort((a, b) => (a.points || 999) - (b.points || 999))
      .forEach((range) => {
        if (!range.points) return;
        if (range.to === null && quantity >= range.from) candidatePoints = Math.max(candidatePoints, range.points);
        if (range.to !== null && quantity >= range.from && quantity <= range.to) {
          candidatePoints = Math.max(candidatePoints, range.points);
        }
      });

    return candidatePoints;
  }

  if (tipoMedicion === "fijo") {
    const score = task?.puntaje_fijo ?? task?.puntaje;
    return cumplimiento ? Number.parseInt(score || 0, 10) : 0;
  }

  if (tipoMedicion === "turno") {
    const simple = task?.puntaje_turno_simple ?? task?.puntos_turno_simple;
    const complete = task?.puntaje_turno_completo ?? task?.puntos_turno_completo;
    const quantity = Number.parseInt(Number(cantidad || 0), 10);
    if (quantity === 1) return Number.parseInt(simple || 0, 10);
    if (quantity === 2) return Number.parseInt(complete || 0, 10);
    return 0;
  }

  if (tipoMedicion === "tiempo") {
    return legacyCalculatePoints(taskName, cantidad, tiempoMinutos, cumplimiento);
  }

  return 0;
}

export function isFullShift(value) {
  const normalized = normalizeText(value);
  return normalized.includes("y tarde");
}

export function displayShiftFromQuantity(value) {
  return Number(value || 0) === 2 ? FULL_SHIFT : SIMPLE_SHIFT;
}

export function quantityThresholdDefaults(existingRanges = []) {
  const thresholds = Array(10).fill(0);
  existingRanges.forEach((range) => {
    const point = Number.parseInt(range?.puntos || 0, 10);
    if (point < 1 || point > 10) return;
    thresholds[point - 1] = Number(range?.cantidad_desde || 0);
  });

  for (let index = 1; index < thresholds.length; index += 1) {
    if (thresholds[index] < thresholds[index - 1]) thresholds[index] = thresholds[index - 1];
  }

  return thresholds;
}

export function thresholdsToRanges(thresholds) {
  return thresholds.map((threshold, index) => ({
    cantidad_desde: Number(threshold || 0),
    cantidad_hasta: null,
    puntos: index + 1
  }));
}

export function thresholdsAreAscending(thresholds) {
  return thresholds.every((threshold, index) => index === 0 || Number(threshold) >= Number(thresholds[index - 1]));
}

export function emptyQuantityRanges() {
  return Array.from({ length: 10 }, (_, index) => ({ desde: "", hasta: "", puntos: index + 1 }));
}

export function quantityRangesFromRules(existingRules = []) {
  const ranges = emptyQuantityRanges();
  existingRules
    .map(normalizeScoringRule)
    .filter((rule) => rule.tipo_regla === "CANTIDAD" && rule.puntos >= 1 && rule.puntos <= 10)
    .forEach((rule) => {
      ranges[rule.puntos - 1] = {
        desde: rule.desde ?? "",
        hasta: rule.hasta ?? "",
        puntos: rule.puntos
      };
    });
  return ranges;
}

export function validateQuantityRanges(ranges = []) {
  if (ranges.length !== 10) return "Debes configurar los 10 niveles de puntaje.";

  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    const from = range.desde === "" || range.desde === null ? null : Number(range.desde);
    const to = range.hasta === "" || range.hasta === null ? null : Number(range.hasta);
    if (from === null || !Number.isFinite(from) || from < 0) {
      return `Ingresa una cantidad inicial valida para ${index + 1} punto${index ? "s" : ""}.`;
    }
    if (from > MAX_SCORE_QUANTITY) {
      return `La cantidad inicial de ${index + 1} punto${index ? "s" : ""} no puede superar ${MAX_SCORE_QUANTITY.toLocaleString("es-PE")}.`;
    }
    if (index < ranges.length - 1 && (to === null || !Number.isFinite(to))) {
      return `Ingresa una cantidad final para ${index + 1} punto${index ? "s" : ""}.`;
    }
    if (to !== null && (!Number.isFinite(to) || to < from)) {
      return `El final del rango de ${index + 1} punto${index ? "s" : ""} no puede ser menor que el inicio.`;
    }
    if (to !== null && to > MAX_SCORE_QUANTITY) {
      return `La cantidad final de ${index + 1} punto${index ? "s" : ""} no puede superar ${MAX_SCORE_QUANTITY.toLocaleString("es-PE")}.`;
    }
    if (index > 0) {
      const previousTo = ranges[index - 1].hasta === "" || ranges[index - 1].hasta === null
        ? null
        : Number(ranges[index - 1].hasta);
      if (previousTo === null || from <= previousTo) {
        return `El rango de ${index + 1} puntos se cruza con el rango anterior.`;
      }
    }
  }
  return "";
}
