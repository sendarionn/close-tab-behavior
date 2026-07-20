const LABELS = {
  recent: "直近でアクティブだったタブ",
  rightmost: "最も右のタブ",
  leftmost: "最も左のタブ"
};

chrome.storage.sync.get({ behavior: "recent", ignorePinned: false }).then((settings) => {
  document.querySelector("#current").textContent = LABELS[settings.behavior];
});

document.querySelector("#openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
