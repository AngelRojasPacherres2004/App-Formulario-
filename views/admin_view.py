from datetime import date, datetime
from io import BytesIO
from typing import Any
from zoneinfo import ZoneInfo

import pandas as pd
import streamlit as st
from supabase import Client

from services.repositories import (
    create_task,
    create_tienda,
    create_user,
    delete_task_score_ranges,
    delete_tienda,
    delete_user,
    get_attendance_for_date,
    list_all_activity_logs,
    list_attendances,
    list_task_score_ranges,
    list_tasks,
    list_tiendas,
    list_workers,
    mark_attendance,
    select_users,
    set_task_score_ranges,
    update_task,
    update_tienda,
    update_user,
)
from services.scoring import get_activity_capture_mode


def render_admin(supabase: Client) -> None:
    menu = st.session_state.get("admin_menu", "Usuarios")
    if menu == "Usuarios":
        _users_crud(supabase)
    elif menu == "Tareas":
        _tasks_panel(supabase)
    elif menu == "Asistencia":
        _attendance_panel(supabase)
    elif menu == "Tiendas":
        _stores_panel(supabase)
    else:
        _worker_points_panel(supabase)


def _users_crud(supabase: Client) -> None:
    birthday_min = date(1900, 1, 1)
    birthday_max = date.today().replace(month=12, day=31, year=date.today().year - 1)
    st.subheader("Gestion de usuarios")
    users = select_users(supabase)
    if users:
        display_users = []
        for user in users:
            row = dict(user)
            row["rol"] = _normalize_role_label(row.get("rol"))
            display_users.append(row)
        st.dataframe(pd.DataFrame(display_users), width="stretch")
    else:
        st.info("No hay usuarios registrados.")

    tab1, tab2, tab3 = st.tabs(["Crear", "Editar", "Eliminar"])

    with tab1:
        with st.form("create_user"):
            nombre = st.text_input("Nombre")
            email = st.text_input("Correo")
            password = st.text_input("Contrasena", type="password")
            fecha_cumpleanos = st.date_input(
                "Fecha de nacimiento",
                value=None,
                min_value=birthday_min,
                max_value=birthday_max,
            )
            sueldo = st.number_input("Sueldo", min_value=0.0, value=0.0, step=0.01, format="%.2f")
            rol = st.selectbox("Rol", ["administrador", "operante", "jefe de equipo"])
            activo = st.checkbox("Activo", value=True)
            ok = st.form_submit_button("Crear usuario")

        if ok:
            payload = {
                "nombre": nombre.strip(),
                "email": email.strip().lower(),
                "rol": rol,
                "activo": activo,
                "fecha_cumpleanos": fecha_cumpleanos.isoformat() if fecha_cumpleanos else None,
                "sueldo": round(float(sueldo), 2),
            }
            create_user(supabase, payload, password)
            st.success("Usuario creado.")
            st.rerun()

    with tab2:
        if not users:
            st.info("No hay usuarios para editar.")
        else:
            user_map = {f"{u.get('id')} - {u.get('email')}": u for u in users}
            sel = st.selectbox("Usuario", list(user_map.keys()), key="edit_user_sel")
            selected = user_map[sel]

            with st.form("edit_user"):
                new_nombre = st.text_input("Nombre", value=str(selected.get("nombre", "")))
                new_email = st.text_input("Correo", value=str(selected.get("email", "")))
                selected_birthday = selected.get("fecha_cumpleanos")
                birthday_value = None
                if selected_birthday:
                    try:
                        birthday_value = datetime.fromisoformat(str(selected_birthday)).date()
                    except Exception:
                        birthday_value = None
                new_birthday = st.date_input(
                    "Fecha de nacimiento",
                    value=birthday_value,
                    min_value=birthday_min,
                    max_value=birthday_max,
                )
                new_sueldo = st.number_input(
                    "Sueldo",
                    min_value=0.0,
                    value=float(selected.get("sueldo") or 0),
                    step=0.01,
                    format="%.2f",
                )
                role_options = ["administrador", "operante", "jefe de equipo"]
                current_role = _normalize_role(selected.get("rol"))
                role_index = role_options.index(current_role) if current_role in role_options else 0
                new_rol = st.selectbox(
                    "Rol",
                    role_options,
                    index=role_index,
                )
                new_activo = st.checkbox("Activo", value=bool(selected.get("activo", True)))
                new_password = st.text_input("Nueva contrasena (opcional)", type="password")
                save = st.form_submit_button("Guardar cambios")

            if save:
                changes = {
                    "nombre": new_nombre.strip(),
                    "email": new_email.strip().lower(),
                    "rol": new_rol,
                    "activo": new_activo,
                    "fecha_cumpleanos": new_birthday.isoformat() if new_birthday else None,
                    "sueldo": round(float(new_sueldo), 2),
                }
                update_user(supabase, selected["id"], changes, new_password.strip() or None)
                st.success("Usuario actualizado.")
                st.rerun()

    with tab3:
        if not users:
            st.info("No hay usuarios para eliminar.")
        else:
            user_map = {f"{u.get('id')} - {u.get('email')}": u for u in users}
            sel = st.selectbox("Usuario a eliminar", list(user_map.keys()), key="del_user_sel")
            target = user_map[sel]
            if st.button("Eliminar usuario", type="primary"):
                delete_user(supabase, target["id"])
                st.success("Usuario eliminado.")
                st.rerun()


