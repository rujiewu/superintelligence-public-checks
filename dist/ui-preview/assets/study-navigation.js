/* Section orientation may be bookmarked privately; it never records progress. */
window.HUB_STUDY_NAVIGATION = (panel, select, toolbar, counter, onPosition = () => {}) => {
  let targets = [];
  let scheduled = false;
  const update = () => {
    scheduled = false;
    if (!targets.length || !select.getClientRects().length) return;
    const toolbarBoundary = toolbar.getBoundingClientRect().bottom + 24;
    const panelStart = panel.getBoundingClientRect().top + panel.clientTop;
    let current = targets[0];
    for (const target of targets) {
      // Native start-alignment includes this target's CSS scroll margin. Use the
      // same reading band so a completed jump does not reselect its predecessor.
      const margin = Number.parseFloat(getComputedStyle(target.element).scrollMarginTop);
      const boundary = Number.isFinite(margin) && margin > 0
        ? Math.max(toolbarBoundary, panelStart + margin + 2)
        : toolbarBoundary;
      if (target.element.getBoundingClientRect().top <= boundary) current = target;
    }
    select.value = current.value;
    counter.textContent = `${targets.indexOf(current) + 1} / ${targets.length}`;
    onPosition(current.value);
  };
  const refresh = () => {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(update);
    }
  };
  panel.addEventListener("scroll", refresh, { passive: true });
  window.addEventListener("resize", refresh);
  new ResizeObserver(refresh).observe(panel);
  return {
    setTargets(next) {
      targets = next.filter(target => target.element);
      counter.textContent = "";
      refresh();
    },
    refresh,
  };
};
