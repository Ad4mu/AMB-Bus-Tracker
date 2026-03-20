# AMB Bus Tracker (Full-Stack)

Aplicacion web Full-Stack para consultar tiempos de llegada de autobuses AMB en tiempo real.

Stack del proyecto:
- Backend: Python + Flask + Flask-CORS + Requests + GTFS Realtime bindings
- Frontend: HTML + CSS + JavaScript Vanilla
- Mapa: Leaflet.js + OpenStreetMap

## Caracteristicas

- Endpoint REST para consultar proximas llegadas por `stop_id`.
- Logica GTFS Realtime adaptada para devolver JSON estructurado.
- CORS habilitado en `/api/*`.
- Frontend con:
- Busqueda manual por ID de parada.
- Panel de resultados con linea, minutos, estado y hora prevista.
- Boton de actualizacion manual.
- Auto-refresh cada 30 segundos.
- Mapa centrado en Barcelona y pin de parada (si hay `stops.txt`).

## Estructura

- `app.py`: API y servidor web Flask.
- `index.html`: UI principal.
- `style.css`: estilos.
- `script.js`: logica cliente (fetch, mapa, refresco).
- `requirements.txt`: dependencias Python.

## Requisitos

- Python 3.10+ recomendado
- `pip`

## Instalacion local

1. Crear entorno virtual (opcional pero recomendado):

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
```

2. Instalar dependencias:

```powershell
pip install -r requirements.txt
```

## Ejecucion local

```powershell
python app.py
```

Servidor por defecto:
- `http://localhost:5000/`

## Variables de entorno

- `AMB_GTFS_RT_URL` (opcional)
- Por defecto usa:
- `https://www.ambmobilitat.cat/transit/trips-updates/trips.bin`
- Si la defines, sobreescribe el valor por defecto.

- `PORT` (opcional)
- Puerto del servidor Flask (Render lo inyecta automaticamente).

- `REQUEST_TIMEOUT_SECONDS` (opcional, default `15`)
- Timeout de `requests.get`.

- `GTFS_STOPS_FILE` (opcional, default `stops.txt`)
- Ruta al GTFS estatico para coordenadas y nombre de parada.

- `FORCE_GTFS_REFRESH` (opcional, default `false`)
- Si vale `true`, fuerza la descarga de `google_transit.zip` y reemplaza `stops.txt` en cada arranque.

## Endpoints API

- `GET /api/health`
- Healthcheck basico.

- `GET /api/buses/<id_parada>`
- Devuelve proximas llegadas para una parada.

Ejemplo:
`GET /api/buses/101552`

Respuesta ejemplo:

```json
{
  "stop_id": "101552",
  "generated_at": "2026-03-20T10:22:33.123456+00:00",
  "count": 2,
  "buses": [
    {
      "linea": "L52",
      "minutos": 4,
      "estado": "Faltan 4 min",
      "hora_prevista": "11:23:10",
      "arrival_unix": 1773998590
    }
  ]
}
```

- `GET /api/stops/<id_parada>`
- Devuelve `stop_name`, `stop_lat`, `stop_lon` si existe `stops.txt`.
- Si no existe la parada en el fichero, devuelve `404`.

## `stops.txt` (opcional pero recomendado)

El feed GTFS-Realtime usado aqui no incluye coordenadas GPS de paradas.
Para pintar pines en el mapa por `stop_id`, coloca un `stops.txt` GTFS estatico en la raiz del proyecto (o configura `GTFS_STOPS_FILE`).

Campos usados:
- `stop_id`
- `stop_name`
- `stop_lat`
- `stop_lon`

## Actualizacion automatica de `stops.txt` en arranque

En el inicio del worker (incluyendo Gunicorn en Render), la app intenta asegurar `stops.txt` con esta logica:
- Si `stops.txt` existe y tiene menos de 24 horas: reutiliza cache local.
- Si tiene mas de 24 horas: descarga `https://www.ambmobilitat.cat/OpenData/google_transit.zip` y extrae solo `stops.txt`.
- Si `FORCE_GTFS_REFRESH=true`: fuerza descarga sin mirar antiguedad.
- Si falla la descarga/extraccion:
- Si habia `stops.txt` previo: mantiene el archivo antiguo.
- Si no habia archivo: arranca igualmente, pero sin pines en mapa.

## Despliegue en Render

1. Subir proyecto a GitHub.
2. Crear un `Web Service` en Render.
3. Configuracion recomendada:
- Build Command:
`pip install -r requirements.txt`
- Start Command:
`gunicorn app:app`
4. (Opcional) Definir variables de entorno:
- `AMB_GTFS_RT_URL`
- `REQUEST_TIMEOUT_SECONDS`
- `GTFS_STOPS_FILE`

## Notas tecnicas

- Se elimino la dependencia de certificado hardcodeado (`ZSCALER_CERT`).
- La peticion GTFS usa `requests.get(...)` estandar para entorno de produccion.
- La app sirve tanto API como frontend desde el mismo servicio Flask.

## Mejoras futuras sugeridas

- Cache temporal del feed GTFS para reducir latencia y llamadas.
- Busqueda por nombre de parada (no solo por ID).
- Clustering de paradas en el mapa.
- Soporte de varias agencias o varios feeds.
