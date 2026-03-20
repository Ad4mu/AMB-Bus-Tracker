import csv
import datetime
import math
import os
from pathlib import Path
from typing import Dict, List, Optional

import requests
from flask import Flask, jsonify, send_from_directory
from flask_cors import CORS
from google.transit import gtfs_realtime_pb2


app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})


DEFAULT_AMB_GTFS_RT_URL = "https://www.ambmobilitat.cat/transit/trips-updates/trips.bin"
AMB_GTFS_RT_URL = os.getenv("AMB_GTFS_RT_URL", DEFAULT_AMB_GTFS_RT_URL).strip()
REQUEST_TIMEOUT_SECONDS = int(os.getenv("REQUEST_TIMEOUT_SECONDS", "15"))
GTFS_STOPS_FILE = Path(os.getenv("GTFS_STOPS_FILE", "stops.txt"))


MAPA_LINEAS = {
    "181": "L52",
    "204": "L82",
    "417": "M12",
}


_stops_cache: Optional[Dict[str, Dict[str, object]]] = None
_stops_cache_mtime: Optional[float] = None
BASE_DIR = Path(__file__).resolve().parent


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


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=False)
