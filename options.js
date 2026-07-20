const DEFAULT_SETTINGS = {
  behavior: "recent",
  ignorePinned: false
};

const form = document.querySelector("#settings");
const status = document.querySelector("#status");
const diagnosticLogs = document.querySelector("#diagnosticLogs");

async function restore() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const behavior = form.elements.namedItem("behavior");
  for (const radio of behavior) {
    radio.checked = radio.value === settings.behavior;
  }
  document.querySelector("#ignorePinned").checked = settings.ignorePinned;
}

async function save() {
  const behavior = form.elements.namedItem("behavior").value;
  const ignorePinned = document.querySelector("#ignorePinned").checked;
  await chrome.storage.sync.set({ behavior, ignorePinned });
  status.textContent = "保存しました";
  window.setTimeout(() => {
    status.textContent = "";
  }, 1800);
}

form.addEventListener("change", save);

function formatLogs(logs) {
  if (!logs.length) return "ログなし";
  return logs
    .map(({ time, event, details }) => `${time} ${event} ${JSON.stringify(details)}`)
    .join("\n");
}

async function loadDiagnosticLogs() {
  const result = await chrome.storage.local.get({ diagnosticLogs: [] });
  diagnosticLogs.textContent = formatLogs(result.diagnosticLogs);
  diagnosticLogs.scrollTop = diagnosticLogs.scrollHeight;
}

document.querySelector("#copyLogs").addEventListener("click", async () => {
  await navigator.clipboard.writeText(diagnosticLogs.textContent);
});

document.querySelector("#clearLogs").addEventListener("click", async () => {
  await chrome.storage.local.remove("diagnosticLogs");
  await loadDiagnosticLogs();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.diagnosticLogs) {
    diagnosticLogs.textContent = formatLogs(changes.diagnosticLogs.newValue || []);
    diagnosticLogs.scrollTop = diagnosticLogs.scrollHeight;
  }
});

restore();
loadDiagnosticLogs();
