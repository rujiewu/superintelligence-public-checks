/* An editorial construction path, never learner progress or accepted selections. */
window.HUB_PROGRAM = Object.freeze({
  render(container, evidence) {
    const programme = evidence?.programme;
    if (!programme || !["candidate_min", "candidate_max", "target_works", "research_batch"]
      .every(key => Number.isInteger(programme[key]) && programme[key] > 0)) return;
    const figure = document.createElement("figure");
    figure.className = "programme-path";
    const caption = document.createElement("figcaption");
    caption.textContent = "建设路径 · 编辑规划";
    const steps = document.createElement("ol");
    steps.setAttribute("aria-label", "从发现候选到开展研究的四步路径");
    [
      ["发现", `${programme.candidate_min}–${programme.candidate_max} 部候选`],
      ["核对", "作品与版本身份"],
      ["遴选", `目标 ${programme.target_works} 部 · 独立评审`],
      ["研究", `每批约 ${programme.research_batch} 部 · 合法来源`],
    ].forEach(([label, detail]) => {
      const step = document.createElement("li");
      const title = document.createElement("strong");
      title.textContent = label;
      const text = document.createElement("span");
      text.textContent = detail;
      step.append(title, text);
      steps.append(step);
    });
    figure.append(caption, steps);
    container.append(figure);
  },
});
