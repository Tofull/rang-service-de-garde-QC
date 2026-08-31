/**
 * Content script isolé — passe-plat entre la page et l'extension.
 *
 * Toute la logique vit dans src/page.js, qui s'exécute dans le contexte de la
 * page (seul endroit d'où le shadow DOM de LWC est visible). Ce contexte n'a pas
 * accès aux API `chrome.*` : ce script lui fournit le stockage, et relaie les
 * commandes de la popup.
 *
 * Les charges utiles transitent en JSON — les objets réactifs de LWC ne
 * survivent pas au clonage structuré de postMessage.
 */
(() => {
  const CLE_CACHE = 'rq_cache';
  const CLE_REGLAGES = 'rq_reglages';
  const REGLAGES_DEFAUT = { autoRun: true, maxAgeHeures: 12, concurrence: 3 };

  // --- Stockage demandé par la page -----------------------------------------

  async function traiterDemande(action, charge) {
    switch (action) {
      case 'lireCache':
        return (await chrome.storage.local.get(CLE_CACHE))[CLE_CACHE] || {};
      case 'ecrireCache':
        await chrome.storage.local.set({ [CLE_CACHE]: charge || {} });
        return true;
      case 'viderCache':
        await chrome.storage.local.remove(CLE_CACHE);
        return true;
      case 'lireReglages':
        return { ...REGLAGES_DEFAUT, ...((await chrome.storage.local.get(CLE_REGLAGES))[CLE_REGLAGES] || {}) };
      default:
        throw new Error(`Action inconnue : ${action}`);
    }
  }

  window.addEventListener('message', async (e) => {
    const m = e.data;
    if (e.source !== window || !m || m.canal !== 'rq-req') return;

    let resultat = null;
    let erreur = null;
    try {
      resultat = await traiterDemande(m.action, JSON.parse(m.chargeJson ?? 'null'));
    } catch (err) {
      erreur = String(err && err.message ? err.message : err);
    }
    window.postMessage(
      { canal: 'rq-res', id: m.id, resultatJson: JSON.stringify(resultat), erreur },
      location.origin
    );
  });

  // --- Commandes de la popup vers la page -----------------------------------

  let compteur = 0;

  function envoyerCommande(action) {
    return new Promise((resoudre) => {
      const id = `cmd${++compteur}`;
      const surMessage = (e) => {
        const m = e.data;
        if (e.source !== window || !m || m.canal !== 'rq-cmd-res' || m.id !== id) return;
        window.removeEventListener('message', surMessage);
        clearTimeout(minuteur);
        resoudre(JSON.parse(m.resultatJson));
      };
      const minuteur = setTimeout(() => {
        window.removeEventListener('message', surMessage);
        resoudre({ ok: false, erreur: "La page n'a pas répondu. Recharge-la, puis réessaie." });
      }, 300000);
      window.addEventListener('message', surMessage);
      window.postMessage({ canal: 'rq-cmd', id, action }, location.origin);
    });
  }

  chrome.runtime.onMessage.addListener((msg, _expediteur, repondre) => {
    if (!msg || !msg.action) return false;
    if (msg.action === 'vider-cache') {
      // Le vidage touche au stockage (ici) et à l'affichage (dans la page).
      chrome.storage.local.remove(CLE_CACHE).then(() => envoyerCommande('vider-cache')).then(repondre);
      return true;
    }
    envoyerCommande(msg.action).then(repondre);
    return true;
  });
})();