def _quantity_threshold_defaults(existing_ranges: list[dict[str, Any]] | None = None) -> list[float]:
    thresholds = [0.0] * 10
    existing_ranges = existing_ranges or []
    for rango in existing_ranges:
        try:
            punto = int(rango.get("puntos") or 0)
        except Exception:
            punto = 0
        if not 1 <= punto <= 10:
            continue
        try:
            thresholds[punto - 1] = float(rango.get("cantidad_desde") or 0.0)
        except Exception:
            thresholds[punto - 1] = 0.0
    for idx in range(1, 10):
        if thresholds[idx] < thresholds[idx - 1]:
            thresholds[idx] = thresholds[idx - 1]
    return thresholds


def _normalize_role(role: Any) -> str:
    value = str(role or "").strip().lower()
    if value == "trabajador":
        return "operante"
    return value


def _normalize_role_label(role: Any) -> str:
    value = _normalize_role(role)
    if value == "operante":
        return "operante"
    if value == "administrador":
        return "administrador"
    if value == "jefe de equipo":
        return "jefe de equipo"
    return str(role or "")


def _thresholds_to_ranges(thresholds: list[float]) -> list[dict[str, Any]]:
    return [{"cantidad_desde": float(threshold), "cantidad_hasta": None, "puntos": idx} for idx, threshold in enumerate(thresholds, start=1)]


