# Formulario-web

## Despliegue en Netlify

El proyecto incluye `netlify.toml` y una funcion backend para que `/api/*` funcione fuera de la computadora local.

Configura en **Netlify > Site configuration > Environment variables**:

- `VITE_SUPABASE_URL`: URL del proyecto Supabase.
- `VITE_SUPABASE_PUBLISHABLE_KEY`: clave publica usada por React.
- `SUPABASE_URL`: la misma URL del proyecto Supabase.
- `SUPABASE_SECRET_KEY`: clave secreta disponible solamente para Functions.
- `API_SESSION_SECRET`: cadena privada larga y aleatoria para firmar sesiones.
- `GMAIL_USER`: cuenta remitente del reporte (`calzado661@gmail.com`).
- `GMAIL_APP_PASSWORD`: contrasena de aplicacion de 16 caracteres creada en Google.

Las variables secretas deben configurarse en la interfaz, CLI o API de Netlify; no deben escribirse en `netlify.toml` ni subirse a Git.

El despliegue debe incluir el repositorio completo. Subir solamente la carpeta `dist` no despliega `netlify/functions`.

## Reporte automatico de asistencia

1. Ejecuta, en orden, `sql/017_reporte_asistencia_automatico.sql` y `sql/018_multiples_programaciones_reporte_asistencia.sql` en el editor SQL de Supabase.
2. Activa la verificacion en dos pasos de `calzado661@gmail.com` y crea una contrasena de aplicacion para el sistema.
3. Guarda `GMAIL_USER` y `GMAIL_APP_PASSWORD` como variables privadas con alcance **Functions** en Netlify.
4. Publica el sitio. La funcion programada revisa cada minuto la hora configurada en el apartado **Notificaciones** (zona horaria `America/Lima`).

Cada programacion puede tener su propio nombre, horario, destinatarios y seleccion de trabajadores activos. Las programaciones eliminadas se archivan para conservar su historial de envios. La contrasena de Gmail nunca se guarda en Supabase ni se envia al navegador.
