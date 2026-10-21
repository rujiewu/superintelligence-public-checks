/* Shared book HTML in a style-isolated, non-scrolling surface (not an iframe). */
window.HUB_BOOK_STUDY = (() => {
  let root;
  let studyPages = {};
  let currentPage = 'lecture';
  const REFLECTION = {
    'adam-smith-wealth-of-nations': ['why-it-matters', 'historical-context', 'modern-assessment', 'criticism', 'further-deductions', 'what-to-remember'],
    'abelson-sussman-sicp': ['question-and-method', 'course-and-criticism', 'living-lineage', 'what-it-does-not-cover'],
    'charles-darwin-origin-of-species': ['why-it-matters', 'historical-context', 'edition-history', 'modern-assessment', 'criticism', 'intellectual-lineage', 'further-deductions', 'what-to-remember'],
    'confucius-analects': ['why-it-matters', 'text-and-history', 'dialogue-and-disagreement', 'commentary-and-transmission', 'knowledge-map', 'further-deductions', 'what-to-remember'],
    'euclid-elements': ['why-it-matters', 'historical-context', 'modern-assessment', 'criticism', 'intellectual-lineage', 'further-deductions', 'what-to-remember'],
    'john-snow-mode-communication-cholera': ['question-before-icon', 'critic-as-collaborator', 'modern-control-layers', 'where-analogy-breaks', 'transfer-audit'],
    'plato-republic': ['voices-and-setting', 'modern-verdicts'],
    'rene-descartes-discourse-method': ['problem-before-slogan', 'heart-and-error', 'machines-language-animals', 'transfer-with-boundaries'],
  };
  const CONTEXT = {
    'adam-smith-wealth-of-nations': ['why-it-matters', 'historical-context'],
    'abelson-sussman-sicp': ['question-and-method'],
    'charles-darwin-origin-of-species': ['why-it-matters', 'historical-context', 'edition-history'],
    'confucius-analects': ['why-it-matters', 'text-and-history'],
    'euclid-elements': ['why-it-matters', 'historical-context'],
    'john-snow-mode-communication-cholera': ['question-before-icon'],
    'plato-republic': ['voices-and-setting'],
    'rene-descartes-discourse-method': ['problem-before-slogan'],
  };
  function pageSections(study) {
    const reflection = new Set(['takeaway', 'argument-map', 'visualizations', 'connections', ...(REFLECTION[study.book_id] || [])]);
    const shared = new Set(['sources', 'argument-map', 'visualizations', ...(CONTEXT[study.book_id] || [])]);
    return Object.fromEntries(study.sections.map(section => [section.id,
      shared.has(section.id) || section.id.startsWith('book-section-') ? 'shared'
        : reflection.has(section.id) ? 'reflection' : 'lecture']));
  }
  function setPage(page, reason = 'navigation') {
    if (!root || !['lecture', 'reflection'].includes(page)) return;
    currentPage = page;
    for (const section of root.querySelectorAll('.book-study-content > section')) {
      section.hidden = studyPages[section.id] !== 'shared' && studyPages[section.id] !== page;
    }
    window.dispatchEvent(new CustomEvent('hub-book-page', { detail: { page, reason } }));
  }
  function reveal(element) {
    if (!root?.contains(element)) return;
    const section = element.closest('.book-study-content > section');
    const page = section && studyPages[section.id];
    if (page && page !== 'shared' && page !== currentPage) setPage(page, 'reference');
  }
  function deduplicateTakeaway(content) {
    const band = content.querySelector('#takeaway');
    const quote = band?.querySelector('blockquote');
    if (!quote || quote.id) return;
    const text = node => (node?.textContent || '').replace(/\s+/g, ' ').trim();
    const references = node => [...node.querySelectorAll('a[href]')].map(link => link.getAttribute('href')).join('\n');
    const explanation = band.querySelector(':scope > p');
    const matches = [...content.querySelectorAll('.research-section .claim')].filter(claim => {
      const statement = claim.querySelector(':scope > p');
      return statement && text(statement) === text(quote) && references(statement) === references(quote)
        && text(claim.querySelector('.claim-explanation')) === text(explanation)
        && claim.id === 'claim-' + claim.dataset.claimId
        && [...claim.children].every(node => node.tagName === 'P' || node.classList.contains('claim-meta'));
    });
    if (matches.length !== 1) return;
    const duplicate = matches[0];
    const metadata = duplicate.querySelector('.claim-meta');
    if (!metadata) return;
    // Move provenance and the citation backlink target with the exact duplicate.
    // All unique headings, explanations, identities and evidence stay visible.
    quote.id = duplicate.id;
    quote.dataset.claimId = duplicate.dataset.claimId;
    band.append(metadata);
    duplicate.remove();
  }
  function mount(host, study, discuss) {
    host.dataset.bookId = study.book_id;
    root = host.shadowRoot || host.attachShadow({ mode: "open" });
    root.replaceChildren();
    const stylesReady = [];
    for (const href of ["/book-assets/styles.css", "/assets/book-study.css"]) {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      const revision = window.HUB_ASSET_VERSIONS?.[href];
      css.href = (window.HUB_SITE_BASE || "") + href + (revision ? '?v=' + revision : '');
      stylesReady.push(new Promise(resolve => {
        css.addEventListener("load", resolve, { once: true });
        css.addEventListener("error", resolve, { once: true });
      }));
      root.append(css);
    }
    // Only the same-origin, typed server renderer supplies this inert fragment.
    const parsed = new DOMParser().parseFromString(study.html, "text/html");
    const content = document.createElement("div");
    content.className = "book-study-content";
    content.append(...parsed.body.childNodes);
    deduplicateTakeaway(content);
    studyPages = pageSections(study);
    root.append(content);
    for (const section of study.sections) {
      const element = root.getElementById(section.id);
      if (!element || section.id === "sources" || section.id.startsWith("book-section-")) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "book-discuss";
      button.textContent = "讨论本节";
      button.setAttribute("aria-label", `讨论：${section.title}`);
      button.addEventListener("click", () => discuss(section));
      element.append(button);
    }
    content.addEventListener("click", event => {
      const anchor = event.target.closest('a[href^="#"]');
      if (!anchor) return;
      if (jump(anchor.hash.slice(1))) event.preventDefault();
    });
    setPage('lecture', 'initial');
    return Promise.all(stylesReady);
  }
  function jump(id) {
    const element = root?.getElementById(id);
    if (!element) return false;
    reveal(element);
    element.tabIndex = -1;
    if (document.documentElement.dataset.input === 'keyboard') element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "start" });
    return true;
  }
  return Object.freeze({ mount, jump, setPage, reveal, pageSections });
})();
