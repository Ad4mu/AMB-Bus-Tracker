import csv
import datetime
import io
import logging
import math
import os
import time
import zipfile
from pathlib import Path
from typing import Dict, List, Optional

import requests
from flask import Flask, jsonify, send_from_directory
from flask_cors import CORS
from google.transit import gtfs_realtime_pb2


app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


DEFAULT_AMB_GTFS_RT_URL = "https://www.ambmobilitat.cat/transit/trips-updates/trips.bin"
DEFAULT_AMB_GTFS_STATIC_ZIP_URL = (
    "https://www.ambmobilitat.cat/OpenData/google_transit.zip"
)
STOPS_CACHE_MAX_AGE_SECONDS = 24 * 60 * 60
AMB_GTFS_RT_URL = os.getenv("AMB_GTFS_RT_URL", DEFAULT_AMB_GTFS_RT_URL).strip()
REQUEST_TIMEOUT_SECONDS = int(os.getenv("REQUEST_TIMEOUT_SECONDS", "15"))
AMB_GTFS_STATIC_ZIP_URL = os.getenv(
    "AMB_GTFS_STATIC_ZIP_URL", DEFAULT_AMB_GTFS_STATIC_ZIP_URL
).strip()
GTFS_STOPS_FILE = Path(os.getenv("GTFS_STOPS_FILE", str(Path(__file__).resolve().parent / "stops.txt")))


MAPA_LINEAS = {
    "181": "L52",
    "204": "L82",
    "417": "M12",
}


_stops_cache: Optional[Dict[str, Dict[str, object]]] = None
_stops_cache_mtime: Optional[float] = None
BASE_DIR = Path(__file__).resolve().parent


def _env_is_true(var_name: str) -> bool:
    return os.getenv(var_name, "").strip().lower() == "true"


def ensure_stops_file() -> None:
    global _stops_cache, _stops_cache_mtime
    force_refresh = _env_is_true("FORCE_GTFS_REFRESH")
    stops_exists = GTFS_STOPS_FILE.exists()

    if stops_exists and not force_refresh:
        age_seconds = time.time() - GTFS_STOPS_FILE.stat().st_mtime
        if age_seconds < STOPS_CACHE_MAX_AGE_SECONDS:
            logger.info(
                "Usando stops.txt local (edad %.1f horas, cache max 24h).",
                age_seconds / 3600,
            )
            return

    try:
        if force_refresh:
            logger.info("FORCE_GTFS_REFRESH=true, forzando actualizacion de stops.txt.")
        elif stops_exists:
            logger.info("stops.txt tiene mas de 24h, actualizando desde GTFS estatico.")
        else:
            logger.info("stops.txt no existe, descargando GTFS estatico.")

        response = requests.get(
            AMB_GTFS_STATIC_ZIP_URL, timeout=REQUEST_TIMEOUT_SECONDS
        )
        response.raise_for_status()

        zip_buffer = io.BytesIO(response.content)
        with zipfile.ZipFile(zip_buffer) as zf:
            stops_member = next(
                (name for name in zf.namelist() if name.lower().endswith("stops.txt")),
                None,
            )
            if not stops_member:
                raise FileNotFoundError("El ZIP no contiene stops.txt")

            stops_data = zf.read(stops_member)

        GTFS_STOPS_FILE.parent.mkdir(parents=True, exist_ok=True)
        with GTFS_STOPS_FILE.open("wb") as fp:
            fp.write(stops_data)

        _stops_cache = None
        _stops_cache_mtime = None

        logger.info(
            "stops.txt actualizado correctamente en %s.", GTFS_STOPS_FILE.resolve()
        )
    except Exception as exc:
        if stops_exists and GTFS_STOPS_FILE.exists():
            logger.error(
                "Error actualizando stops.txt. Se mantiene el archivo local antiguo. Error: %s",
                exc,
            )
            return

        logger.warning(
            "No se pudo descargar/extraer stops.txt (%s). La app arrancara sin pines en el mapa.",
            exc,
        )


def _parse_stops_file() -> Dict[str, Dict[str, object]]:
    if not GTFS_STOPS_FILE.exists():
        return {}

    stops: Dict[str, Dict[str, object]] = {}
    with GTFS_STOPS_FILE.open("r", encoding="utf-8", newline="") as fp:
        reader = csv.DictReader(fp)
        for row in reader:
            stop_id = (row.get("stop_id") or "").strip()
            if not stop_id:
                continue

            lat_raw = (row.get("stop_lat") or "").strip()
            lon_raw = (row.get("stop_lon") or "").strip()
            lat = float(lat_raw) if lat_raw else None
            lon = float(lon_raw) if lon_raw else None

            stops[stop_id] = {
                "stop_id": stop_id,
                "stop_name": (row.get("stop_name") or "").strip(),
                "stop_lat": lat,
                "stop_lon": lon,
            }

    return stops


