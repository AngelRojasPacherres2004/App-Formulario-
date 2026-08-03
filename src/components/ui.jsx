import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Save,
  Trash2
} from "lucide-react";

export function Button({
  children,
  icon: Icon,
  variant = "primary",
  size = "md",
  loading = false,
  className = "",
  disabled = false,
  ...props
}) {
  return (
    <button className={`btn btn-${variant} btn-${size} ${className}`} disabled={loading || disabled} {...props}>
      {loading ? <Loader2 className="btn-icon spin" /> : Icon ? <Icon className="btn-icon" /> : null}
      <span>{children}</span>
    </button>
  );
}

export function IconButton({ label, icon: Icon, variant = "ghost", ...props }) {
  return (
    <button className={`icon-btn icon-btn-${variant}`} aria-label={label} title={label} {...props}>
      <Icon />
    </button>
  );
}

export function Panel({ title, eyebrow, actions, children, className = "" }) {
  return (
    <section className={`panel ${className}`}>
      {(title || actions) && (
        <div className="panel-header">
          <div>
            {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
            {title ? <h2>{title}</h2> : null}
          </div>
          {actions ? <div className="panel-actions">{actions}</div> : null}
        </div>
      )}
      {children}
    </section>
  );
}

export function Field({ label, hint, error, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
      {error ? <span className="field-error">{error}</span> : null}
    </label>
  );
}

export function TextInput({ label, value, onChange, type = "text", hint, error, ...props }) {
  return (
    <Field label={label} hint={hint} error={error}>
      <input
        className="input"
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        {...props}
      />
    </Field>
  );
}

export function TextArea({ label, value, onChange, hint, error, ...props }) {
  return (
    <Field label={label} hint={hint} error={error}>
      <textarea className="textarea" value={value} onChange={(event) => onChange(event.target.value)} {...props} />
    </Field>
  );
}

export function SelectInput({ label, value, onChange, options, hint, error, ...props }) {
  return (
    <Field label={label} hint={hint} error={error}>
      <span className="select-wrap">
        <select className="select" value={value} onChange={(event) => onChange(event.target.value)} {...props}>
          {options.map((option) => {
            const valueOption = typeof option === "string" ? option : option.value;
            const labelOption = typeof option === "string" ? option : option.label;
            const disabledOption = typeof option === "string" ? false : Boolean(option.disabled);
            return (
              <option key={valueOption} value={valueOption} disabled={disabledOption}>
                {labelOption}
              </option>
            );
          })}
        </select>
        <ChevronDown className="select-icon" />
      </span>
    </Field>
  );
}

export function CheckboxInput({ label, checked, onChange, hint, disabled = false }) {
  return (
    <label className={`check-row ${disabled ? "disabled" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange?.(event.target.checked)}
      />
      <span>
        <strong>{label}</strong>
        {hint ? <small>{hint}</small> : null}
      </span>
    </label>
  );
}

export function Tabs({ tabs, active, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab}
          className={`tab ${active === tab ? "active" : ""}`}
          type="button"
          onClick={() => onChange(tab)}
        >
          {tab}
        </button>
      ))}
    </div>
  );
}

export function Alert({ type = "info", children }) {
  const Icon = type === "success" ? CheckCircle2 : AlertCircle;
  return (
    <div className={`alert alert-${type}`}>
      <Icon />
      <span>{children}</span>
    </div>
  );
}

export function DataTable({ rows, columns, empty = "Sin registros", compact = false, onRowClick }) {
  const normalizedRows = rows || [];
  const normalizedColumns =
    columns || Array.from(new Set(normalizedRows.flatMap((row) => Object.keys(row || {}))));

  if (!normalizedRows.length) return <div className="empty-state">{empty}</div>;

  return (
    <div className={`table-wrap ${compact ? "compact" : ""}`}>
      <table>
        <thead>
          <tr>
            {normalizedColumns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {normalizedRows.map((row, rowIndex) => (
            <tr
              key={row.id ?? rowIndex}
              className={onRowClick ? "table-row-action" : ""}
              role={onRowClick ? "button" : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={onRowClick ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onRowClick(row);
                }
              } : undefined}
            >
              {normalizedColumns.map((column) => (
                <td key={column}>{formatCell(row[column])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatCell(value) {
  if (value === null || value === undefined || value === "") return <span className="muted">-</span>;
  if (typeof value === "boolean") return value ? "Si" : "No";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function Metric({ label, value, tone = "default" }) {
  return (
    <div className={`metric metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function LoadingBlock({ label = "Cargando datos" }) {
  return (
    <div className="loading-block">
      <Loader2 className="spin" />
      <span>{label}</span>
    </div>
  );
}

export function FormActions({ onDelete, deleting, saving, saveLabel = "Guardar cambios", deleteLabel = "Eliminar" }) {
  return (
    <div className="form-actions">
      {onDelete ? (
        <Button type="button" variant="danger" icon={Trash2} loading={deleting} onClick={onDelete}>
          {deleteLabel}
        </Button>
      ) : null}
      <Button type="submit" icon={Save} loading={saving}>
        {saveLabel}
      </Button>
    </div>
  );
}
