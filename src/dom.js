/**
 * Utilitaires DOM partagés.
 *
 * Le portail est une application Salesforce Lightning (LWR). Selon la
 * configuration, les composants utilisent le « synthetic shadow » (tout est en
 * light DOM) ou le shadow DOM natif. Les helpers ci-dessous traversent les deux.
 */
globalThis.__RQ_GARDERIES = globalThis.__RQ_GARDERIES || {};

(() => {
  const RQ = globalThis.__RQ_GARDERIES;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Toutes les racines (document + shadowRoots imbriqués) sous `root`.
   *
   * Le dédoublonnage est indispensable : avec le shadow synthétique de LWC, le
   * contenu des composants reste dans le light DOM, si bien qu'un même hôte est
   * découvert depuis plusieurs racines — sans quoi chaque élément ressort en
   * plusieurs exemplaires.
   */
  function allRoots(root) {
    const roots = [root];
    const vus = new Set(roots);
    for (let i = 0; i < roots.length; i++) {
      let els;
      try {
        els = roots[i].querySelectorAll('*');
      } catch {
        continue;
      }
      for (const el of els) {
        const racine = el.shadowRoot;
        if (racine && !vus.has(racine)) {
          vus.add(racine);
          roots.push(racine);
        }
      }
    }
    return roots;
  }

  function deepQueryAll(root, selector) {
    const out = new Set();
    for (const r of allRoots(root)) {
      try {
        for (const el of r.querySelectorAll(selector)) out.add(el);
      } catch {
        /* sélecteur invalide dans cette racine */
      }
    }
    return [...out];
  }

  function deepQuery(root, selector) {
    for (const r of allRoots(root)) {
      const el = r.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  /**
   * Texte de l'arbre composé, dans l'ordre du document, shadow roots inclus.
   * `innerText` seul ne traverse pas les shadow roots ; on l'essaie d'abord
   * parce qu'il respecte mieux les sauts de ligne, puis on complète.
   */
  function composedText(node) {
    let out = '';
    const walk = (n) => {
      if (!n) return;
      if (n.nodeType === Node.TEXT_NODE) {
        out += n.nodeValue;
        return;
      }
      if (n.nodeType !== Node.ELEMENT_NODE && n.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
      if (n.nodeType === Node.ELEMENT_NODE) {
        const tag = n.nodeName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'noscript') return;
        if (n.shadowRoot) walk(n.shadowRoot);
      }
      for (const child of n.childNodes) walk(child);
      if (n.nodeType === Node.ELEMENT_NODE) out += ' ';
    };
    walk(node);
    return out.replace(/\s+/g, ' ').trim();
  }

  /** Texte complet d'un document, normalisé (espaces simples). */
  function docText(doc) {
    if (!doc || !doc.body) return '';
    const plain = (doc.body.innerText || '').replace(/\s+/g, ' ').trim();
    const composed = composedText(doc.body);
    // On concatène : le texte des shadow roots n'apparaît pas dans innerText,
    // et l'inverse (contenu « slotté ») peut manquer dans composedText.
    return plain.length >= composed.length ? plain + ' ⟂ ' + composed : composed + ' ⟂ ' + plain;
  }

  const norm = (s) =>
    (s || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

  /** Répète `fn` jusqu'à ce qu'elle retourne une valeur truthy, ou expire. */
  async function waitFor(fn, { timeout = 30000, interval = 300, label = 'condition' } = {}) {
    const start = Date.now();
    for (;;) {
      let value;
      try {
        value = await fn();
      } catch {
        value = null;
      }
      if (value) return value;
      if (Date.now() - start > timeout) throw new Error(`Délai dépassé (${label})`);
      await sleep(interval);
    }
  }

  Object.assign(RQ, { sleep, allRoots, deepQuery, deepQueryAll, composedText, docText, norm, waitFor });
})();
