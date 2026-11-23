// Échange avec le petit programme Google (étape 5c) – conception multi-tablettes v3.2.
// - Les fiches sont d'abord enregistrées sur l'appareil, puis envoyées dès qu'il y a du réseau (D5, D63).
// - L'appareil reçoit tout ce que les autres ont envoyé (sans leurs signatures, P92).
// - Rien n'est silencieux (règle 18) : refus, attente, absence de réseau, Google occupé s'affichent.
"use strict";

const INTERVALLE_ECHANGE_MS = 2 * 60 * 1000;   // tant que l'application est ouverte
const NOUVEL_ESSAI_OCCUPE_MS = 60 * 1000;      // Google occupé par une autre tablette (P97)
const DELAI_REPONSE_MS = 120 * 1000;

// État de l'échange, affiché sur l'accueil
etat.echange = { enCours: false, derniere: null, erreur: null, refus: [], attente: 0, aEnvoyer: 0, heureDouteuse: false };

// ---------- Données reçues : personnes, salariés, référentiel (calculées à partir du journal, D18) ----------
function etatsActifs(journal, typeAjout, typeRetrait) {
  const parObjet = {};
  journal.slice().sort((a, b) => a.numero - b.numero).forEach((l) => {
    if (l.type === typeAjout) parObjet[l.objet] = l.contenu;
    if (l.type === typeRetrait) delete parObjet[l.objet];
  });
  return parObjet;
}

async function recalculerDonnees() {
  const journal = await lireTout("journal");
  const ref = await lire("reglages", "referentiel");
  etat.referentiel = ref ? ref.valeur : null;
  etat.points = etat.referentiel ? Object.fromEntries(etat.referentiel.points.map((p) => [p.code, p])) : {};
  etat.personnes = Object.values(etatsActifs(journal, "personne", "retrait-personne"));
  const effaces = new Set(journal.filter((l) => l.type === "effacement").map((l) => l.salarie));
  etat.codesEffaces = effaces;
  // Dossiers : reçus de Google + modifications de cet appareil pas encore envoyées (sauf refusées).
  // Un salarié AJOUTÉ n'apparaît qu'une fois accepté par Google (D159) : son envoi en cours n'est pas compté.
  // D157 : chaque modification ne contient que les informations changées ; pour une même information,
  // la plus récente (date de l'action) l'emporte (D154) ; à égalité, l'ordre d'arrivée.
  const envois = (await lireTout("envois")).filter((e) => e.ev.type === "salarie" && e.etat !== "refuse" && !e.ev.nouveau);
  const lignes = journal.filter((l) => l.type === "salarie" && l.contenu).map((l) => ({ date: l.date_action || "", rang: l.numero, salarie: l.salarie, contenu: l.contenu }))
    .concat(envois.map((e) => ({ date: e.ev.date_action, rang: Infinity, salarie: e.ev.salarie, contenu: e.ev.contenu })));
  lignes.sort((a, b) => a.date.localeCompare(b.date) || a.rang - b.rang);
  const salaries = {};
  for (const l of lignes) if (!effaces.has(l.salarie)) salaries[l.salarie] = fusionDossier(salaries[l.salarie], l.contenu);
  etat.salariesTous = Object.values(salaries).sort(comparerSalaries); // D258 : nom, puis prénom
  etat.salaries = etat.salariesTous.filter((s) => !s.sorti);
}

// D156 : une sortie n'est jamais perdue. Seul « Faire revenir » (qui envoie toujours date_retour) la lève ;
// une autre modification, même plus récente, ne l'annule pas.
function fusionDossier(avant, changements) {
  if (!avant) return { ...changements };
  const n = { ...avant, ...changements };
  if (avant.sorti && changements.sorti === false && !changements.date_retour) { n.sorti = true; n.date_sortie = avant.date_sortie; }
  return n;
}

