/* Private browser navigation preferences; never answers, history or completion. */
window.HUB_WORKSPACE_STATE = (storage) => {
  const modules = new Set(["reading", "learning", "trading", "investment"]);
  const identity = value => typeof value === "string" && /^[a-z0-9_-]{1,160}$/.test(value);
  const read = key => {
    try { return storage().getItem(key); } catch { return null; }
  };
  const write = (key, value) => {
    try { storage().setItem(key, value); } catch { /* Navigation still works. */ }
  };
  const lastKey = module => `hub-last-material-v1:${module}`;
  const sectionKey = (module, resource) => `hub-section-v1:${module}:${resource}`;
  return Object.freeze({
    initial(module, ids, requested, fallback) {
      if (requested && ids.includes(requested)) return requested;
      const saved = modules.has(module) && !requested ? read(lastKey(module)) : null;
      return ids.includes(saved) ? saved : ids.includes(fallback) ? fallback : ids[0];
    },
    remember(module, resource) {
      if (modules.has(module) && identity(resource)) {
        write(lastKey(module), resource);
        window.HUB_REMOTE?.rememberNavigation?.(module, resource);
      }
    },
    section(module, resource) {
      if (!modules.has(module) || !identity(resource)) return null;
      const saved = read(sectionKey(module, resource));
      return typeof saved === "string" && saved.length <= 500 ? saved : null;
    },
    rememberSection(module, resource, section) {
      if (modules.has(module) && identity(resource) && typeof section === "string"
          && section.length <= 500 && section !== read(sectionKey(module, resource))) {
        write(sectionKey(module, resource), section);
        window.HUB_REMOTE?.rememberNavigation?.(module, resource, section);
      }
    },
    focus() { return read("hub-focus-v1") === "true"; },
    setFocus(enabled) { write("hub-focus-v1", String(Boolean(enabled))); },
  });
};
