const API_BASE_URL = window.API_BASE_URL || "";
const AUTO_REFRESH_MS = 30_000;

const map = L.map("map").setView([41.3888, 2.159], 12);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

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
let stopMarker = null;
let autoRefreshTimer = null;
let refreshTickTimer = null;
let nextRefreshAt = null;

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
      loadStopData(lastStopId, true);
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

async function loadStopData(stopId, silent = false) {
  if (!stopId) {
    return;
  }

  const stopMetaPromise = fetchStopMeta(stopId);
  setLoading(true);
  if (!silent) {
    setStatus(`Consultando parada ${stopId}...`);
  }

  try {
    const response = await fetch(
      `${API_BASE_URL}/api/buses/${encodeURIComponent(stopId)}`
    );
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "No se pudo consultar la API.");
    }

    renderBuses(data.buses || []);
    setStatus(
      `Parada ${stopId} actualizada. ${data.count ?? 0} bus(es) encontrados.`
    );
    lastStopId = stopId;
    nextRefreshAt = Date.now() + AUTO_REFRESH_MS;

    const stopMeta = await stopMetaPromise;
    paintStopMarker(stopMeta);
  } catch (error) {
    const stopMeta = await stopMetaPromise;
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
  loadStopData(lastStopId);
});

startAutoRefresh();