// ---------- Enregistrer une fiche ET son envoi en une seule écriture ----------
async function enregistrerFicheEtEnvoi(fiche, evenement) {
  const db = await ouvrirBase();
  return new Promise((ok, ko) => {
    const tx = db.transaction(["fiches", "envois"], "readwrite");
    tx.objectStore("fiches").add(fiche);     // jamais écrasée (D16)
    tx.objectStore("envois").add({ id: evenement.id, etat: "a_envoyer", ev: evenement });
    tx.oncomplete = () => ok();
    tx.onerror = () => ko(tx.error);
    tx.onabort = () => ko(tx.error || new Error("écriture annulée"));
  });
}

// ---------- L'échange ----------
// Un seul échange à la fois. Un appel pendant un échange en cours attend la fin DE CET échange
// (il ne revient pas tout de suite) : celui qui attend voit le vrai résultat.
function synchroniser() {
  const ech = etat.echange;
  if (ech.enCours && ech.promesse) return ech.promesse;
  // La copie des documents est lancée APRÈS l'échange des fiches, à part : elle ne retarde ni les fiches,
  // ni l'installation, ni les échanges suivants (constat du Vérificateur sur c941234).
  ech.promesse = echanger().then(() => { if (ech.documentsAFaire) copierDocumentsEnArrierePlan(); });
  return ech.promesse;
}

function copierDocumentsEnArrierePlan() {
  const ech = etat.echange;
  const travail = ech.documentsAFaire;
  ech.documentsAFaire = null;
  if (ech.copieDocumentsEnCours) return;
  ech.copieDocumentsEnCours = true;
  telechargerDocuments(travail.docs, travail.connexion, travail.appareil)
    .catch((e) => { ech.erreurDocuments = "Copie des documents impossible : " + e.message; })
    .finally(async () => { ech.copieDocumentsEnCours = false; await compterEnvois(); majEtatEchange(); });
}

async function echanger() {
  const ech = etat.echange;
  ech.enCours = true; // posé AVANT toute attente : deux appels presque simultanés ne lancent jamais deux échanges
  let connexion;
  try { connexion = await lire("reglages", "connexion"); } catch (e) { ech.erreur = "Impossible de lire l'appareil : " + e.message; }
  if (!connexion) { ech.enCours = false; majEtatEchange(); return; }
  majEtatEchange();
  try {
    const envois = (await lireTout("envois")).filter((e) => e.etat !== "refuse");
    const curseur = (await lire("reglages", "curseur")) || { valeur: 0 };
    const appareil = await numeroAppareil();
    const corps = JSON.stringify({ appareil, cle: connexion.cleTablette, depuis: curseur.valeur, heureAppareil: new Date().toISOString(),
      evenements: envois.map((e) => e.ev) });
    let reponse, r, texte;
    const arret = new AbortController();
    const minuterie = setTimeout(() => arret.abort(), DELAI_REPONSE_MS);
    try {
      // « text/plain » : pas de demande préalable du navigateur, ce que Google ne sait pas traiter
      r = await fetch(connexion.url, { method: "POST", body: corps, headers: { "Content-Type": "text/plain;charset=utf-8" }, signal: arret.signal });
      texte = await r.text();
    } catch (e) {
      clearTimeout(minuterie);
      ech.erreur = e.name === "AbortError"
        ? "Google n'a pas répondu à temps (plus de 2 minutes). Les fiches restent sur l'appareil ; nouvel essai plus tard."
        : "Pas de connexion avec Google (pas de Wifi ?). Les fiches restent enregistrées sur l'appareil et partiront au prochain essai.";
      return;
    }
    clearTimeout(minuterie);
    const conseil = " Les fiches restent sur l'appareil. Prévenez la direction : vérifier l'installation du programme Google (voir la notice).";
    if (!r.ok) { ech.erreur = `Google a répondu par une erreur (code ${r.status}).` + conseil; return; }
    try { reponse = JSON.parse(texte); }
    catch (e) { ech.erreur = "Google a répondu quelque chose d'inattendu (pas les données attendues)." + conseil; return; }
    if (!reponse.ok) {
      ech.erreur = reponse.erreur || "Google a refusé l'échange.";
      if (reponse.occupe) setTimeout(synchroniser, NOUVEL_ESSAI_OCCUPE_MS);
      return;
    }
    // D221 : feuille Google remise à une version plus ancienne ?
    const restauree = curseur.valeur > 0 && reponse.idAuDepuis !== undefined
      && (reponse.curseur < curseur.valeur || (curseur.id && reponse.idAuDepuis !== null && reponse.idAuDepuis !== curseur.id));
    if (restauree) { await reprendreApresRestauration(reponse, envois, appareil); ech.relancer = true; }
    else await appliquerReponse(reponse, envois);
    ech.erreur = null;
    ech.programme = reponse.programme || ""; // date de la version du programme Google (D159 : contrôle des codes)
    ech.documentsAFaire = { docs: reponse.documents, connexion, appareil }; // copiés juste après, à part (voir synchroniser)
    ech.derniere = new Date();
    ech.heureDouteuse = !!reponse.heureDouteuse;
    await ecrire("reglages", { cle: "dernier-echange", valeur: ech.derniere.toISOString() });
  } catch (e) {
    ech.erreur = "Erreur pendant l'échange avec Google : " + e.message;
  } finally {
    ech.enCours = false;
    await compterEnvois();
    majEtatEchange();
    if (ech.relancer) { ech.relancer = false; setTimeout(synchroniser, 0); } // tout reprendre depuis la feuille
  }
}

