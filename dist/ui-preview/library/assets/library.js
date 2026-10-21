(() => {
  const root = document.documentElement;
  const themeButton = document.querySelector("#theme-toggle");
  const preferred = localStorage.getItem("reading-agent-theme") ||
    (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  root.dataset.theme = preferred;

  themeButton?.addEventListener("click", () => {
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    localStorage.setItem("reading-agent-theme", next);
  });

  const progress = document.querySelector("#reading-progress");
  const updateProgress = () => {
    if (!progress) return;
    const scrollable = document.documentElement.scrollHeight - window.innerHeight;
    progress.style.width = `${scrollable > 0 ? (window.scrollY / scrollable) * 100 : 0}%`;
  };
  document.addEventListener("scroll", updateProgress, { passive: true });
  updateProgress();

  const tabs = [...document.querySelectorAll("[data-tab]")];
  const tabList = document.querySelector(".segmented-control");
  const tabShell = tabList?.closest(".tab-scroll-shell");
  const updateTabOverflow = () => {
    if (!tabList || !tabShell) return;
    tabShell.classList.toggle("is-scrolled", tabList.scrollLeft > 2);
    tabShell.classList.toggle(
      "has-more",
      tabList.scrollLeft + tabList.clientWidth < tabList.scrollWidth - 2,
    );
  };
  const activateTab = (tab, moveFocus = false) => {
    tabs.forEach((item) => {
      const selected = item === tab;
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll(".reading-panel").forEach((panel) => {
      const selected = panel.id === tab.dataset.tab;
      panel.classList.toggle("active", selected);
      panel.hidden = !selected;
    });
    if (moveFocus) tab.focus();
    requestAnimationFrame(updateTabOverflow);
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activateTab(tab));
    tab.addEventListener("keydown", (event) => {
      let targetIndex = null;
      if (event.key === "ArrowRight") targetIndex = (index + 1) % tabs.length;
      if (event.key === "ArrowLeft") targetIndex = (index - 1 + tabs.length) % tabs.length;
      if (event.key === "Home") targetIndex = 0;
      if (event.key === "End") targetIndex = tabs.length - 1;
      if (targetIndex === null) return;
      event.preventDefault();
      activateTab(tabs[targetIndex], true);
    });
  });
  tabList?.addEventListener("scroll", updateTabOverflow, { passive: true });
  window.addEventListener("resize", updateTabOverflow);
  updateTabOverflow();

  const dataNode = document.querySelector("#search-data");
  if (!dataNode) return;
  const records = JSON.parse(dataNode.textContent);
  const search = document.querySelector("#library-search");
  const domain = document.querySelector("#domain-filter");
  const difficulty = document.querySelector("#difficulty-filter");
  const results = document.querySelector("#search-results");
  const count = document.querySelector("#result-count");

  const escapeHTML = (value) => value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);

  const render = () => {
    const query = search.value.trim().toLocaleLowerCase("zh-CN");
    const matches = records.filter((record) => {
      const haystack = `${record.title} ${record.authors} ${record.domain} ${record.discipline} ${record.topic} ${record.concepts} ${record.claims}`.toLocaleLowerCase("zh-CN");
      return (!query || haystack.includes(query)) &&
        (!domain.value || record.domain === domain.value) &&
        (!difficulty.value || String(record.difficulty) === difficulty.value);
    });
    count.textContent = `${matches.length} 本书`;
    results.innerHTML = (query || domain.value || difficulty.value)
      ? matches.map((record) => `<a href="${record.url}"><strong>${escapeHTML(record.title)}</strong><span>${escapeHTML(record.authors)} · ${escapeHTML(record.topic)}</span></a>`).join("") || "<p class=empty-result>没有符合条件的结果。</p>"
      : "";
  };
  [search, domain, difficulty].forEach((control) => control.addEventListener("input", render));
})();
