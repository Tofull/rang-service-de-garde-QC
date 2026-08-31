/**
 * Logique principale — s'exécute dans le contexte JS de la page (world: MAIN).
 *
 * Pourquoi ici plutôt que dans un content script isolé : le portail est une
 * application LWC qui remplace `Element.prototype.attachShadow` et le getter
 * `shadowRoot`. Depuis un monde isolé, `host.shadowRoot` vaut `null` — le
 * tableau, entièrement rendu dans ce shadow DOM, est donc invisible et rien ne
 * peut y être injecté. Dans le contexte de la page, les accesseurs de LWC sont
 * en place et tout redevient lisible, y compris la propriété `listeDonnees` du
 * composant, qui porte l'identifiant de chaque demande.
 *
 * Ce script ne peut pas utiliser `chrome.storage` : il délègue le cache et les
 * réglages au content script isolé (content.js) par `postMessage`.
 *
 * Fonctionnement :
 *  1. lire les demandes (et leur identifiant) dans <c-gu-tableau-donnees-sub-cmp> ;
 *  2. charger /parent/s/indicateur-de-rang?id=<identifiant> dans une iframe
 *     cachée (même origine, ~1 s) et y lire le texte de la jauge ;
 *  3. écrire le résultat dans une colonne ajoutée au tableau, et le mettre en cache.
 *
 * Aucune donnée ne sort du navigateur ; aucune requête vers un tiers.
 */