async function appliquerReponse(rep, envois) {
  const db = await ouvrirBase();
  const acceptes = new Set(rep.acceptes || []), enAttente = new Set(rep.enAttente || []);
  const refus = Object.fromEntries((rep.refus || []).map((r) => [r.id, r.raison]));
  const effacements = (rep.evenements || []).filter((l) => l.type === "effacement").map((l) => l.salarie);
  // une ligne d'un salarié déjà effacé n'est jamais gardée (même si Google l'envoie encore pendant un effacement inachevé)
  const effaces = new Set((await lireTout("journal")).filter((l) => l.type === "effacement").map((l) => l.salarie).concat(effacements));
  await new Promise((ok, ko) => {
    const tx = db.transaction(["journal", "envois", "fiches", "reglages", "brouillons"], "readwrite");
    const sJournal = tx.objectStore("journal"), sEnvois = tx.objectStore("envois"), sFiches = tx.objectStore("fiches");
    for (const e of envois) {
      if (acceptes.has(e.id)) sEnvois.delete(e.id);
      else if (refus[e.id]) sEnvois.put({ ...e, etat: "refuse", raison: refus[e.id] });
      else if (enAttente.has(e.id)) sEnvois.put({ ...e, etat: "attente" });
    }
    for (const l of rep.evenements || []) if (l.type === "effacement" || !effaces.has(l.salarie)) sJournal.put(l);
    // marquer comme envoyées les fiches acceptées
    for (const id of acceptes) {
      const r = sFiches.get(id);
      r.onsuccess = () => { if (r.result) sFiches.put({ ...r.result, envoyee: true }); };
    }
    // effacement d'un salarié sorti : l'appareil efface aussi tout ce qu'il a sur lui (D44, conception §10).
    // Règle 18 : on compte ce qui est VRAIMENT retiré et n'avait jamais été envoyé (envois, fiche en cours), et on le dit.
    const retire = {}; // code -> { envois, brouillons }
    let curseursEnCours = 0;
    const finCurseur = () => {
      if (--curseursEnCours > 0) return;
      const textes = [];
      for (const [code, n] of Object.entries(retire)) {
        if (n.envois) textes.push(`${n.envois} enregistrement(s) de ${code} jamais envoyé(s) retiré(s) de l'appareil : le dossier de ce salarié a été effacé par la direction.`);
        if (n.brouillons) textes.push(`La fiche commencée pour ${code} a été retirée de l'appareil : le dossier de ce salarié a été effacé par la direction.`);
        if (n.bilansEnCours) textes.push(`Le bilan commencé pour ${code} a été retiré de l'appareil : le dossier de ce salarié a été effacé par la direction.`);
      }
      if (textes.length) tx.objectStore("reglages").put({ cle: "avis-" + Date.now(), avis: true, textes });
    };
    for (const code of effacements) {
      retire[code] = { envois: 0, brouillons: 0, bilansEnCours: 0 };
      const nettoyer = (store, garder, compter) => {
        curseursEnCours++;
        const c = store.openCursor();
        c.onsuccess = () => {
          const cur = c.result;
          if (!cur) return finCurseur();
          if (!garder(cur.value)) { if (compter) retire[code][compter]++; cur.delete(); }
          cur.continue();
        };
      };
      nettoyer(sJournal, (v) => v.salarie !== code || v.type === "effacement");
      nettoyer(sFiches, (v) => v.salarie.code !== code);
      nettoyer(sEnvois, (v) => v.ev.salarie !== code, "envois");
      nettoyer(tx.objectStore("brouillons"), (v) => v.salarieCode !== code, "brouillons");
      // D225 : les copies complètes de ses bilans (D221) et un bilan en cours pour lui disparaissent aussi
      nettoyer(tx.objectStore("reglages"), (v) => !(String(v.cle).startsWith("bilan-local-") && v.bilan && v.bilan.salarie && v.bilan.salarie.code === code));
      nettoyer(tx.objectStore("reglages"), (v) => !(String(v.cle).startsWith("bilan-en-cours-") && v.bilan && v.bilan.salarieCode === code), "bilansEnCours");
    }
    if (rep.referentiel) tx.objectStore("reglages").put({ cle: "referentiel", valeur: rep.referentiel });
    if (typeof rep.curseur === "number") tx.objectStore("reglages").put({ cle: "curseur", valeur: rep.curseur, id: rep.idCurseur || "" });
    tx.oncomplete = () => ok();
    tx.onerror = () => ko(tx.error);
    tx.onabort = () => ko(tx.error || new Error("écriture annulée"));
  });
  await recalculerDonnees();
}

