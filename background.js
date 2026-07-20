const DEFAULT_SETTINGS = {
  behavior: "recent",
  ignorePinned: false
};

// windowId -> tab IDs, ordered from most recently to least recently active.
const historyByWindow = new Map();
// Tracks the active tab before Chrome applies its own close-tab selection.
const activeByWindow = new Map();

async function persistState() {
  await chrome.storage.session.set({
    tabHistory: Object.fromEntries(historyByWindow),
    activeTabs: Object.fromEntries(activeByWindow)
  });
}

async function restoreState() {
  const { tabHistory = {}, activeTabs = {} } =
    await chrome.storage.session.get(["tabHistory", "activeTabs"]);

  for (const [windowId, history] of Object.entries(tabHistory)) {
    historyByWindow.set(Number(windowId), history);
  }
  for (const [windowId, tabId] of Object.entries(activeTabs)) {
    activeByWindow.set(Number(windowId), tabId);
  }

  if (!activeByWindow.size) await initialize();
}

async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await chrome.storage.sync.get(DEFAULT_SETTINGS)) };
}

function recordActivation(tabId, windowId, persist = true) {
  activeByWindow.set(windowId, tabId);
  const history = historyByWindow.get(windowId) || [];
  historyByWindow.set(
    windowId,
    [tabId, ...history.filter((id) => id !== tabId)].slice(0, 100)
  );
  if (persist) void persistState();
}

async function initializeWindow(windowId) {
  try {
    const tabs = await chrome.tabs.query({ windowId });
    const activeTab = tabs.find((tab) => tab.active);
    if (activeTab?.id !== undefined) {
      recordActivation(activeTab.id, windowId);
    }
  } catch {
    // The window may have disappeared while the service worker was starting.
  }
}

async function initialize() {
  const windows = await chrome.windows.getAll({ populate: true });
  for (const window of windows) {
    const activeTab = window.tabs?.find((tab) => tab.active);
    if (activeTab?.id !== undefined) {
      recordActivation(activeTab.id, window.id, false);
    }
  }
  await persistState();
}

const ready = restoreState();

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const current = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...current });
  await initialize();

  if (reason === "install") {
    await chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(initialize);

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  await ready;
  recordActivation(tabId, windowId);
});

chrome.windows.onCreated.addListener(async (window) => {
  await ready;
  await initializeWindow(window.id);
});
chrome.windows.onRemoved.addListener((windowId) => {
  historyByWindow.delete(windowId);
  activeByWindow.delete(windowId);
  void persistState();
});

function selectTarget(tabs, removedTabId, windowId, settings) {
  const eligible = tabs.filter(
    (tab) => tab.id !== undefined && (!settings.ignorePinned || !tab.pinned)
  );
  if (!eligible.length) return undefined;

  if (settings.behavior === "leftmost") return eligible[0];
  if (settings.behavior === "rightmost") return eligible.at(-1);

  const history = historyByWindow.get(windowId) || [];
  const eligibleIds = new Set(eligible.map((tab) => tab.id));
  const recentId = history.find(
    (id) => id !== removedTabId && eligibleIds.has(id)
  );
  return eligible.find((tab) => tab.id === recentId);
}

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  await ready;
  const { windowId, isWindowClosing } = removeInfo;
  const wasActive = activeByWindow.get(windowId) === tabId;
  const history = historyByWindow.get(windowId) || [];
  historyByWindow.set(windowId, history.filter((id) => id !== tabId));
  void persistState();

  if (isWindowClosing || !wasActive) return;

  try {
    const [settings, tabs] = await Promise.all([
      getSettings(),
      chrome.tabs.query({ windowId })
    ]);
    const target = selectTarget(tabs, tabId, windowId, settings);
    if (target?.id === undefined) return;

    await chrome.tabs.update(target.id, { active: true });
    recordActivation(target.id, windowId);
  } catch {
    // A rapid window/tab close can invalidate IDs between query and update.
  }
});
