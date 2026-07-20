const DEFAULT_SETTINGS = {
  behavior: "recent",
  ignorePinned: false
};

const form = document.querySelector("#settings");
const status = document.querySelector("#status");

async function restore() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const behavior = form.elements.namedItem("behavior");
  for (const radio of behavior) {
    radio.checked = radio.value === settings.behavior;
  }
  document.querySelector("#ignorePinned").checked = settings.ignorePinned;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const behavior = form.elements.namedItem("behavior").value;
  const ignorePinned = document.querySelector("#ignorePinned").checked;
  await chrome.storage.sync.set({ behavior, ignorePinned });
  status.textContent = "保存しました";
  window.setTimeout(() => {
    status.textContent = "";
  }, 1800);
});

restore();