// D221 : la feuille a été restaurée. On garde la réponse pour les envois de cet échange (acceptés, refusés), on oublie
// tout ce qui avait été reçu (le prochain échange reprend tout depuis la feuille), et on renvoie ce que CET appareil
// avait envoyé : Google ignore ce qu'il a déjà, et reprend ce qui manque. Les fiches et les bilans sont renvoyés depuis
// la copie gardée sur l'appareil, avec leurs signatures.
async function reprendreApresRestauration(rep, envois, appareil) {
  const anciens = (await lireTout("journal")).filter((l) => l.appareil === appareil && l.type !== "effacement");
  const fiches = Object.fromEntries((await lireTout("fiches")).map((f) => [f.id, f]));
  const bilans = Object.fromEntries((await lireTout("reglages")).filter((r) => r.cle.startsWith("bilan-local-")).map((r) => [r.bilan.id, r.bilan]));
  const enCours = new Set((await lireTout("envois")).map((e) => e.id));
  let renvoyes = 0, perdus = 0;
  const db = await ouvrirBase();
  await new Promise((ok, ko) => {
    const tx = db.transaction(["journal", "envois", "reglages"], "readwrite");
    tx.objectStore("journal").clear();
    tx.objectStore("reglages").put({ cle: "curseur", valeur: 0, id: "" });
    for (const l of anciens) {
      if (enCours.has(l.id)) continue;
      let contenu = l.contenu;
      if (l.type === "fiche") contenu = fiches[l.id] || null;
      else if (l.type === "bilan") contenu = bilans[l.id] || null;
      if (!contenu || JSON.stringify(contenu).includes("SIGNATURE_NON_TRANSMISE")) { perdus++; continue; } // jamais renvoyé sans ses signatures
      const ev = { id: l.id, type: l.type, date_action: l.date_action, personne: l.personne, salarie: l.salarie, objet: l.objet, contenu };
      tx.objectStore("envois").put({ id: l.id, etat: "a_envoyer", ev });
      renvoyes++;
    }
    tx.oncomplete = () => ok(); tx.onerror = () => ko(tx.error); tx.onabort = () => ko(tx.error || new Error("écriture annulée"));
  });
  await appliquerReponse({ ...rep, evenements: [], curseur: 0, idCurseur: "" }, envois); // les envois de cet échange
  await ecrire("reglages", { cle: "avis-" + Date.now(), avis: true, textes: [
    "La feuille Google a été remise à une version plus ancienne (restauration). Cette tablette reprend tout depuis la feuille"
    + (renvoyes ? ` et renvoie ${renvoyes} enregistrement(s) faits sur cet appareil, au cas où ils manqueraient.` : ".")
    + (perdus ? ` ATTENTION : ${perdus} enregistrement(s) ne peuvent pas être renvoyés (copie complète plus sur cet appareil) : prévenez la direction.` : "")] });
}

