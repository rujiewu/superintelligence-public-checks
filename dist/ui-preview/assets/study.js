/* Deterministic presentation helpers. Section positions are not mastery records. */
window.HUB_STUDY = Object.freeze({
  catalogChoices(module) {
    return module === "learning" ? [["study", "教学课"], ["all", "全部条目 · 含资源路线"]]
      : module === "reading" ? [["study", "书籍研究"], ["all", "全部条目 · 含计划与书目"]]
      : [["all", "全部条目"]];
  },
  catalogMatches(item, module, filter) {
    if (filter !== "study") return true;
    return module === "learning" ? Boolean(item.evidence?.lesson)
      : module === "reading" ? item.kind === "book" : true;
  },
  searchCatalog(items, query) {
    const normalize = text => String(text || "").normalize("NFKC").toLocaleLowerCase();
    const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
    return items.map((item, index) => {
      const title = normalize(item.title);
      const metadata = normalize([item.subtitle, item.group, item.placement?.spine_title, item.placement?.stage_title].join(" "));
      const body = normalize(item.body);
      if (!terms.every(term => title.includes(term) || metadata.includes(term) || body.includes(term))) return null;
      return { item, index, score: terms.reduce((sum, term) => sum + (title.includes(term) ? 4 : metadata.includes(term) ? 2 : 1), 0) };
    }).filter(Boolean).sort((a, b) => b.score - a.score || a.index - b.index).map(row => row.item);
  },
  sections(source) {
    const result = [];
    let title = "正文";
    let lines = [];
    let fence = null;
    let explicit = false;
    const flush = () => {
      const body = lines.join("\n").trim();
      if (body || explicit) result.push({ title, body });
    };
    String(source || "").replace(/\r\n?/g, "\n").split("\n").forEach(line => {
      const marker = line.match(/^\s*(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      }
      const heading = !fence && !marker && (line.match(/^##\s+(.+)\s*$/)
        || (!result.length && !explicit && !lines.some(entry => entry.trim()) && line.match(/^#\s+(.+)\s*$/)));
      if (heading) {
        flush();
        title = heading[1].trim();
        lines = [];
        explicit = true;
      } else lines.push(line);
    });
    flush();
    return result.map((section, index) => ({ ...section, position: index + 1 }));
  },
  table(lines) {
    // A strict pipe-table subset. Non-tables stay prose; no HTML is interpreted.
    const split = line => {
      const cells = [];
      let cell = "";
      let code = false;
      const text = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
      for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (char === "\\" && text[index + 1] === "|") { cell += "|"; index++; }
        else if (char === "`") { code = !code; cell += char; }
        else if (char === "|" && !code) { cells.push(cell.trim()); cell = ""; }
        else cell += char;
      }
      cells.push(cell.trim());
      return cells;
    };
    if (lines.length < 2 || !lines[0].includes("|")) return null;
    const header = split(lines[0]);
    const separator = split(lines[1]);
    if (header.length < 2 || header.length !== separator.length
        || !separator.every(cell => /^:?-{3,}:?$/.test(cell))) return null;
    const rows = lines.slice(2).map(split);
    if (rows.some(row => row.length !== header.length)) return null;
    return { header, rows };
  },
  question(material, section, action) {
    const requests = {
      explain: "请把这一节最关键的一条推理讲清楚：从哪个问题出发，经过哪些前提，为什么得到这个结论？已有解释不足时请指出缺口，不要再罗列摘要。",
      example: "请针对这一节给一个具体的教学例子，让我先尝试解释，再逐步纠正。自拟例子请标明是假设，不要冒充历史事实或真实市场数据。",
      evidence: "这一节哪个判断最需要追问依据？请区分资料支持了什么、没有支持什么，引用现有出处，不要补造来源。",
      transfer: "请围绕这一节提出一个迁移问题：把关键机制放到另一种情境里，哪些前提仍成立，哪些需要改变？先让我尝试回答。自拟情境请标为假设；其他作品或领域未提供的内容不要当作已读证据。",
    };
    return `围绕《${material.title}》第 ${section.position} 节「${section.title}」讨论。\n\n${requests[action] || requests.explain}`;
  },
});
