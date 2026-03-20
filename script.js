const API_BASE_URL = window.API_BASE_URL || "";
const AUTO_REFRESH_MS = 30_000;

const map = L.map("map").setView([41.3888, 2.159], 12);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const stopsCluster = L.markerClusterGroup({
  chunkedLoading: true,
  chunkInterval: 180,
  chunkDelay: 25,
  showCoverageOnHover: false,
  removeOutsideVisibleBounds: true,
  spiderfyOnMaxZoom: true,
});
map.addLayer(stopsCluster);

const elements = {
  form: document.getElementById("search-form"),
  input: document.getElementById("stop-id-input"),
  searchButton: document.getElementById("search-button"),
  refreshButton: document.getElementById("refresh-button"),
  refreshInfo: document.getElementById("refresh-info"),
  statusBanner: document.getElementById("status-banner"),
  resultsPanel: document.getElementById("results-panel"),
};

let lastStopId = "";
let lastStopMeta = null;
let stopMarker = null;
let autoRefreshTimer = null;
let refreshTickTimer = null;
let nextRefreshAt = null;
const stopMarkersById = new Map();

function normalizeStopId(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value.includes(":")) {
    return value;
  }

  const parts = value.split(":");
  return parts[parts.length - 1].trim();
}

function numericStopId(rawValue) {
  const normalized = normalizeStopId(rawValue);
  const digits = normalized.replace(/\D/g, "");
  if (!digits) {
    return "";
  }
  return digits.replace(/^0+/, "") || "0";
}

function keyVariantsForStopId(stopId) {
  const normalized = normalizeStopId(stopId);
  const numeric = numericStopId(normalized);
  const keys = [normalized];

  if (numeric) {
    keys.push(numeric);
    keys.push(numeric.padStart(6, "0"));
    keys.push(numeric.padStart(5, "0"));
    keys.push(numeric.padStart(4, "0"));
  }

  return keys.filter(Boolean);
}

function registerStopMarker(stopId, marker) {
  for (const key of keyVariantsForStopId(stopId)) {
    if (!stopMarkersById.has(key)) {
      stopMarkersById.set(key, marker);
    }
  }
}

function findStopMarker(stopId) {
  for (const key of keyVariantsForStopId(stopId)) {
    const marker = stopMarkersById.get(key);
    if (marker) {
      return marker;
    }
  }
  return null;
}