async function compterEnvois() {
  try {
    etat.echange.documents = await etatDocuments();
    etat.echange.avis = (await lireTout("reglages")).filter((r) => r.avis);
    const envois = await lireTout("envois");
    etat.echange.aEnvoyer = envois.filter((e) => e.etat !== "refuse").length;
    etat.echange.annulationsAEnvoyer = envois.filter((e) => e.etat !== "refuse" && e.ev.type === "annulation").length;
    etat.echange.attente = envois.filter((e) => e.etat === "attente").length;
    etat.echange.refus = envois.filter((e) => e.etat === "refuse" && !e.vu); // D130 : « J'ai compris » le retire de l'écran
  } catch (e) { etat.echange.erreur = "Impossible de lire l'appareil : " + e.message; }
}

// ---------- Affichage de l'état de l'échange (accueil) ----------
const NOMS_ENVOIS = { fiche: "fiche", annulation: "annulation de la fiche de", bilan: "bilan de", salarie: "dossier du salarié" };
function blocEtatEchange() {
  const ech = etat.echange;
  const lignes = [];
  const nA = ech.annulationsAEnvoyer || 0, nF = ech.aEnvoyer - nA; // règle 14 : dire ce qui attend vraiment
  const quoi = [nF ? `${nF} fiche(s)` : "", nA ? `${nA} annulation(s)` : ""].filter(Boolean).join(" et ");
  lignes.push(el("div", { "data-etat": "a-envoyer" }, ech.aEnvoyer
    ? `${quoi} enregistrée(s) sur l'appareil, pas encore envoyée(s) à Google.`
    : "Toutes les fiches de cet appareil sont envoyées à Google."));
  if (ech.attente) lignes.push(el("div", {}, `${ech.attente} correction(s) en attente de leur fiche d'origine.`));
  lignes.push(el("div", { class: "qui", "data-etat": "derniere" }, ech.derniere
    ? `Dernier échange avec Google : ${dateFr(ech.derniere)} à ${heureFr(ech.derniere)}.` : "Aucun échange avec Google pour l'instant."));
  if (ech.enCours) lignes.push(el("div", { class: "qui" }, "Échange en cours…"));
  if (ech.erreur) lignes.push(el("div", { class: "note-permis", "data-etat": "erreur" }, ech.erreur));
  if (ech.erreurDocuments) lignes.push(el("div", { class: "note-permis", "data-etat": "erreur-documents" }, ech.erreurDocuments));
  if (ech.documents && ech.documents.connu) {
    lignes.push(el("div", { class: ech.documents.presents < ech.documents.total ? "note-permis" : "qui", "data-etat": "documents" },
      `Documents des guides sur l'appareil : ${ech.documents.presents} sur ${ech.documents.total}.`
      + (ech.documents.manquantsDrive.length ? ` Absent(s) du dossier Drive « Documents » : ${ech.documents.manquantsDrive.join(", ")}.` : "")));
  }
  if (ech.heureDouteuse) lignes.push(el("div", { class: "note-permis" }, "L'heure de cet appareil semble fausse : vérifiez la date et l'heure de la tablette."));
  for (const a of ech.avis || []) {
    lignes.push(el("div", { class: "note-permis", "data-etat": "avis" }, ...a.textes.map((t) => el("div", {}, t)),
      el("button", { class: "petit", onclick: async () => {
        try { await supprimer("reglages", a.cle); await compterEnvois(); majEtatEchange(); }
        catch (e) { alerte("Impossible d'écrire sur l'appareil : " + e.message); }
      } }, "J'ai compris")));
  }
  for (const r of ech.refus) {
    lignes.push(el("div", { class: "note-permis", "data-etat": "refus" },
      `Refusé par Google : ${r.ev.type === "annulation" && r.ev.contenu && r.ev.contenu.bilan ? "annulation du bilan de" : NOMS_ENVOIS[r.ev.type] || r.ev.type} ${r.ev.salarie || ""} (${r.raison}).`
      + (r.ev.type === "annulation" ? (r.ev.contenu && r.ev.contenu.bilan ? " Le bilan n'est donc pas annulé." : " La fiche n'est donc pas annulée.") : ""),
      // D130 : le refus quitte l'écran, mais reste gardé sur l'appareil (jamais renvoyé) et noté dans la feuille Google
      el("button", { class: "petit", onclick: async () => {
        try { await ecrire("envois", { ...r, vu: true }); await compterEnvois(); majEtatEchange(); }
        catch (e) { alerte("Impossible d'écrire sur l'appareil : " + e.message); }
      } }, "J'ai compris")));
  }
  if (etat.stockageProtege === false) lignes.push(el("div", { class: "note-permis", "data-etat": "stockage" },
    "Attention : le stockage de cet appareil n'est pas protégé. Si la tablette manque de place, Chrome pourrait effacer des fiches pas encore envoyées. Installez l'application (icône sur l'écran d'accueil) et envoyez les fiches dès que possible."));
  if (etat.horsReseauImpossible) lignes.push(el("div", { class: "note-permis", "data-etat": "hors-reseau-impossible" }, etat.horsReseauImpossible));
  lignes.push(el("button", { class: "petit", onclick: () => synchroniser() }, "Mettre à jour maintenant"));
  lignes.push(el("div", { class: "qui", "data-version": VERSION_APPLI }, "Version de l'application : " + VERSION_APPLI));
  return el("div", { class: "carte", id: "etat-echange" }, ...lignes);
}
function majEtatEchange() {
  const ancien = document.getElementById("etat-echange");
  if (ancien) ancien.replaceWith(blocEtatEchange());
}