def _render_quantity_matrix(prefix: str, existing_ranges: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    st.markdown("#### Matriz de puntajes por cantidad")
    thresholds = _quantity_threshold_defaults(existing_ranges)
    header_cols = st.columns([3] + [1] * 10)
    with header_cols[0]:
        st.markdown("**Actividad**")
    for idx in range(10):
        with header_cols[idx + 1]:
            st.markdown(f"**{idx + 1} punto**")
    row_cols = st.columns([3] + [1] * 10)
    with row_cols[0]:
        st.markdown("Cantidad")
    for idx in range(10):
        with row_cols[idx + 1]:
            thresholds[idx] = st.number_input(
                " ",
                min_value=0.0,
                step=1.0,
                value=float(thresholds[idx]),
                key=f"{prefix}_cantidad_{idx + 1}",
                label_visibility="collapsed",
            )
    for idx in range(1, 10):
        if thresholds[idx] < thresholds[idx - 1]:
            st.error("Los valores de cantidad deben ir de menor a mayor de 1 a 10 puntos.")
            break
    return _thresholds_to_ranges(thresholds)


def _render_fixed_matrix(prefix: str, default_score: int) -> int:
    st.markdown("#### Matriz de puntaje fijo")
    selected = st.selectbox(
        "Puntaje fijo",
        list(range(1, 11)),
        index=max(0, min(9, default_score - 1)),
        key=f"{prefix}_puntaje_fijo_select",
    )
    return int(selected)


def _render_turno_matrix(prefix: str, default_simple: int, default_complete: int) -> tuple[int, int]:
    st.markdown("#### Matriz de puntaje por turno")
    c1, c2 = st.columns(2)
    with c1:
        simple = st.selectbox(
            "Puntaje turno simple",
            list(range(1, 11)),
            index=max(0, min(9, default_simple - 1)),
            key=f"{prefix}_puntaje_turno_simple_select",
        )
    with c2:
        completo = st.selectbox(
            "Puntaje turno completo",
            list(range(1, 11)),
            index=max(0, min(9, default_complete - 1)),
            key=f"{prefix}_puntaje_turno_completo_select",
        )
    return int(simple), int(completo)


def _render_score_summary(tasks: list[dict[str, Any]], supabase: Client) -> None:
    rows: list[dict[str, Any]] = []
    for task in tasks:
        tipo = _normalize_tipo_medicion(task.get("tipo_medicion"))
        row: dict[str, Any] = {"Actividad": _task_title(task), "Tipo de Puntaje": tipo}
        for idx in range(1, 11):
            row[f"{idx} punto"] = ""
        if tipo == "cantidad":
            ranges = list_task_score_ranges(supabase, task.get("id"))
            thresholds = _quantity_threshold_defaults(ranges)
            for idx, threshold in enumerate(thresholds, start=1):
                row[f"{idx} punto"] = threshold
        elif tipo == "fijo":
            score = int(task.get("puntaje_fijo") or task.get("puntaje") or 0)
            if 1 <= score <= 10:
                row[f"{score} punto"] = "SI"
        elif tipo == "turno":
            simple = int(task.get("puntaje_turno_simple") or task.get("puntos_turno_simple") or 0)
            completo = int(task.get("puntaje_turno_completo") or task.get("puntos_turno_completo") or 0)
            if 1 <= simple <= 10:
                row[f"{simple} punto"] = "S"
            if 1 <= completo <= 10:
                row[f"{completo} punto"] = "C"
        rows.append(row)
    st.markdown("### Configuracion de puntajes")
    if rows:
        st.dataframe(pd.DataFrame(rows), width="stretch")
    else:
        st.info("No hay tareas configuradas todavia.")


def _normalize_tipo_medicion(value: Any) -> str:
    raw = str(value or "").strip().lower()
    if raw in {"fijo", "cumplimiento"}:
        return "fijo"
    if raw in {"cantidad", "tiempo", "turno"}:
        return raw
    return "cantidad"


def _task_title(task: dict[str, Any]) -> str:
    return str(task.get("titulo") or task.get("nombre") or "")


def _prefill_task_points(task: dict[str, Any]) -> dict[str, int]:
    return {
        "puntaje_fijo": int(task.get("puntaje_fijo") or task.get("puntaje") or 1),
        "puntaje_turno_simple": int(task.get("puntaje_turno_simple") or task.get("puntos_turno_simple") or 1),
        "puntaje_turno_completo": int(task.get("puntaje_turno_completo") or task.get("puntos_turno_completo") or 1),
    }


def _render_measurement_fields(
    tipo_medicion: str,
    prefix: str,
    task: dict[str, Any] | None = None,
    existing_ranges: list[dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], int | None, int | None, int | None]:
    ranges: list[dict[str, Any]] = []
    puntaje_fijo: int | None = None
    puntaje_turno_simple: int | None = None
    puntaje_turno_completo: int | None = None
    defaults = _prefill_task_points(task or {}) if task else {"puntaje_fijo": 1, "puntaje_turno_simple": 1, "puntaje_turno_completo": 1}
    if tipo_medicion == "cantidad":
        ranges = _render_quantity_matrix(prefix, existing_ranges)
    elif tipo_medicion == "fijo":
        puntaje_fijo = _render_fixed_matrix(prefix, int(defaults["puntaje_fijo"]))
    elif tipo_medicion == "turno":
        puntaje_turno_simple, puntaje_turno_completo = _render_turno_matrix(
            prefix,
            int(defaults["puntaje_turno_simple"]),
            int(defaults["puntaje_turno_completo"]),
        )
    return ranges, puntaje_fijo, puntaje_turno_simple, puntaje_turno_completo


def _build_task_payload(
    titulo: str,
    descripcion: str,
    estado: str,
    tipo_medicion: str,
    unidad_base: str,
    puntaje_fijo: int | None = None,
    puntaje_turno_simple: int | None = None,
    puntaje_turno_completo: int | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "titulo": titulo.strip(),
        "descripcion": descripcion.strip(),
        "estado": estado.strip(),
        "tipo_medicion": tipo_medicion,
        "unidad_base": unidad_base.strip() if unidad_base.strip() else None,
        "puntaje_fijo": None,
        "puntaje_turno_simple": None,
        "puntaje_turno_completo": None,
    }
    if tipo_medicion in {"cumplimiento", "fijo"}:
        payload["tipo_medicion"] = "fijo"
        payload["puntaje_fijo"] = puntaje_fijo
    elif tipo_medicion == "turno":
        payload["puntaje_turno_simple"] = puntaje_turno_simple
        payload["puntaje_turno_completo"] = puntaje_turno_completo
    return payload


def _tasks_panel(supabase: Client) -> None:
    st.subheader("Gestion de tareas")
    tasks = list_tasks(supabase)
    _render_score_summary(tasks, supabase)
    tab1, tab2 = st.tabs(["Crear tarea", "Editar tarea"])
    with tab1:
        with st.form("create_task"):
            titulo = st.text_input("Nombre de tarea")
            descripcion = st.text_area("Descripcion")
            estado = st.text_input("Estado", value="pendiente")
            asignado_a = st.text_input("Asignado a (id usuario)")
            tipo_medicion = st.selectbox("Tipo de medicion", ["cantidad", "fijo", "turno", "tiempo"], index=0)
            unidad_base = st.text_input("Unidad base (ej. pares, cajas, bultos)", placeholder="Opcional")
            rangos, puntaje_fijo, puntaje_turno_simple, puntaje_turno_completo = _render_measurement_fields(tipo_medicion, "create")
            crear = st.form_submit_button("Crear tarea")
        if crear:
            if tipo_medicion == "cantidad":
                invalid_range = any(float(rangos[idx]["cantidad_desde"]) < float(rangos[idx - 1]["cantidad_desde"]) for idx in range(1, len(rangos)))
                if invalid_range:
                    st.error("Los valores de cantidad deben ir de menor a mayor de 1 a 10 puntos.")
                else:
                    payload = _build_task_payload(titulo, descripcion, estado, tipo_medicion, unidad_base)
                    if asignado_a.strip().isdigit():
                        payload["asignado_a"] = int(asignado_a.strip())
                    created = create_task(supabase, payload)
                    if created and created.get("id"):
                        set_task_score_ranges(supabase, created["id"], rangos)
                    st.success("Tarea creada.")
                    st.rerun()
            else:
                payload = _build_task_payload(
                    titulo,
                    descripcion,
                    estado,
                    tipo_medicion,
                    unidad_base,
                    puntaje_fijo=puntaje_fijo,
                    puntaje_turno_simple=puntaje_turno_simple,
                    puntaje_turno_completo=puntaje_turno_completo,
                )
                if asignado_a.strip().isdigit():
                    payload["asignado_a"] = int(asignado_a.strip())
                create_task(supabase, payload)
                st.success("Tarea creada.")
                st.rerun()
    with tab2:
        if not tasks:
            st.info("No hay tareas para editar.")
            return
        task_entries: list[tuple[str, dict]] = []
        for t in tasks:
            title = t.get("nombre") or t.get("titulo") or ""
            key = f"{t.get('id')} - {title}"
            task_entries.append((key, t))
        task_entries.sort(key=lambda x: int(str(x[0]).split(" - ")[0]))
        task_map = {k: v for k, v in task_entries}
        selected_key = st.selectbox("Selecciona una tarea", list(task_map.keys()), key="edit_task_select")
        if st.button("Cargar tarea para editar", type="primary"):
            st.session_state["edit_task_loaded_key"] = selected_key
            st.rerun()
        loaded_key = st.session_state.get("edit_task_loaded_key")
        if loaded_key not in task_map:
            st.info("Selecciona una tarea y pulsa 'Cargar tarea para editar' para ver y modificar sus datos.")
            return
        selected_task = task_map[loaded_key]
        task_id = selected_task.get("id")
        tipo_actual = _normalize_tipo_medicion(selected_task.get("tipo_medicion"))
        edit_prefix = f"edit_{task_id}_{tipo_actual}"
        existing_ranges = list_task_score_ranges(supabase, task_id) if tipo_actual == "cantidad" else []
        tipo_medicion_value = st.selectbox("Tipo de medicion", ["cantidad", "fijo", "turno", "tiempo"], index=["cantidad", "fijo", "turno", "tiempo"].index(tipo_actual), key=f"{edit_prefix}_tipo")
        with st.form(f"edit_task_{task_id}"):
            titulo = st.text_input("Nombre de tarea", value=_task_title(selected_task), key=f"{edit_prefix}_titulo")
            descripcion = st.text_area("Descripcion", value=str(selected_task.get("descripcion") or ""), key=f"{edit_prefix}_descripcion")
            estado = st.text_input("Estado", value=str(selected_task.get("estado", "pendiente")), key=f"{edit_prefix}_estado")
            tipo_medicion = tipo_medicion_value
            unidad_base = st.text_input("Unidad base (ej. pares, cajas, bultos)", value=str(selected_task.get("unidad_base") or selected_task.get("unidad") or ""), placeholder="Opcional", key=f"{edit_prefix}_unidad_base")
            rangos, puntaje_fijo, puntaje_turno_simple, puntaje_turno_completo = _render_measurement_fields(
                tipo_medicion,
                edit_prefix,
                selected_task,
                existing_ranges if tipo_medicion == "cantidad" else None,
            )
            guardar = st.form_submit_button("Guardar cambios")
        if guardar:
            if tipo_medicion == "cantidad":
                invalid_range = any(float(rangos[idx]["cantidad_desde"]) < float(rangos[idx - 1]["cantidad_desde"]) for idx in range(1, len(rangos)))
                if invalid_range:
                    st.error("Los valores de cantidad deben ir de menor a mayor de 1 a 10 puntos.")
                else:
                    changes = _build_task_payload(titulo, descripcion, estado, tipo_medicion, unidad_base)
                    update_task(supabase, task_id, changes, selected_task)
                    set_task_score_ranges(supabase, task_id, rangos)
                    st.success("Tarea actualizada.")
                    st.rerun()
            else:
                changes = _build_task_payload(
                    titulo,
                    descripcion,
                    estado,
                    tipo_medicion,
                    unidad_base,
                    puntaje_fijo=puntaje_fijo,
                    puntaje_turno_simple=puntaje_turno_simple,
                    puntaje_turno_completo=puntaje_turno_completo,
                )
                update_task(supabase, task_id, changes, selected_task)
                delete_task_score_ranges(supabase, task_id)
                st.success("Tarea actualizada.")
                st.rerun()


def _attendance_panel(supabase: Client) -> None:
    st.subheader("Gestion de asistencia")
    st.caption("Marca asistencia diaria por trabajador y exporta el historial a Excel.")
    workers = list_workers(supabase)
    if not workers:
        st.info("No hay trabajadores registrados.")
        return

    lima_today = datetime.now(ZoneInfo("America/Lima")).date().isoformat()
    selected_date = st.date_input("Fecha", value=datetime.fromisoformat(lima_today).date())
    selected_date_str = selected_date.isoformat()
    current_marks = {
        r.get("usuario_id"): str(r.get("estado", "Presente")).strip().lower() == "presente"
        for r in get_attendance_for_date(supabase, selected_date_str)
    }

    with st.form(f"attendance_form_{selected_date_str}"):
        cols = st.columns([3, 2, 2])
        with cols[0]:
            st.markdown("**Trabajador**")
        with cols[1]:
            st.markdown("**Email**")
        with cols[2]:
            st.markdown("**Asistencia**")

        attendance_values: dict[Any, bool] = {}
        for worker in workers:
            row_cols = st.columns([3, 2, 2])
            worker_id = worker.get("id")
            with row_cols[0]:
                st.write(str(worker.get("nombre") or ""))
            with row_cols[1]:
                st.write(str(worker.get("email") or ""))
            with row_cols[2]:
                presente_default = current_marks.get(worker_id, False)
                attendance_values[worker_id] = st.checkbox(
                    "Presente",
                    value=presente_default,
                    key=f"att_{selected_date_str}_{worker_id}",
                    label_visibility="collapsed",
                )

        guardar_asistencia = st.form_submit_button("Guardar asistencia", type="primary")

    if guardar_asistencia:
        for worker_id, presente in attendance_values.items():
            if current_marks.get(worker_id, False) != presente:
                mark_attendance(supabase, worker_id, selected_date_str, presente)
        st.success("Asistencia guardada.")
        st.rerun()

    st.divider()
    attendances = list_attendances(supabase)
    attendance_rows = []
    worker_name_by_id = {w.get("id"): w.get("nombre") or w.get("email") for w in workers}
    worker_email_by_id = {w.get("id"): w.get("email") for w in workers}
    for item in attendances:
        created_at_str = item.get("created_at")
        created_at_display = created_at_str
        if created_at_str:
            try:
                dt = datetime.fromisoformat(str(created_at_str).replace("Z", "+00:00"))
                dt_lima = dt.astimezone(ZoneInfo("America/Lima"))
                created_at_display = dt_lima.strftime("%d/%m/%Y %H:%M")
            except Exception:
                created_at_display = created_at_str
        if str(item.get("estado", "Presente")).strip().lower() == "ausente":
            created_at_display = ""
        attendance_rows.append(
            {
                "Fecha": item.get("fecha"),
                "Trabajador": worker_name_by_id.get(item.get("usuario_id")),
                "Email": worker_email_by_id.get(item.get("usuario_id")),
                "Estado": item.get("estado", "Presente"),
                "Marcado en": created_at_display,
            }
        )
    attendance_df = pd.DataFrame(attendance_rows)
    st.markdown("### Historial de asistencia")
    st.dataframe(attendance_df, width="stretch")

    if not attendance_df.empty:
        buffer = BytesIO()
        with pd.ExcelWriter(buffer, engine="openpyxl") as writer:
            attendance_df.to_excel(writer, index=False, sheet_name="Asistencia")
        st.download_button(
            "Exportar asistencia a Excel",
            data=buffer.getvalue(),
            file_name=f"asistencia_{selected_date_str}.xlsx",
            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )


def _stores_panel(supabase: Client) -> None:
    st.subheader("Gestion de tiendas")
    stores = list_tiendas(supabase)
    if stores:
        st.dataframe(pd.DataFrame(stores), width="stretch")
    else:
        st.info("No hay tiendas registradas.")

    tab1, tab2, tab3 = st.tabs(["Crear", "Editar", "Eliminar"])

    with tab1:
        with st.form("create_store"):
            nombre = st.text_input("Nombre de tienda")
            activo = st.checkbox("Activo", value=True, key="store_create_active")
            ok = st.form_submit_button("Crear tienda")

        if ok:
            if not nombre.strip():
                st.error("El nombre de la tienda es obligatorio.")
            else:
                try:
                    create_tienda(supabase, {"nombre": nombre.strip(), "activo": activo})
                    st.success("Tienda creada.")
                    st.rerun()
                except RuntimeError as exc:
                    st.error(str(exc))

    with tab2:
        if not stores:
            st.info("No hay tiendas para editar.")
        else:
            store_map = {f"{t.get('id')} - {t.get('nombre')}": t for t in stores}
            sel = st.selectbox("Tienda", list(store_map.keys()), key="edit_store_sel")
            selected = store_map[sel]
            with st.form("edit_store"):
                nombre = st.text_input("Nombre de tienda", value=str(selected.get("nombre", "")))
                activo = st.checkbox("Activo", value=bool(selected.get("activo", True)), key="store_edit_active")
                save = st.form_submit_button("Guardar cambios")

            if save:
                if not nombre.strip():
                    st.error("El nombre de la tienda es obligatorio.")
                else:
                    try:
                        update_tienda(supabase, selected["id"], {"nombre": nombre.strip(), "activo": activo})
                        st.success("Tienda actualizada.")
                        st.rerun()
                    except RuntimeError as exc:
                        st.error(str(exc))

    with tab3:
        if not stores:
            st.info("No hay tiendas para eliminar.")
        else:
            store_map = {f"{t.get('id')} - {t.get('nombre')}": t for t in stores}
            sel = st.selectbox("Tienda a eliminar", list(store_map.keys()), key="del_store_sel")
            target = store_map[sel]
            if st.button("Eliminar tienda", type="primary"):
                try:
                    delete_tienda(supabase, target["id"])
                    st.success("Tienda eliminada.")
                    st.rerun()
                except RuntimeError as exc:
                    st.error(str(exc))


def _worker_points_panel(supabase: Client) -> None:
    st.subheader("Tareas realizadas y puntos por trabajador")
    logs = list_all_activity_logs(supabase)
    if not logs:
        st.info("No hay registros todavía.")
        return
    users = select_users(supabase)
    workers = [u for u in users if _normalize_role(u.get("rol")) in {"operante", "jefe de equipo"}]
    worker_ids = {u.get("id") for u in workers}
    user_name_by_id = {u.get("id"): (u.get("nombre") or u.get("email")) for u in workers}
    user_email_by_id = {u.get("id"): u.get("email") for u in workers}
    tasks = list_tasks(supabase)
    task_name_by_id = {t.get("id"): (t.get("nombre") or t.get("titulo") or f"Tarea {t.get('id')}") for t in tasks}
    rows = []
    for r in logs:
        trabajador_id = r.get("trabajador_id")
        if trabajador_id not in worker_ids:
            continue
        tarea_nombre = task_name_by_id.get(r.get("tarea_id"))
        actividad_nombre = tarea_nombre
        created_at_str = r.get("created_at")
        fecha_display = str(r.get("fecha_registro") or "")
        if created_at_str:
            try:
                dt = datetime.fromisoformat(created_at_str.replace("Z", "+00:00"))
                dt_lima = dt.astimezone(ZoneInfo("America/Lima"))
                fecha_display = dt_lima.strftime("%d/%m/%Y %H:%M")
            except Exception:
                pass
        val_cant = r.get("cantidad")
        val_turno = r.get("turno")
        cant_display = val_turno if val_turno else val_cant
        tipo_act, _ = get_activity_capture_mode(actividad_nombre or "")
        if tipo_act == "turno" and not val_turno:
            cant_display = "Turno mañana o tarde" if val_cant == 1.0 else "Turno mañana y tarde"
        rows.append(
            {
                "Fecha": fecha_display,
                "Trabajador": user_name_by_id.get(trabajador_id),
                "Email": user_email_by_id.get(trabajador_id),
                "Tarea": tarea_nombre,
                "Actividad": actividad_nombre,
                "Cantidad": str(val_cant) if val_cant is not None else "",
                "Turno": val_turno if val_turno else (cant_display if tipo_act == "turno" else ""),
                "Tiempo (min)": r.get("tiempo_minutos"),
                "Cumplimiento": r.get("cumplimiento"),
                "Puntos": float(r.get("puntos_obtenidos") or 0),
            }
        )
    df = pd.DataFrame(rows)
    st.markdown("### Acumulado por trabajador")
    resumen = df.groupby(["Trabajador", "Email"], dropna=False, as_index=False)["Puntos"].sum().sort_values("Puntos", ascending=False)
    st.dataframe(resumen, width="stretch")
    st.metric("Puntos totales registrados", f"{resumen['Puntos'].sum():.0f}")
    st.divider()
    with st.container(border=True):
        st.markdown("### Detalle Individual por Trabajador")
        for worker in workers:
            w_id = worker.get("id")
            w_email = user_email_by_id.get(w_id)
            w_name = user_name_by_id.get(w_id)
            worker_df = df[df["Email"] == w_email]
            if not worker_df.empty:
                with st.expander(f"{w_name} ({w_email}) - Total: {worker_df['Puntos'].sum():.1f} pts"):
                    st.write(f"**Actividades realizadas por {w_name}:**")
                    st.dataframe(worker_df.drop(columns=["Trabajador", "Email"]), use_container_width=True)
            else:
                st.caption(f"{w_name} ({w_email}) no tiene registros todavia.")
