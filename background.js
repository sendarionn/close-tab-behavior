const DEFAULT_SETTINGS = {
  behavior: "recent",
  ignorePinned: false
};
const MAX_DIAGNOSTIC_LOGS = 100;

// windowId -> tab IDs, ordered from most recently to least recently active.
const historyByWindow = new Map();
// Tracks the active tab before Chrome applies its own close-tab selection.
const activeByWindow = new Map();
// Keeps the history from immediately before an activation event so a close-triggered
// activation cannot replace the real most recently used tab.
const pendingActivationByWindow = new Map();
let diagnosticQueue = Promise.resolve();

function errorDetails(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  };
}

function logDiagnostic(event, details = {}) {
  const entry = {
    time: new Date().toISOString(),
    event,
    details
  };

  console.info("[close-tab-behavior]", entry);
  diagnosticQueue = diagnosticQueue
    .then(async () => {
      const { diagnosticLogs = [] } = await chrome.storage.local.get("diagnosticLogs");
      await chrome.storage.local.set({
        diagnosticLogs: [...diagnosticLogs, entry].slice(-MAX_DIAGNOSTIC_LOGS)
      });
    })
    .catch((error) => {
      console.error("[close-tab-behavior] diagnostic.write.error", error);
    });
}

async function persistState() {
  await chrome.storage.session.set({
    tabHistory: Object.fromEntries(historyByWindow),
    activeTabs: Object.fromEntries(activeByWindow)
  });
  logDiagnostic("state.persisted", {
    windows: activeByWindow.size
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
  logDiagnostic("state.restored", {
    windows: activeByWindow.size
  });
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
  logDiagnostic("activation.recorded", {
    tabId,
    windowId,
    historyLength: historyByWindow.get(windowId).length
  });
  if (persist) {
    void persistState().catch((error) => {
      logDiagnostic("state.persist.error", errorDetails(error));
    });
  }
}

async function initializeWindow(windowId) {
  try {
    const tabs = await chrome.tabs.query({ windowId });
    const activeTab = tabs.find((tab) => tab.active);
    if (activeTab?.id !== undefined) {
      recordActivation(activeTab.id, windowId);
    }
  } catch {
    logDiagnostic("window.initialize.skipped", { windowId });
  }
}

async function initialize() {
  logDiagnostic("extension.initialize.started");
  const windows = await chrome.windows.getAll({ populate: true });
  for (const window of windows) {
    const activeTab = window.tabs?.find((tab) => tab.active);
    if (activeTab?.id !== undefined) {
      recordActivation(activeTab.id, window.id, false);
    }
  }
  await persistState();
  logDiagnostic("extension.initialize.completed", {
    windows: windows.length
  });
}

const ready = restoreState().catch((error) => {
  logDiagnostic("state.restore.error", errorDetails(error));
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  try {
    logDiagnostic("extension.installed", { reason });
    await ready;
    const current = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...current });

    if (reason === "install") {
      await chrome.runtime.openOptionsPage();
    }
  } catch (error) {
    logDiagnostic("extension.install.error", errorDetails(error));
  }
});

chrome.runtime.onStartup.addListener(() => {
  void initialize().catch((error) => {
    logDiagnostic("extension.startup.error", errorDetails(error));
  });
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  await ready;
  const previousTabId = activeByWindow.get(windowId);
  const transition = {
    previousTabId,
    currentTabId: tabId,
    historyBefore: [...(historyByWindow.get(windowId) || [])],
    time: Date.now()
  };
  pendingActivationByWindow.set(windowId, transition);
  logDiagnostic("tab.activated", {
    tabId,
    windowId,
    previousTabId
  });
  recordActivation(tabId, windowId);

  globalThis.setTimeout(() => {
    if (pendingActivationByWindow.get(windowId) === transition) {
      pendingActivationByWindow.delete(windowId);
    }
  }, 500);
});

chrome.windows.onCreated.addListener(async (window) => {
  await ready;
  await initializeWindow(window.id);
});
chrome.windows.onRemoved.addListener((windowId) => {
  historyByWindow.delete(windowId);
  activeByWindow.delete(windowId);
  pendingActivationByWindow.delete(windowId);
  logDiagnostic("window.removed", { windowId });
  void persistState().catch((error) => {
    logDiagnostic("state.persist.error", errorDetails(error));
  });
});

function selectTarget(tabs, removedTabId, history, settings) {
  const eligible = tabs.filter(
    (tab) => tab.id !== undefined && (!settings.ignorePinned || !tab.pinned)
  );
  if (!eligible.length) return undefined;

  if (settings.behavior === "leftmost") return eligible[0];
  if (settings.behavior === "rightmost") return eligible.at(-1);

  const eligibleIds = new Set(eligible.map((tab) => tab.id));
  const recentId = history.find(
    (id) => id !== removedTabId && eligibleIds.has(id)
  );
  return eligible.find((tab) => tab.id === recentId);
}

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  await ready;
  const { windowId, isWindowClosing } = removeInfo;
  const transition = pendingActivationByWindow.get(windowId);
  const transitionMatchesClose =
    transition?.previousTabId === tabId && Date.now() - transition.time <= 500;
  const wasActive =
    activeByWindow.get(windowId) === tabId || transitionMatchesClose;
  const historyBeforeClose = transitionMatchesClose
    ? transition.historyBefore
    : [...(historyByWindow.get(windowId) || [])];
  const selectionHistory = historyBeforeClose.filter((id) => id !== tabId);
  historyByWindow.set(windowId, selectionHistory);
  if (transitionMatchesClose) {
    pendingActivationByWindow.delete(windowId);
  }
  logDiagnostic("tab.removed", {
    tabId,
    windowId,
    isWindowClosing,
    trackedActiveTabId: activeByWindow.get(windowId),
    transitionMatchesClose,
    selectionHistory,
    wasActive
  });
  void persistState().catch((error) => {
    logDiagnostic("state.persist.error", errorDetails(error));
  });

  if (isWindowClosing || !wasActive) {
    logDiagnostic("tab.selection.skipped", {
      tabId,
      windowId,
      reason: isWindowClosing ? "window-closing" : "not-tracked-as-active"
    });
    return;
  }

  try {
    const [settings, tabs] = await Promise.all([
      getSettings(),
      chrome.tabs.query({ windowId })
    ]);
    const target = selectTarget(tabs, tabId, selectionHistory, settings);
    logDiagnostic("tab.target.selected", {
      removedTabId: tabId,
      windowId,
      behavior: settings.behavior,
      ignorePinned: settings.ignorePinned,
      candidates: tabs.map((tab) => ({
        id: tab.id,
        index: tab.index,
        active: tab.active,
        pinned: tab.pinned
      })),
      targetTabId: target?.id
    });
    if (target?.id === undefined) {
      logDiagnostic("tab.selection.skipped", {
        tabId,
        windowId,
        reason: "target-not-found"
      });
      return;
    }

    // Remove Chrome's temporary automatic selection from the MRU history before
    // activating the target chosen from the pre-close snapshot.
    historyByWindow.set(windowId, selectionHistory);
    await chrome.tabs.update(target.id, { active: true });
    recordActivation(target.id, windowId);
    logDiagnostic("tab.selection.completed", {
      removedTabId: tabId,
      windowId,
      targetTabId: target.id
    });
  } catch (error) {
    logDiagnostic("tab.selection.error", {
      tabId,
      windowId,
      ...errorDetails(error)
    });
  }
});