// ---------- Installation de l'appareil (adresse du programme Google et clé de la tablette) ----------
async function ecranInstallation(message) {
  const appareil = await numeroAppareil();
  const url = el("input", { id: "adresse", type: "url", placeholder: "https://script.google.com/macros/s/…/exec", class: "champ" });
  const cle = el("input", { id: "cle", type: "text", placeholder: "XXXX-XXXX-XXXX", class: "champ", autocomplete: "off" });
  const bouton = el("button", { class: "gros principal", id: "installer", onclick: async () => {
    if (bouton.disabled) return; // un double appui (gants) ne lance qu'une seule installation
    bouton.disabled = true;
    try { await installerAppareil(url.value, cle.value); } finally { bouton.disabled = false; }
  } }, "Enregistrer et vérifier avec Google");
  afficher(
    el("h1", {}, "Installation de cet appareil"),
    el("p", {}, "Numéro de cet appareil : ", el("strong", { id: "numero-appareil" }, appareil)),
    el("p", { class: "qui" }, "La direction autorise ce numéro dans la feuille Google (menu AGACI), puis tape ici l'adresse du programme et la clé donnée par la feuille."),
    el("label", {}, "Adresse du programme Google", url),
    el("label", {}, "Clé de cet appareil", cle),
    bouton,
    el("p", { class: "qui", "data-version": VERSION_APPLI }, "Version de l'application : " + VERSION_APPLI), // P112
  );
  if (message) alerte(message);
}

