/* A continuous, source-grouped view of the selected book's existing evidence. */
window.HUB_EVIDENCE = (() => {
  const citationId = id => `hub-citation-${encodeURIComponent(id)}`;
  const claimId = id => `hub-claim-${encodeURIComponent(id)}`;
  const relations = { SUPPORTS: "支持", MENTIONS: "提及", CONTRADICTS: "反驳", CONTEXTUALIZES: "补充语境" };
  const types = { BOOK_SOURCE: "原书", PRIMARY_SOURCE: "一手资料", SCHOLARLY_SOURCE: "学术资料",
    OFFICIAL_SOURCE: "官方资料", REPUTABLE_SECONDARY_SOURCE: "二手研究", REVIEW: "评论",
    AUTHOR_INTERPRETATION: "研究者解释", MODEL_INFERENCE: "系统推论" };
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  };

  function render(container, evidence) {
    container.replaceChildren();
    if (evidence.publication?.policy === "OWNER_DIRECT_RELEASE") {
      container.append(node("p", "evidence-meta publication-record",
        "本次讲解修订已发布，尚待独立评审。原研究与旧版评审记录保留。"));
    }
    const sources = evidence.sources || [];
    const citations = evidence.citations || [];
    const claims = evidence.claims || [];
    if (!sources.length && !citations.length) return;
    container.append(node("h4", "", "来源与引文"));
    const list = node("div", "evidence-sources");
    const known = new Set(sources.map(source => source.source_id));
    const groups = [...sources];
    if (citations.some(citation => !known.has(citation.source_id))) {
      groups.push({ source_id: null, title: "来源记录缺失，需核对" });
    }
    groups.forEach(source => {
      const entry = node("section", "evidence-source");
      const heading = node("h5", "", source.title || "未命名来源");
      try {
        const url = new URL(source.url);
        if (["http:", "https:"].includes(url.protocol)) {
          const link = node("a", "", source.title || "查看原始来源");
          link.href = url.href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          heading.replaceChildren(link);
        }
      } catch { /* Missing or unsafe URLs are shown as text, never executable links. */ }
      entry.append(heading);
      const metadata = [
        source.evidence_type && `${types[source.evidence_type] || source.evidence_type} · ${source.evidence_type}`,
        source.source_id && `来源编号 ${source.source_id}`,
        (source.creators || []).join("、"), source.publisher,
        source.publication_date && `出版 ${source.publication_date}`,
        source.retrieval_date && `访问 ${source.retrieval_date}`,
        source.reliability && `可靠性 ${source.reliability}`,
      ].filter(Boolean);
      entry.append(node("p", "evidence-meta", metadata.join(" · ")));
      if (source.license || source.copyright_status) entry.append(node("p", "evidence-meta",
        `权利：${[source.license, source.copyright_status].filter(Boolean).join(" · ")}`));
      if (source.notes) entry.append(node("p", "evidence-meta", source.notes));
      const records = citations.filter(citation => source.source_id === null
        ? !known.has(citation.source_id) : citation.source_id === source.source_id);
      records.forEach(citation => {
        const record = node("article", "evidence-citation");
        record.id = citationId(citation.citation_id);
        record.tabIndex = -1;
        const number = citations.indexOf(citation) + 1;
        record.append(node("h6", "", `[${number}] ${citation.locator || "定位待核对"}`));
        record.append(node("p", "", citation.support_note || "支持说明待补充"));
        record.append(node("p", "evidence-meta", [citation.citation_id,
          relations[citation.relationship] || citation.relationship,
          citation.relationship, citation.verified ? "已核对" : "未标记核对",
        ].filter(Boolean).join(" · ")));
        const backlinks = node("p", "evidence-backlinks", "关联主张：");
        claims.filter(claim => (claim.citation_ids || []).includes(citation.citation_id)).forEach(claim => {
          // Some claims occur only in the complete book's alternate reading layers.
          const target = document.getElementById(claimId(claim.claim_id));
          const label = node(target ? "a" : "span", "", claim.claim_id);
          label.title = claim.statement || "";
          if (target) {
            label.href = `#${target.id}`;
            label.setAttribute("aria-label", `返回主张：${claim.statement || claim.claim_id}`);
          }
          backlinks.append(label, document.createTextNode(" "));
        });
        record.append(backlinks);
        entry.append(record);
      });
      if (!records.length) entry.append(node("p", "evidence-meta", "仅作版本或获取信息记录；未关联正文引文。"));
      list.append(entry);
    });
    container.append(list);
  }
  return Object.freeze({ render, citationId, claimId });
})();
