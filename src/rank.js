/**
 * Lecture de la page « Indicateur de rang ».
 *
 * La page affiche une jauge dont le texte central est du type :
 *   « Plus de 200 enfants de la même tranche d'âge se trouvent devant Timothé »
 * Les autres libellés (« 101 à 200 enfants », « 51 à 100 enfants », …) sont les
 * étiquettes de la jauge : on ne peut donc pas se contenter de chercher un
 * intervalle, il faut celui qui précède « de la même tranche d'âge ».
 */
globalThis.__RQ_GARDERIES = globalThis.__RQ_GARDERIES || {};

(() => {
  const RQ = globalThis.__RQ_GARDERIES;

  // Du meilleur (peu d'enfants devant) au pire.
  const BUCKETS = [
    { test: /^0\s*(?:a|à|to)\s*10\b/i, label: '0–10', level: 1 },
    { test: /^11\s*(?:a|à|to)\s*50\b/i, label: '11–50', level: 2 },
    { test: /^51\s*(?:a|à|to)\s*100\b/i, label: '51–100', level: 3 },
    { test: /^101\s*(?:a|à|to)\s*200\b/i, label: '101–200', level: 4 },
    { test: /^(?:plus de|more than)\s*200\b/i, label: '200+', level: 5 },
  ];

  // « Plus de 200 enfants de la même tranche d'âge », « 0 à 10 enfant(s) … »
  const FR_RANG =
    /((?:plus de\s*)?\d+(?:\s*à\s*\d+)?)\s*enfants?\s*(?:\(s\))?\s*(?:de la m[êe]me tranche d['’]?[âa]ge)/i;
  // Version anglaise du portail.
  const EN_RANG =
    /((?:more than\s*)?\d+(?:\s*to\s*\d+)?)\s*child(?:ren)?\s*(?:\(s\))?\s*(?:in the same age group|of the same age group)/i;

  const PROJECTION = /projection (?:pour le|for)\s*:?\s*([0-9]{1,2}(?:er)?\s+[^0-9]{3,15}\s*[0-9]{4}|[0-9]{4}-[0-9]{2}-[0-9]{2})/i;
  const TRANCHE = /tranche d['’]?[âa]ge[^:]{0,60}:\s*([0-9]{1,3}\s*-\s*[0-9]{1,3}\s*(?:mois|ans)|[^.⟂]{1,25}?(?:mois|ans))/i;
  const TRANCHE_EN = /age group[^:]{0,60}:\s*([^.⟂]{1,25}?(?:months?|years?))/i;

  // La page est chargée (le squelette Lightning a fini de rendre) dès que ce
  // titre apparaît.
  const TITRE = /indicateur de rang|ranking indicator/i;

  // Cas où le portail ne peut pas produire de rang.
  const AUCUN_RANG =
    /(indicateur (?:de rang )?n['’]est pas disponible|aucun indicateur|non disponible pour cette demande|not available)/i;

  function bucketFor(intervalle) {
    const s = intervalle.replace(/\s+/g, ' ').trim();
    for (const b of BUCKETS) if (b.test.test(s)) return b;
    return { label: s, level: 0 };
  }

  /**
   * @returns {null}            page pas encore prête
   * @returns {{status:'ok'|'aucun'|'inconnu', ...}} résultat lisible
   */
  function parseRankDocument(doc, { pageChargeeDepuis = 0 } = {}) {
    const texte = RQ.docText(doc);
    if (!texte) return null;

    const m = texte.match(FR_RANG) || texte.match(EN_RANG);
    if (m) {
      const bucket = bucketFor(m[1]);
      const projection = (texte.match(PROJECTION) || [])[1] || null;
      const tranche = (texte.match(TRANCHE) || texte.match(TRANCHE_EN) || [])[1] || null;
      return {
        status: 'ok',
        label: bucket.label,
        level: bucket.level,
        brut: m[0].replace(/\s+/g, ' ').trim(),
        projection: projection ? projection.trim() : null,
        tranche: tranche ? tranche.trim() : null,
      };
    }

    if (AUCUN_RANG.test(texte)) {
      return { status: 'aucun', label: 'n/d', level: 0, brut: 'Indicateur non disponible' };
    }

    // Le titre est là mais pas la jauge : on laisse encore un peu de temps au
    // rendu avant d'abandonner.
    if (TITRE.test(texte) && pageChargeeDepuis > 8000) {
      return { status: 'inconnu', label: '?', level: 0, brut: texte.slice(0, 300) };
    }

    return null;
  }

  Object.assign(RQ, { parseRankDocument, BUCKETS });
})();