// D235 : feuille perdue et remplacée par une copie de sauvegarde (nouveau déploiement = nouvelle adresse). La direction donne
// la nouvelle adresse ; l'appareil la vérifie AVANT de la garder (même clé : la copie contient la liste des appareils
// autorisés). Rien n'est effacé sur l'appareil ; l'échange suivant reconnaît une feuille plus ancienne et renvoie (D221).
async function changerAdresseGoogle(adresse) {
  const url = adresse.trim();
  // D236 : seulement une adresse de programme Google (sur l'ordinateur de développement : le faux Google des essais)
  if (!/^https:\/\/script\.google\.com\//.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url))
    return { ok: false, raison: "ce n'est pas une adresse de programme Google (elle doit commencer par https://script.google.com/)" };
  const connexion = await lire("reglages", "connexion");
  if (!connexion) return { ok: false, raison: "cet appareil n'est pas installé" };
  if (url === connexion.url) return { ok: false, raison: "c'est déjà l'adresse utilisée" };
  const arret = new AbortController();
  const minuterie = setTimeout(() => arret.abort(), DELAI_REPONSE_MS);
  let rep;
  try {
    // simple vérification : aucun envoi, et un numéro de départ très grand pour ne rien recevoir
    const corps = JSON.stringify({ appareil: await numeroAppareil(), cle: connexion.cleTablette, depuis: Number.MAX_SAFE_INTEGER,
      heureAppareil: new Date().toISOString(), evenements: [] });
    const r = await fetch(url, { method: "POST", body: corps, headers: { "Content-Type": "text/plain;charset=utf-8" }, signal: arret.signal });
    rep = JSON.parse(await r.text());
  } catch (e) {
    return { ok: false, raison: e.name === "AbortError" ? "pas de réponse à temps" : "pas de réponse du programme Google à cette adresse (adresse fausse, ou pas de Wifi)" };
  } finally { clearTimeout(minuterie); }
  if (!rep || !rep.ok) { // le message de Google parle d'un nouvel essai automatique : il n'y en a pas ici
    const raison = String((rep && rep.erreur) || "réponse inattendue").replace(/\s*Nouvel essai automatique dans un moment\.?/, "").replace(/\.\s*$/, "");
    return { ok: false, raison };
  }
  await ecrire("reglages", { ...connexion, url, ancienneUrl: connexion.url, changeeLe: new Date().toISOString() });
  return { ok: true };
}

async function installerAppareil(adresse, cleTablette) {
  // attention : « cle » est le nom sous lequel le réglage est rangé ; la clé de la tablette s'appelle « cleTablette »
  const valeurs = { url: adresse.trim(), cleTablette: cleTablette.trim() };
  if (!/^https?:\/\//.test(valeurs.url) || !valeurs.cleTablette) return alerte("Il faut l'adresse (commençant par https://) et la clé.");
  try { await ecrire("reglages", { cle: "connexion", ...valeurs }); }
  catch (e) { return alerte("Impossible d'écrire sur l'appareil : " + e.message); }
  const debut = Date.now();
  await synchroniser();
  // réussite seulement si un échange a VRAIMENT abouti après l'enregistrement de la connexion
  const reussi = !etat.echange.erreur && etat.echange.derniere && etat.echange.derniere.getTime() >= debut - 1000;
  if (!reussi) {
    await supprimer("reglages", "connexion").catch(() => {});
    return alerte("Installation non terminée : " + (etat.echange.erreur || "pas de réponse de Google."));
  }
  ecranPin(`Appareil installé. Reçu de Google : ${etat.personnes.length} personne(s), ${etat.salaries.length} salarié(s), ${etat.referentiel ? etat.referentiel.guides.length : 0} guides. Tapez votre code.`);
}

// ---------- Échanges automatiques ----------
window.addEventListener("online", () => synchroniser());
setInterval(() => synchroniser(), INTERVALLE_ECHANGE_MS);

// D258 : ordre alphabétique (nom, puis prénom ; accents et majuscules ignorés ; à égalité, le code)
function comparerSalaries(a, b) {
  const c = (x, y) => String(x || "").localeCompare(String(y || ""), "fr", { sensitivity: "base" });
  return c(a.nom, b.nom) || c(a.prenom, b.prenom) || String(a.code).localeCompare(String(b.code), "fr", { numeric: true });
}