def load_stops_index() -> Dict[str, Dict[str, object]]:
    global _stops_cache, _stops_cache_mtime

    if not GTFS_STOPS_FILE.exists():
        _stops_cache = {}
        _stops_cache_mtime = None
        return _stops_cache

    mtime = GTFS_STOPS_FILE.stat().st_mtime
    if _stops_cache is None or _stops_cache_mtime != mtime:
        _stops_cache = _parse_stops_file()
        _stops_cache_mtime = mtime

    return _stops_cache


def fetch_gtfs_feed() -> gtfs_realtime_pb2.FeedMessage:
    if not AMB_GTFS_RT_URL:
        raise RuntimeError(
            "No hay URL GTFS configurada. Usa AMB_GTFS_RT_URL o el valor por defecto."
        )

    response = requests.get(AMB_GTFS_RT_URL, timeout=REQUEST_TIMEOUT_SECONDS)
    response.raise_for_status()

    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(response.content)
    return feed


def _build_estado(minutos_faltan: int) -> str:
    if minutos_faltan > 0:
        return f"Faltan {minutos_faltan} min"
    if minutos_faltan == 0:
        return "Llegando ahora"
    return "Ya ha pasado"


def consultar_parada(id_parada_buscada: str) -> List[Dict[str, object]]:
    feed = fetch_gtfs_feed()
    ahora_unix = datetime.datetime.now(datetime.timezone.utc).timestamp()
    resultados: List[Dict[str, object]] = []

    for entity in feed.entity:
        if not entity.HasField("trip_update"):
            continue

        trip_update = entity.trip_update
        id_bus = trip_update.trip.trip_id or ""
        prefijo = id_bus.split(".")[0] if id_bus else "?"
        nombre_linea = MAPA_LINEAS.get(prefijo, f"Linea {prefijo}")

        for stop_time in trip_update.stop_time_update:
            if stop_time.stop_id != id_parada_buscada:
                continue

            llegada_unix = None
            if stop_time.HasField("arrival") and stop_time.arrival.time:
                llegada_unix = int(stop_time.arrival.time)
            elif stop_time.HasField("departure") and stop_time.departure.time:
                llegada_unix = int(stop_time.departure.time)

            if llegada_unix is None:
                continue

            segundos_faltan = llegada_unix - ahora_unix
            minutos_faltan = math.floor(segundos_faltan / 60)
            hora_legible = datetime.datetime.fromtimestamp(
                llegada_unix, tz=datetime.timezone.utc
            ).astimezone().strftime("%H:%M:%S")

            resultados.append(
                {
                    "linea": nombre_linea,
                    "minutos": minutos_faltan,
                    "estado": _build_estado(minutos_faltan),
                    "hora_prevista": hora_legible,
                    "arrival_unix": llegada_unix,
                }
            )

    resultados.sort(key=lambda item: item["arrival_unix"])
    return resultados


@app.get("/api/buses/<id_parada>")
def api_buses(id_parada: str):
    id_parada = id_parada.strip()
    try:
        buses = consultar_parada(id_parada)
        return jsonify(
            {
                "stop_id": id_parada,
                "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "count": len(buses),
                "buses": buses,
            }
        )
    except Exception as exc:
        return jsonify({"error": str(exc), "stop_id": id_parada}), 500


@app.get("/api/stops/<id_parada>")
def api_stop_detail(id_parada: str):
    id_parada = id_parada.strip()
    stops = load_stops_index()
    stop = stops.get(id_parada)
    if not stop:
        return (
            jsonify(
                {
                    "error": "stop_id no encontrado en stops.txt",
                    "stop_id": id_parada,
                }
            ),
            404,
        )

    return jsonify(stop)


@app.get("/api/health")
def health():
    return jsonify({"status": "ok"})


@app.get("/")
def web_index():
    return send_from_directory(BASE_DIR, "index.html")


@app.get("/style.css")
def web_style():
    return send_from_directory(BASE_DIR, "style.css")


@app.get("/script.js")
def web_script():
    return send_from_directory(BASE_DIR, "script.js")


with app.app_context():
    ensure_stops_file()


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=False)