function getKnownStopMeta(stopId) {
  const marker = findStopMarker(stopId);
  return marker?.options?.stopData || null;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function setStatus(message, isError = false) {
  elements.statusBanner.textContent = message;
  elements.statusBanner.classList.toggle("error", isError);
}

function setLoading(isLoading) {
  elements.searchButton.disabled = isLoading;
  elements.refreshButton.disabled = isLoading;
}

function renderEmpty(message) {
  elements.resultsPanel.innerHTML = `<div class="empty-state">${message}</div>`;
}

function renderBuses(buses) {
  if (!buses.length) {
    renderEmpty("No hay llegadas previstas para esta parada en este momento.");
    return;
  }

  const html = buses
    .map((bus) => {
      let timeClass = "";
      if (bus.minutos < 0) {
        timeClass = "danger";
      } else if (bus.minutos <= 2) {
        timeClass = "warn";
      }

      return `
        <article class="bus-card">
          <div class="bus-line">${bus.linea}</div>
          <div class="bus-time ${timeClass}">${bus.estado}</div>
          <div class="bus-meta">Hora prevista: ${bus.hora_prevista}</div>
        </article>
      `;
    })
    .join("");

  elements.resultsPanel.innerHTML = html;
}

async function loadStopsOnMap() {
  try {
    setStatus("Cargando paradas del AMB en el mapa...");

    const response = await fetch(`${API_BASE_URL}/api/stops`);
    const stops = await response.json();
    if (!response.ok) {
      throw new Error("No se pudieron cargar las paradas.");
    }
    if (!Array.isArray(stops)) {
      throw new Error("Formato invalido en /api/stops.");
    }

    const markers = [];
    let processed = 0;
    for (const stop of stops) {
      if (typeof stop.stop_lat !== "number" || typeof stop.stop_lon !== "number") {
        continue;
      }

      const marker = L.marker([stop.stop_lat, stop.stop_lon], {
        title: `${stop.stop_name || "Parada"} (${stop.stop_id})`,
        stopData: stop,
      });

      marker.bindPopup(
        `<b>${escapeHtml(stop.stop_name || "Parada")}</b><br>ID: ${escapeHtml(
          stop.stop_id
        )}`
      );

      marker.on("click", () => {
        const selectedId = stop.stop_id;
        elements.input.value = selectedId;
        setStatus(
          `${stop.stop_name || "Parada"} (ID: ${selectedId}) seleccionada. Consultando tiempos...`
        );
        loadStopData(selectedId, false, stop);
      });

      registerStopMarker(stop.stop_id, marker);
      markers.push(marker);
      processed += 1;

      // Cede el hilo cada cierto numero de paradas para mantener UI fluida.
      if (processed % 900 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    stopsCluster.addLayers(markers);
    setStatus(
      `Mapa listo. ${markers.length} paradas cargadas. Busca por ID o haz clic en un pin.`
    );
  } catch (error) {
    setStatus(
      `No se pudieron cargar las paradas del mapa: ${error.message}`,
      true
    );
  }
}

async function fetchStopMeta(stopId) {
  try {
    const response = await fetch(
      `${API_BASE_URL}/api/stops/${encodeURIComponent(stopId)}`
    );
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch (error) {
    return null;
  }
}

function paintStopMarker(stop) {
  if (!stop || stop.stop_lat == null || stop.stop_lon == null) {
    return;
  }

  const existingMarker = findStopMarker(stop.stop_id);
  if (existingMarker) {
    if (stopMarker) {
      stopMarker.remove();
      stopMarker = null;
    }

    map.flyTo([stop.stop_lat, stop.stop_lon], 16, { duration: 0.8 });
    stopsCluster.zoomToShowLayer(existingMarker, () => {
      existingMarker.openPopup();
    });
    return;
  }

  if (stopMarker) {
    stopMarker.remove();
  }

  stopMarker = L.marker([stop.stop_lat, stop.stop_lon]).addTo(map);
  stopMarker.bindPopup(`<b>${stop.stop_name || "Parada"}</b><br>ID: ${stop.stop_id}`);
  stopMarker.openPopup();
  map.flyTo([stop.stop_lat, stop.stop_lon], 16, { duration: 0.8 });
}

function startAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
  }
  if (refreshTickTimer) {
    clearInterval(refreshTickTimer);
  }

  nextRefreshAt = Date.now() + AUTO_REFRESH_MS;
  autoRefreshTimer = setInterval(() => {
    if (lastStopId) {
      loadStopData(lastStopId, true, lastStopMeta);
      nextRefreshAt = Date.now() + AUTO_REFRESH_MS;
    }
  }, AUTO_REFRESH_MS);

  refreshTickTimer = setInterval(() => {
    if (!nextRefreshAt || !lastStopId) {
      elements.refreshInfo.textContent = "Auto-refresh: cada 30s";
      return;
    }

    const secondsLeft = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
    elements.refreshInfo.textContent = `Auto-refresh en ${secondsLeft}s`;
  }, 1000);
}

async function loadStopData(stopId, silent = false, knownStopMeta = null) {
  const normalizedStopId = normalizeStopId(stopId);
  if (!normalizedStopId) {
    return;
  }

  const candidateStopMeta = knownStopMeta || getKnownStopMeta(normalizedStopId);
  const stopMetaPromise = candidateStopMeta
    ? Promise.resolve(candidateStopMeta)
    : fetchStopMeta(normalizedStopId);

  setLoading(true);
  if (!silent) {
    if (candidateStopMeta?.stop_name) {
      setStatus(
        `Consultando ${candidateStopMeta.stop_name} (ID: ${candidateStopMeta.stop_id || normalizedStopId})...`
      );
    } else {
      setStatus(`Consultando parada ${normalizedStopId}...`);
    }
  }

  try {
    const response = await fetch(
      `${API_BASE_URL}/api/buses/${encodeURIComponent(normalizedStopId)}`
    );

    let data = {};
    try {
      data = await response.json();
    } catch (parseError) {
      data = {};
    }

    if (!response.ok) {
      throw new Error(data.error || "No se pudo consultar la API.");
    }

    const stopMeta = (await stopMetaPromise) || candidateStopMeta;
    const canonicalStopId = stopMeta?.stop_id || normalizedStopId;
    const stopLabel = stopMeta?.stop_name
      ? `${stopMeta.stop_name} (ID: ${canonicalStopId})`
      : `Parada ${canonicalStopId}`;

    renderBuses(data.buses || []);
    setStatus(`${stopLabel} actualizada. ${data.count ?? 0} bus(es) encontrados.`);

    lastStopId = canonicalStopId;
    lastStopMeta = stopMeta;
    elements.input.value = canonicalStopId;
    nextRefreshAt = Date.now() + AUTO_REFRESH_MS;

    paintStopMarker(stopMeta);
  } catch (error) {
    const stopMeta = (await stopMetaPromise) || candidateStopMeta;
    lastStopMeta = stopMeta;
    paintStopMarker(stopMeta);
    setStatus(error.message, true);
    if (!silent) {
      renderEmpty("No se pudo obtener informacion de llegadas.");
    }
  } finally {
    setLoading(false);
  }
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const stopId = elements.input.value.trim();
  loadStopData(stopId);
});

elements.refreshButton.addEventListener("click", () => {
  if (!lastStopId) {
    setStatus("Primero busca una parada.", true);
    return;
  }
  loadStopData(lastStopId, false, lastStopMeta);
});

loadStopsOnMap();
startAutoRefresh();