(() => {
  const RQ = globalThis.__RQ_GARDERIES;
  const { deepQueryAll, waitFor, norm } = RQ;

  const TAG_TABLEAU = 'c-gu-tableau-donnees-sub-cmp';
  const REGLAGES_DEFAUT = { autoRun: true, maxAgeHeures: 12, concurrence: 3 };
  const ENTETE = 'Indicateur de rang';

  const STYLES = `
    .rq-barre { display:flex; align-items:center; gap:12px; flex-wrap:wrap;
      margin:4px 0 12px; font-family:inherit; font-size:14px; }
    .rq-btn { border:1px solid #095797; background:#fff; color:#095797;
      border-radius:4px; padding:5px 12px; font:inherit; font-weight:600; cursor:pointer; }
    .rq-btn:hover:not(:disabled) { background:#095797; color:#fff; }
    .rq-btn:disabled { opacity:.5; cursor:default; }
    .rq-etat { color:#555; }
    .rq-etat[data-erreur="1"] { color:#b3261e; font-weight:600; }
    .rq-badge { display:inline-block; min-width:68px; text-align:center;
      padding:3px 10px; border-radius:12px; font-weight:700; font-size:14px;
      color:#fff; background:#9e9e9e; text-decoration:none; line-height:1.5;
      border:1px solid transparent; }
    a.rq-badge:hover { filter:brightness(1.1); text-decoration:none; }
    /* Couleurs des arcs de la jauge officielle : plus c'est foncé, plus il y a
       d'enfants devant. Le jaune-vert du graphe ne sert qu'à marquer « vous êtes
       ici » — sans objet dans une colonne où chaque ligne est déjà à sa place. */
    .rq-n1 { background:#cae2f2; color:#223654; border-color:#a8cde8; }
    .rq-n2 { background:#4a98d9; color:#223654; }
    .rq-n3 { background:#1472bf; }
    .rq-n4 { background:#095797; }
    .rq-n5 { background:#063665; }
    .rq-n0 { background:#9e9e9e; }
    .rq-vide { color:#777; }
    th[data-rq] { cursor:pointer; user-select:none; white-space:nowrap; }
    th[data-rq]:focus-visible { outline:2px solid #095797; outline-offset:-2px; }
    .rq-fleche { font-size:12px; opacity:.35; }
    .rq-fleche[data-actif="1"] { opacity:1; color:#095797; }
  `;

  /** Résultats de la session courante, indexés par identifiant de demande. */
  const resultats = new Map();
  let reglages = { ...REGLAGES_DEFAUT };
  let hoteTableau = null;
  let enCours = false;
  let messageEtat = '';
  let messageErreur = false;
  let autoRunFait = false;

  const log = (...a) => console.debug('[rang-garderies]', ...a);

  // ------------------------------------------- stockage (via content.js)

  let compteur = 0;

  /** Demande une opération de stockage au content script isolé. */
  function demanderStockage(action, charge) {
    return new Promise((resoudre, rejeter) => {
      const id = `rq${++compteur}`;
      const surMessage = (e) => {
        const m = e.data;
        if (e.source !== window || !m || m.canal !== 'rq-res' || m.id !== id) return;
        window.removeEventListener('message', surMessage);
        clearTimeout(minuteur);
        if (m.erreur) rejeter(new Error(m.erreur));
        else resoudre(JSON.parse(m.resultatJson));
      };
      const minuteur = setTimeout(() => {
        window.removeEventListener('message', surMessage);
        rejeter(new Error("L'extension n'a pas répondu (recharge la page)."));
      }, 6000);
      window.addEventListener('message', surMessage);
      // Les charges utiles transitent en JSON : les objets réactifs de LWC ne
      // survivent pas au clonage structuré de postMessage.
      window.postMessage(
        { canal: 'rq-req', id, action, chargeJson: JSON.stringify(charge ?? null) },
        location.origin
      );
    });
  }

  async function chargerReglages() {
    try {
      reglages = { ...REGLAGES_DEFAUT, ...((await demanderStockage('lireReglages')) || {}) };
    } catch {
      reglages = { ...REGLAGES_DEFAUT };
    }
    return reglages;
  }

  const lireCache = async () => {
    try {
      return (await demanderStockage('lireCache')) || {};
    } catch {
      return {};
    }
  };

  const ecrireCache = async (cache) => {
    try {
      await demanderStockage('ecrireCache', cache);
    } catch (e) {
      log('cache non enregistré', e);
    }
  };

  const estFrais = (entree) =>
    !!entree && entree.status === 'ok' && Date.now() - (entree.ts || 0) < reglages.maxAgeHeures * 3600e3;

  // ------------------------------------------------------------------- DOM

  /** Le composant tableau, avec son shadow root et son <table> rendu. */
  function trouverTableau() {
    if (hoteTableau && hoteTableau.isConnected && hoteTableau.shadowRoot?.querySelector('tbody tr')) {
      return hoteTableau;
    }
    hoteTableau = null;
    for (const hote of deepQueryAll(document, TAG_TABLEAU)) {
      if (hote.shadowRoot?.querySelector('tbody tr')) {
        hoteTableau = hote;
        break;
      }
    }
    return hoteTableau;
  }

  /** Les demandes affichées, à plat (les objets de LWC sont des proxies). */
  function lireLignesDuComposant(hote) {
    const liste = hote?.listeDonnees;
    if (!Array.isArray(liste)) return [];
    return liste.map((d) => ({
      identifiant: d.identifiant ?? null,
      nomInstallation: d.nomInstallation ?? null,
      nomEnfant: d.nomEnfant ?? null,
      typeInstallation: d.typeInstallation ?? null,
      dateDemande: d.dateDemande ?? null,
      statut: d.statutLabel ?? d.statut ?? null,
    }));
  }

  function injecterStyles(racine) {
    if (racine.querySelector('style[data-rq-styles]')) return;
    const style = document.createElement('style');
    style.setAttribute('data-rq-styles', '1');
    style.textContent = STYLES;
    racine.appendChild(style);
  }

  /** Index des colonnes du tableau d'origine, repérées par leur libellé. */
  function indexColonnes(table) {
    const ths = [...table.querySelectorAll('thead th')].filter((th) => !th.hasAttribute('data-rq'));
    const cherche = (re) => ths.findIndex((th) => re.test(th.textContent || ''));
    return {
      ths,
      installation: cherche(/service de garde|childcare|facility/i),
      enfant: cherche(/enfant|child/i),
      // La dernière colonne (menu « ⌄ ») n'a pas de libellé : on s'insère avant.
      insertion: (ths[ths.length - 1]?.textContent || '').trim() === '' ? ths.length - 1 : ths.length,
    };
  }

  const cleLigne = (installation, enfant) => `${norm(installation)}|${norm(enfant)}`;

  /**
   * Associe chaque <tr> affiché à l'identifiant de sa demande.
   * Le tableau est triable : l'ordre du DOM ne suit pas forcément celui des
   * données, on apparie donc par (installation, enfant) plutôt que par index.
   */
  function apparier(table, lignesDonnees) {
    const cols = indexColonnes(table);
    const restants = new Map();
    for (const d of lignesDonnees) {
      const cle = cleLigne(d.nomInstallation, d.nomEnfant);
      if (!restants.has(cle)) restants.set(cle, []);
      restants.get(cle).push(d);
    }

    const paires = [];
    for (const tr of table.querySelectorAll('tbody tr')) {
      const tds = [...tr.children].filter((n) => n.tagName === 'TD' && !n.hasAttribute('data-rq'));
      const installation = tds[cols.installation]?.textContent || '';
      const enfant = tds[cols.enfant]?.textContent || '';
      const file = restants.get(cleLigne(installation, enfant));
      paires.push({ tr, donnee: file && file.length ? file.shift() : null });
    }
    return { paires, cols };
  }

  // ------------------------------------------------------------ rendu de l'UI

  function assurerColonne(table, cols) {
    const enteteLigne = table.querySelector('thead tr');
    if (enteteLigne && !enteteLigne.querySelector('th[data-rq]')) {
      const th = document.createElement('th');
      th.setAttribute('data-rq', '1');
      const modele = cols.ths[0];
      if (modele) {
        th.className = (modele.className || '').replace(/\btri\b/g, '').replace(/premier-colonne/g, '').trim();
      }
      th.setAttribute('scope', 'col');
      th.title = 'Trier par indicateur de rang';
      th.tabIndex = 0;
      const libelle = document.createElement('span');
      libelle.textContent = ENTETE;
      const fleche = document.createElement('span');
      fleche.className = 'rq-fleche';
      th.append(libelle, ' ', fleche);
      // Le clic ne doit pas remonter jusqu'au tri natif du composant.
      const basculer = (e) => {
        e.preventDefault();
        e.stopPropagation();
        triRang = triRang === 1 ? -1 : triRang === -1 ? 0 : 1;
        rendre();
      };
      th.addEventListener('click', basculer);
      th.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') basculer(e);
      });
      enteteLigne.insertBefore(th, enteteLigne.children[cols.insertion] || null);
    }
    for (const tr of table.querySelectorAll('tbody tr')) {
      if (tr.querySelector('td[data-rq]')) continue;
      const td = document.createElement('td');
      td.setAttribute('data-rq', '1');
      const modele = [...tr.children].find((n) => n.tagName === 'TD');
      if (modele) td.className = (modele.className || '').replace(/\baction\b/g, '').trim();
      td.append(badge(null, null));
      tr.insertBefore(td, tr.children[cols.insertion] || null);
    }
  }

  function badge(resultat, identifiant) {
    if (!resultat || resultat.status === 'chargement') {
      const span = document.createElement('span');
      span.className = 'rq-vide';
      span.textContent = resultat ? '…' : '—';
      if (!resultat) span.title = 'Rang pas encore lu.';
      return span;
    }

    const libelles = { ok: resultat.label, aucun: 'n/d', inconnu: '?', erreur: '⚠' };
    const el = document.createElement(identifiant ? 'a' : 'span');
    el.className = `rq-badge rq-n${resultat.status === 'ok' ? resultat.level : 0}`;
    el.textContent = libelles[resultat.status] ?? '?';
    if (identifiant) {
      el.href = `${location.origin}/parent/s/indicateur-de-rang?id=${encodeURIComponent(identifiant)}&modeList=true`;
      el.target = '_blank';
      el.rel = 'noopener';
    }

    const lignes = [];
    if (resultat.status === 'ok') {
      lignes.push(resultat.brut);
      if (resultat.projection) lignes.push(`Projection pour le ${resultat.projection}`);
      if (resultat.tranche) lignes.push(`Tranche d'âge : ${resultat.tranche}`);
    } else if (resultat.status === 'aucun') {
      lignes.push('Indicateur de rang non disponible pour cette demande.');
    } else if (resultat.status === 'erreur') {
      lignes.push(`Échec de la lecture : ${resultat.message || 'erreur inconnue'}`);
    } else {
      lignes.push("La page de rang s'est chargée mais la jauge n'a pas pu être lue.");
    }
    if (resultat.ts) lignes.push(`Relevé le ${new Date(resultat.ts).toLocaleString('fr-CA')}`);
    el.title = lignes.join('\n');
    return el;
  }

  function assurerBarre(racine, table) {
    const ancre = racine.querySelector('.nbr-elements') || table.parentElement;
    let barre = racine.querySelector('.rq-barre');
    if (!barre) {
      barre = document.createElement('div');
      barre.className = 'rq-barre';
      const bouton = document.createElement('button');
      bouton.type = 'button';
      bouton.className = 'rq-btn';
      bouton.addEventListener('click', () => lancer({ force: true }));
      const etat = document.createElement('span');
      etat.className = 'rq-etat';
      barre.append(bouton, etat);
      ancre.insertAdjacentElement('afterend', barre);
    }
    // N'écrire que ce qui change : chaque écriture déclenche le MutationObserver,
    // qui redemande un rendu — réécrire à l'identique boucle indéfiniment.
    const bouton = barre.querySelector('.rq-btn');
    const etat = barre.querySelector('.rq-etat');
    const libelle = enCours ? 'Lecture en cours…' : 'Actualiser les rangs';
    const drapeau = messageErreur ? '1' : '0';
    if (bouton.disabled !== enCours) bouton.disabled = enCours;
    if (bouton.textContent !== libelle) bouton.textContent = libelle;
    if (etat.textContent !== messageEtat) etat.textContent = messageEtat;
    if (etat.getAttribute('data-erreur') !== drapeau) etat.setAttribute('data-erreur', drapeau);
  }

  // ----------------------------------------------------------- tri par rang

  /** 0 = ordre du portail, 1 = meilleurs rangs d'abord, -1 = l'inverse. */
  let triRang = 0;
  /** Ordre écrit lors du dernier tri : ce qui s'en écarte vient du portail. */
  let ordreApplique = [];
  /** Ordre du portail : base des ex æquo, et retour en arrière quand on éteint. */
  let baseTri = new Map();

  const memeSequence = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

  /** Poids de tri : 1 à 5 = tranches de la jauge, au-delà = rang non lisible. */
  function poidsTri(resultat) {
    if (resultat && resultat.status === 'ok' && resultat.level > 0) return resultat.level;
    if (!resultat || resultat.status === 'chargement') return 103;
    if (resultat.status === 'aucun') return 100;
    if (resultat.status === 'erreur') return 102;
    return 101;
  }

  function ecrireOrdre(tbody, actuel, voulu) {
    if (memeSequence(actuel, voulu)) return;
    // Un fragment déplace toutes les lignes en une seule mutation.
    const fragment = document.createDocumentFragment();
    for (const tr of voulu) fragment.appendChild(tr);
    tbody.appendChild(fragment);
  }

  function majEnteteTri(table) {
    const th = table.querySelector('thead th[data-rq]');
    const fleche = th?.querySelector('.rq-fleche');
    if (!th || !fleche) return;
    const signe = triRang === 1 ? '▲' : triRang === -1 ? '▼' : '⇅';
    const actif = triRang ? '1' : '0';
    const aria = triRang === 1 ? 'ascending' : triRang === -1 ? 'descending' : 'none';
    if (fleche.textContent !== signe) fleche.textContent = signe;
    if (fleche.getAttribute('data-actif') !== actif) fleche.setAttribute('data-actif', actif);
    if (th.getAttribute('aria-sort') !== aria) th.setAttribute('aria-sort', aria);
  }

  /**
   * Réordonne les <tr> selon le rang relevé.
   *
   * Le tri natif du portail ne connaît que ses propres colonnes : il réordonne
   * `listeDonnees` puis re-rend. On ne peut donc que déplacer les lignes après
   * coup, et le refaire à chaque rendu — les rangs arrivent au fil de l'eau.
   */
  function appliquerTri(table, paires) {
    const tbody = table.querySelector('tbody');
    if (!tbody) return;
    const trs = [...tbody.rows];

    if (!triRang) {
      if (baseTri.size && trs.every((tr) => baseTri.has(tr))) {
        ecrireOrdre(tbody, trs, trs.slice().sort((a, b) => baseTri.get(a) - baseTri.get(b)));
      }
      baseTri = new Map();
      ordreApplique = [];
      return;
    }

    // Un ordre qui n'est pas celui qu'on a écrit vient du portail (tri natif,
    // pagination, re-rendu) : il redevient la référence.
    if (!memeSequence(trs, ordreApplique)) baseTri = new Map(trs.map((tr, i) => [tr, i]));

    const poids = new Map();
    for (const { tr, donnee } of paires) {
      poids.set(tr, poidsTri(donnee?.identifiant ? resultats.get(donnee.identifiant) : null));
    }
    const base = (tr) => (baseTri.has(tr) ? baseTri.get(tr) : Number.MAX_SAFE_INTEGER);

    const voulu = trs.slice().sort((a, b) => {
      const pa = poids.get(a) ?? 103;
      const pb = poids.get(b) ?? 103;
      // n/d, ⚠, ? et « pas encore lu » restent en bas dans les deux sens.
      const inconnuA = pa > 5;
      const inconnuB = pb > 5;
      if (inconnuA !== inconnuB) return inconnuA ? 1 : -1;
      if (pa !== pb) return inconnuA ? pa - pb : (pa - pb) * triRang;
      return base(a) - base(b);
    });

    ecrireOrdre(tbody, trs, voulu);
    ordreApplique = voulu;
  }

  /** (Ré)applique toute notre UI ; sans effet si elle est déjà en place. */
  function rendre() {
    const hote = trouverTableau();
    if (!hote) return false;
    const racine = hote.shadowRoot;
    const table = racine.querySelector('table');
    if (!table) return false;

    injecterStyles(racine);
    const { paires, cols } = apparier(table, lireLignesDuComposant(hote));
    assurerColonne(table, cols);
    assurerBarre(racine, table);

    for (const { tr, donnee } of paires) {
      const td = tr.querySelector('td[data-rq]');
      if (!td) continue;
      const id = donnee ? donnee.identifiant : null;
      const resultat = id ? resultats.get(id) : null;
      const empreinte = `${id || '?'}|${resultat ? resultat.status : 'vide'}|${
        resultat ? resultat.label || '' : ''
      }|${resultat ? resultat.ts || '' : ''}`;
      if (td.dataset.rqRendu === empreinte) continue;
      td.dataset.rqRendu = empreinte;
      td.textContent = '';
      td.append(badge(resultat, id));
    }

    majEnteteTri(table);
    appliquerTri(table, paires);

    return true;
  }

  // --------------------------------------------------------- lecture du rang

  function creerFrame() {
    const frame = document.createElement('iframe');
    // Hors écran plutôt que display:none : la page doit être rendue pour que
    // son texte soit lisible.
    frame.style.cssText =
      'position:fixed;left:-10000px;top:0;width:1280px;height:900px;opacity:0;border:0;pointer-events:none;';
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('tabindex', '-1');
    document.documentElement.appendChild(frame);
    return frame;
  }

  function naviguer(frame, url) {
    return new Promise((resoudre, rejeter) => {
      const ok = () => {
        clearTimeout(minuteur);
        resoudre();
      };
      const minuteur = setTimeout(() => {
        frame.removeEventListener('load', ok);
        rejeter(new Error('Délai dépassé au chargement de la page de rang.'));
      }, 45000);
      frame.addEventListener('load', ok, { once: true });
      frame.src = url;
    });
  }

  async function lireRang(frame, identifiant) {
    const url = `${location.origin}/parent/s/indicateur-de-rang?id=${encodeURIComponent(
      identifiant
    )}&modeList=true`;
    await naviguer(frame, url);
    const depart = Date.now();
    return await waitFor(
      () => {
        const doc = frame.contentDocument;
        if (!doc) return null;
        return RQ.parseRankDocument(doc, { pageChargeeDepuis: Date.now() - depart });
      },
      { timeout: 45000, interval: 250, label: 'lecture de la jauge' }
    );
  }

  /** Traite `taches` avec un petit nombre d'iframes en parallèle. */
  async function traiterEnParallele(taches, concurrence, travail) {
    let curseur = 0;
    const nbOuvriers = Math.max(1, Math.min(concurrence, taches.length));
    const ouvriers = Array.from({ length: nbOuvriers }, async () => {
      const frame = creerFrame();
      try {
        for (;;) {
          const i = curseur++;
          if (i >= taches.length) return;
          await travail(taches[i], frame);
        }
      } finally {
        frame.remove();
      }
    });
    await Promise.all(ouvriers);
  }

  // --------------------------------------------------------------- exécution

  async function lancer({ force = false } = {}) {
    if (enCours) return { ok: false, erreur: 'Une lecture est déjà en cours.' };
    const hote = trouverTableau();
    if (!hote) return { ok: false, erreur: 'Tableau des demandes introuvable sur cette page.' };

    enCours = true;
    messageErreur = false;
    messageEtat = 'Préparation…';
    rendre();

    try {
      await chargerReglages();
      const lignes = lireLignesDuComposant(hote).filter((l) => l.identifiant);
      if (lignes.length === 0) throw new Error('Aucune demande lisible dans le tableau.');
      const cache = await lireCache();

      // Ce qui est déjà connu s'affiche tout de suite.
      for (const l of lignes) {
        const entree = cache[l.identifiant];
        if (entree && entree.status === 'ok') resultats.set(l.identifiant, entree);
      }
      rendre();

      const aFaire = lignes.filter((l) => force || !estFrais(cache[l.identifiant]));
      if (aFaire.length === 0) {
        messageEtat = `À jour — ${lignes.length} demande(s).`;
        return { ok: true, total: lignes.length, lus: 0, echecs: 0 };
      }

      let faits = 0;
      messageEtat = `0 / ${aFaire.length}…`;
      rendre();

      await traiterEnParallele(aFaire, reglages.concurrence, async (ligne, frame) => {
        resultats.set(ligne.identifiant, { status: 'chargement' });
        rendre();
        let resultat;
        try {
          resultat = await lireRang(frame, ligne.identifiant);
        } catch (e) {
          resultat = { status: 'erreur', level: 0, message: String(e && e.message ? e.message : e) };
        }
        resultat.ts = Date.now();
        resultats.set(ligne.identifiant, resultat);
        cache[ligne.identifiant] = resultat;
        faits++;
        messageEtat = `${faits} / ${aFaire.length}…`;
        rendre();
      });

      await ecrireCache(cache);
      const echecs = aFaire.filter((l) => resultats.get(l.identifiant)?.status !== 'ok').length;
      messageErreur = echecs > 0;
      messageEtat = echecs
        ? `Terminé — ${aFaire.length - echecs} lu(s), ${echecs} en échec (survole le badge).`
        : `Terminé — ${aFaire.length} rang(s) relevé(s) à ${new Date().toLocaleTimeString('fr-CA')}.`;
      return { ok: true, total: lignes.length, lus: aFaire.length - echecs, echecs };
    } catch (e) {
      messageEtat = String(e && e.message ? e.message : e);
      messageErreur = true;
      log('échec', e);
      return { ok: false, erreur: messageEtat };
    } finally {
      enCours = false;
      rendre();
    }
  }

  // ------------------------------------------- commandes venues de la popup

  window.addEventListener('message', async (e) => {
    const m = e.data;
    if (e.source !== window || !m || m.canal !== 'rq-cmd') return;

    let resultat;
    if (m.action === 'actualiser') {
      resultat = await lancer({ force: true });
    } else if (m.action === 'vider-cache') {
      resultats.clear();
      messageEtat = 'Cache vidé.';
      messageErreur = false;
      for (const td of deepQueryAll(document, 'td[data-rq]')) delete td.dataset.rqRendu;
      rendre();
      resultat = { ok: true };
    } else if (m.action === 'etat') {
      resultat = { ok: true, tableauTrouve: !!trouverTableau(), enCours, messageEtat };
    } else {
      resultat = { ok: false, erreur: 'Commande inconnue.' };
    }
    window.postMessage(
      { canal: 'rq-cmd-res', id: m.id, resultatJson: JSON.stringify(resultat) },
      location.origin
    );
  });

  // -------------------------------------------------------------- démarrage

  let rendreEnAttente = false;
  function planifierRendu() {
    if (rendreEnAttente) return;
    rendreEnAttente = true;
    setTimeout(() => {
      rendreEnAttente = false;
      const present = rendre();
      if (present && reglages.autoRun && !autoRunFait && !enCours) {
        autoRunFait = true;
        lancer();
      }
    }, 250);
  }

  chargerReglages().then(() => {
    // Le portail est une SPA : le tableau apparaît puis se re-rend (tri,
    // pagination) sans rechargement de page.
    new MutationObserver(planifierRendu).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    setInterval(() => {
      if (hoteTableau && !hoteTableau.isConnected) autoRunFait = false;
      planifierRendu();
    }, 2000);
    planifierRendu();
  });
})();
