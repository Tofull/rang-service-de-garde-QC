const CLE_REGLAGES = 'rq_reglages';
const DEFAUT = { autoRun: true, maxAgeHeures: 12, concurrence: 3 };

const champs = {
  autoRun: document.getElementById('autoRun'),
  maxAgeHeures: document.getElementById('maxAgeHeures'),
  concurrence: document.getElementById('concurrence'),
};
const etat = document.getElementById('etat');
const boutonActualiser = document.getElementById('actualiser');
const boutonVider = document.getElementById('viderCache');

function afficher(texte, erreur = false) {
  etat.textContent = texte;
  etat.setAttribute('data-erreur', erreur ? '1' : '0');
}

async function ongletPortail() {
  const [onglet] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!onglet || !/^https:\/\/(www\.)?portail-servicesgarde\.gouv\.qc\.ca\//.test(onglet.url || '')) {
    return null;
  }
  return onglet;
}

/** Envoie un message au content script ; renvoie null s'il n'est pas là. */
async function envoyer(action) {
  const onglet = await ongletPortail();
  if (!onglet) {
    afficher('Ouvre d’abord « Mes demandes d’admission » sur le portail.', true);
    return null;
  }
  try {
    return await chrome.tabs.sendMessage(onglet.id, { action });
  } catch {
    afficher("La page n'a pas répondu. Recharge-la, puis réessaie.", true);
    return null;
  }
}

async function chargerReglages() {
  const stockage = await chrome.storage.local.get(CLE_REGLAGES);
  const reglages = { ...DEFAUT, ...(stockage[CLE_REGLAGES] || {}) };
  champs.autoRun.checked = reglages.autoRun;
  champs.maxAgeHeures.value = reglages.maxAgeHeures;
  champs.concurrence.value = reglages.concurrence;
}

async function sauverReglages() {
  const reglages = {
    autoRun: champs.autoRun.checked,
    maxAgeHeures: Math.max(0, Math.min(720, Number(champs.maxAgeHeures.value) || DEFAUT.maxAgeHeures)),
    concurrence: Math.max(1, Math.min(6, Number(champs.concurrence.value) || DEFAUT.concurrence)),
  };
  await chrome.storage.local.set({ [CLE_REGLAGES]: reglages });
}

for (const champ of Object.values(champs)) champ.addEventListener('change', sauverReglages);

boutonActualiser.addEventListener('click', async () => {
  await sauverReglages();
  boutonActualiser.disabled = true;
  afficher('Lecture des pages de rang en cours…');
  const reponse = await envoyer('actualiser');
  boutonActualiser.disabled = false;
  if (!reponse) return;
  if (!reponse.ok) afficher(reponse.erreur || 'Échec.', true);
  else if (reponse.echecs) afficher(`${reponse.lus} rang(s) relevé(s), ${reponse.echecs} en échec.`, true);
  else afficher(`${reponse.lus} rang(s) relevé(s) sur ${reponse.total} demande(s).`);
});

boutonVider.addEventListener('click', async () => {
  const reponse = await envoyer('vider-cache');
  if (reponse) afficher('Cache vidé.');
});

(async () => {
  await chargerReglages();
  const onglet = await ongletPortail();
  if (!onglet) {
    afficher('Ouvre « Mes demandes d’admission » sur le portail pour utiliser l’extension.');
    return;
  }
  try {
    const reponse = await chrome.tabs.sendMessage(onglet.id, { action: 'etat' });
    if (reponse?.tableauTrouve) afficher(reponse.messageEtat || 'Tableau détecté.');
    else afficher("Tableau des demandes non détecté sur cette page.");
  } catch {
    afficher('Recharge la page du portail pour activer l’extension.');
  }
})();
