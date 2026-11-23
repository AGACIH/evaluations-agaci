// Application d'évaluation des compétences AGACI – étapes 3 (fiche sur l'appareil) et 5c (échange avec Google, voir echange.js)
// Règles suivies : D39/D80 fiche complète, D46/D75 verrouillage + brouillon, D56 ordre des numéros,
// D79 deux zones de texte, D84 signatures, D98 signatures effacées si la fiche change, D16 une fiche n'est jamais écrasée, D96 conception multi-tablettes (v3.1).
"use strict";

const VERSION_APPLI = "2026-11-23-4"; // même valeur que VERSION dans sw.js (vérifié par un test)
const DELAI_VERROUILLAGE_MS = 5 * 60 * 1000; // D46 : 5 minutes sans utilisation
const ESSAIS_PIN_MAX = 5, BLOCAGE_PIN_MS = 5 * 60 * 1000; // D87 : 5 erreurs → 5 minutes
const JOUR_MS = 24 * 60 * 60 * 1000;
const DUREE_BROUILLON_MS = 7 * JOUR_MS, ALERTE_BROUILLON_MS = 6 * JOUR_MS; // D86

// Échelle EPSP, toujours dans le même ordre : bleu, rose, orange, vert (+ Non concerné : D188, seulement pour les points
// « (permis) » de la conduite quand le salarié n'a pas le permis, mis d'office ; jamais proposé ailleurs)
const ECHELLE = [
  { v: "bleu", encadrant: "Non", salarie: "Je ne sais pas faire" },
  { v: "rose", encadrant: "Avec aide", salarie: "Je fais avec de l'aide" },
  { v: "orange", encadrant: "En autonomie", salarie: "Je fais seul" },
  { v: "vert", encadrant: "Maîtrise", salarie: "Je peux montrer aux autres" },
  { v: "nc", encadrant: "Non concerné", salarie: "Non concerné" },
];

const etat = {
  referentiel: null, personnes: [], salaries: [],
  personne: null, fiche: null, derniereActivite: Date.now(),
};

// ---------- Messages à l'écran (règle 18 : aucun échec silencieux) ----------
function alerte(texte, ok = false, remonter = true) {
  const el = document.getElementById("alerte");
  el.textContent = texte; el.className = ok ? "alerte ok" : "alerte"; el.hidden = false;
  if (remonter) window.scrollTo(0, 0); // le bandeau reste visible en haut de l'écran dans tous les cas
}
function effacerAlerte() { const el = document.getElementById("alerte"); el.hidden = true; el.textContent = ""; }

// ---------- Stockage dans l'appareil (IndexedDB) ----------
let dbPromesse = null;
function ouvrirBase() {
  if (!dbPromesse) {
    dbPromesse = new Promise((ok, ko) => {
      const req = indexedDB.open("agaci-evaluations", 3);
      req.onupgradeneeded = (ev) => {
        const db = req.result;
        if (ev.oldVersion < 1) {
          db.createObjectStore("fiches", { keyPath: "id" });        // fiches faites sur cet appareil (avec signatures)
          db.createObjectStore("brouillons", { keyPath: "personneId" });
          db.createObjectStore("reglages", { keyPath: "cle" });
        }
        if (ev.oldVersion < 2) {
          db.createObjectStore("journal", { keyPath: "id" });       // tout ce que Google a renvoyé (toutes les tablettes)
          db.createObjectStore("envois", { keyPath: "id" });        // ce que cet appareil doit encore envoyer
        }
        if (ev.oldVersion < 3) db.createObjectStore("documents", { keyPath: "nom" }); // PDF des guides et de l'aide (D120)
      };
      req.onsuccess = () => ok(req.result);
      req.onerror = () => ko(req.error);
    });
  }
  return dbPromesse;
}
async function operation(magasin, mode, action) {
  const db = await ouvrirBase();
  return new Promise((ok, ko) => {
    const tx = db.transaction(magasin, mode);
    const req = action(tx.objectStore(magasin));
    let resultat;
    if (req) req.onsuccess = () => { resultat = req.result; };
    tx.oncomplete = () => ok(resultat);
    tx.onerror = () => ko(tx.error);
    tx.onabort = () => ko(tx.error || new Error("écriture annulée"));
  });
}
const lire = (m, cle) => operation(m, "readonly", (s) => s.get(cle));
const lireTout = (m) => operation(m, "readonly", (s) => s.getAll());
const ecrire = (m, objet) => operation(m, "readwrite", (s) => s.put(objet));
// Une fiche n'est jamais écrasée (D16) : « add » échoue si le numéro existe déjà.
const ajouter = (m, objet) => operation(m, "readwrite", (s) => s.add(objet));
const supprimer = (m, cle) => operation(m, "readwrite", (s) => s.delete(cle));

function hexAleatoire(octets) {
  const t = new Uint8Array(octets); crypto.getRandomValues(t);
  return Array.from(t, (b) => b.toString(16).padStart(2, "0")).join("");
}
async function numeroAppareil() {
  const r = await lire("reglages", "appareil");
  if (r) return r.valeur;
  const valeur = "T" + hexAleatoire(3).toUpperCase();
  await ecrire("reglages", { cle: "appareil", valeur });
  return valeur;
}

// ---------- Données de référence ----------
// Elles viennent de Google (référentiel, personnes, salariés) : voir recalculerDonnees() dans echange.js.

// Tri « dans l'ordre des numéros » (D56) : 1.2 < 1.10 < 1.13 < 1.14 ; C20 < C20.c1
function comparerCodes(a, b) {
  const ta = a.match(/\d+|[A-Za-z]+/g), tb = b.match(/\d+|[A-Za-z]+/g);
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    const na = /^\d+$/.test(ta[i]), nb = /^\d+$/.test(tb[i]);
    if (na && nb) { const d = Number(ta[i]) - Number(tb[i]); if (d) return d; }
    else { const d = ta[i].localeCompare(tb[i]); if (d) return d; }
  }
  return ta.length - tb.length;
}
const estPointPermis = (libelle) => libelle.includes("(permis)");

// ---------- Utilitaires d'affichage ----------
const $ecran = () => document.getElementById("ecran");
function el(tag, attrs = {}, ...enfants) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "onclick") e.addEventListener("click", v);
    else if (k === "onpointerdown") e.addEventListener("pointerdown", v);
    else if (k === "class") e.className = v;
    else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of enfants.flat()) if (c !== null && c !== undefined) e.append(c);
  return e;
}
// les morceaux vides (null, false) ne sont jamais affichés (sinon le mot « null » apparaissait à l'écran)
function afficher(...contenu) { const e = $ecran(); e.replaceChildren(...contenu.filter((x) => x !== null && x !== undefined && x !== false)); window.scrollTo(0, 0); }
const nomSalarie = (s) => `${s.code} – ${s.prenom} ${s.nom}`;
// D259 : zone de recherche sur le nom ; la liste se réduit à chaque lettre tapée (accents et majuscules ignorés)
const sansAccent = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
function zoneRecherche(lignes, apres = () => {}) { // lignes : [{ s (salarié), e (élément affiché) }] ; apres(recherche en cours) : titres à recalculer (D265)
  const aucun = el("p", { class: "qui", id: "aucun-salarie", hidden: true }, "Aucun salarié ne porte ce nom.");
  const champ = el("input", { type: "search", id: "chercher-salarie", class: "champ", placeholder: "Chercher un nom", autocomplete: "off" });
  champ.addEventListener("input", () => {
    const t = sansAccent(champ.value);
    let n = 0;
    for (const { s, e } of lignes) { const garde = !t || sansAccent(s.nom).includes(t); e.hidden = !garde; if (garde) n++; }
    aucun.hidden = n > 0;
    apres(!!t);
  });
  return el("div", { class: "recherche" }, champ, aucun);
}
const dateFr = (d) => d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
const heureFr = (d) => d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

// ---------- Code PIN ----------
async function empreinte(texte) {
  const octets = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texte));
  return Array.from(new Uint8Array(octets), (b) => b.toString(16).padStart(2, "0")).join("");
}
function ecranPin(message) {
  effacerAlerte(); // écran verrouillé : aucun message (ni nom de salarié) ne reste visible
  if (!etat.personnes.length || !etat.referentiel) {
    return afficher(
      el("h1", {}, "Évaluations AGACI"),
      el("p", {}, "Cet appareil n'a encore rien reçu de Google (personnes, salariés, guides). Connectez-le au Wifi, puis :"),
      el("button", { class: "gros principal", onclick: async () => { await synchroniser(); ecranPin(); } }, "Mettre à jour maintenant"),
      etat.echange.erreur ? el("p", { class: "note-permis" }, etat.echange.erreur) : null,
    );
  }
  let saisie = "";
  const points = el("div", { class: "pin-points", "aria-live": "polite" });
  const maj = () => { points.textContent = "●".repeat(saisie.length) || " "; };
  async function valider() {
    const code = saisie; saisie = ""; maj();
    let blocage;
    try { blocage = (await lire("reglages", "blocage-pin")) || { erreurs: 0, jusqua: 0 }; }
    catch (e) { return alerte("Impossible de lire la tablette : " + e.message); }
    if (Date.now() < blocage.jusqua) return alerteBlocage(blocage.jusqua);
    for (const p of etat.personnes) {
      if ((await empreinte(`${p.id}:${code}`)) === p.pin_empreinte) {
        try { await ecrire("reglages", { cle: "blocage-pin", erreurs: 0, jusqua: 0 }); }
        catch (e) { return alerte("Impossible d'écrire sur la tablette : " + e.message); }
        etat.personne = p; etat.derniereActivite = Date.now(); effacerAlerte();
        bloquerClicFantome();
        return ecranAccueil();
      }
    }
    blocage.erreurs += 1;
    if (blocage.erreurs >= ESSAIS_PIN_MAX) { blocage.erreurs = 0; blocage.jusqua = Date.now() + BLOCAGE_PIN_MS; }
    try { await ecrire("reglages", { cle: "blocage-pin", ...blocage }); }
    catch (e) { return alerte("Impossible d'écrire sur la tablette : " + e.message); }
    if (blocage.jusqua > Date.now()) alerteBlocage(blocage.jusqua);
    else alerte(`Code incorrect. Recommencez (encore ${ESSAIS_PIN_MAX - blocage.erreurs} essai(s) avant blocage de 5 minutes).`);
  }
  const alerteBlocage = (jusqua) => alerte(`Trop d'erreurs : application bloquée jusqu'à ${heureFr(new Date(jusqua))}.`);
  // pointerdown plutôt que click : une frappe rapide sur la même touche n'est jamais perdue
  const touche = (t) => el("button", { onpointerdown: (ev) => {
    ev.preventDefault();
    if (t === "⌫") saisie = saisie.slice(0, -1);
    else if (saisie.length < 4) saisie += t;
    maj(); if (saisie.length === 4) valider();
  }, "aria-label": t === "⌫" ? "Effacer" : t }, t);
  maj();
  afficher(
    el("h1", {}, "Évaluations AGACI"),
    el("p", {}, message || "Tapez votre code (4 chiffres)."),
    points,
    el("div", { class: "clavier" }, ..."123456789".split("").map(touche), el("span"), touche("0"), touche("⌫")),
  );
}
// Le dernier chiffre est pris au toucher (pointerdown) : l'accueil s'affiche alors que le doigt est encore posé,
// et en le relevant la tablette « clique » sur le bouton apparu dessous (constat de Hugues du 17/11 : arrivée sur
// « Fiches »). On ignore donc UN seul clic : celui qui suit ce doigt relevé (dans les 0,5 s ; 3 s au plus si le
// doigt reste posé). Si le doigt est déjà relevé quand le code est reconnu, rien n'est ignoré. Un nouveau toucher
// annule cette attente : un vrai clic n'est jamais perdu.
let clicFantome = null; // { jusqua, relache }
let doigtPose = false;
function bloquerClicFantome() { clicFantome = doigtPose ? { jusqua: Date.now() + 3000, relache: false } : null; }
document.addEventListener("pointerup", () => {
  doigtPose = false;
  if (clicFantome && !clicFantome.relache) { clicFantome.relache = true; clicFantome.jusqua = Date.now() + 500; }
}, true);
document.addEventListener("pointercancel", () => { doigtPose = false; clicFantome = null; }, true);
document.addEventListener("pointerdown", () => { doigtPose = true; if (clicFantome && clicFantome.relache) clicFantome = null; }, true);
document.addEventListener("click", (ev) => {
  const attendu = clicFantome && Date.now() < clicFantome.jusqua;
  clicFantome = null;
  if (attendu) { ev.preventDefault(); ev.stopPropagation(); }
}, true);

function verrouiller() {
  if (etat.bilan && etat.personne) { clearTimeout(minuterieBilan); ecrireBilanEnCours(etat.bilan, etat.personne); } // D195 : gardé tout de suite
  etat.personne = null; etat.fiche = null; etat.bilan = null;
  ecranPin("Application verrouillée après 5 minutes sans utilisation. La fiche en cours est gardée. Tapez votre code.");
}
["pointerdown", "keydown", "input"].forEach((t) => document.addEventListener(t, () => { etat.derniereActivite = Date.now(); }, true));
setInterval(() => {
  if (etat.personne && Date.now() - etat.derniereActivite >= DELAI_VERROUILLAGE_MS) verrouiller();
}, 5000);

// ---------- Accueil ----------
async function ecranAccueil(messageOk) {
  let brouillon;
  try { brouillon = await lire("brouillons", etat.personne.id); }
  catch (e) { alerte("Impossible de lire la tablette : " + e.message); }
  const boutons = [];
  let avertissement = null;
  try {
    const efface = await lire("reglages", "brouillon-efface-" + etat.personne.id);
    if (efface) {
      avertissement = `Une fiche commencée il y a plus de 7 jours et jamais finie (${efface.salarieCode} – ${efface.guideCode}) a été effacée (règle D86).`;
      await supprimer("reglages", efface.cle);
    }
  } catch (e) { alerte("Impossible de lire la tablette : " + e.message); }
  // D195 : bilan commencé et pas fini (même règle que la fiche : 7 jours, D86)
  let bilanEnCours = null;
  try {
    bilanEnCours = await lire("reglages", CLE_BILAN_EN_COURS + etat.personne.id);
    if (bilanEnCours) {
      const age = Date.now() - new Date(bilanEnCours.bilan.debut).getTime();
      const s = etat.salaries.find((x) => x.code === bilanEnCours.bilan.salarieCode);
      if (age >= DUREE_BROUILLON_MS || !s) {
        await supprimer("reglages", bilanEnCours.cle);
        avertissement = !s ? `Le bilan commencé pour ${bilanEnCours.bilan.salarieCode} a été effacé : ce salarié n'est plus dans la liste des présents.`
          : `Un bilan commencé il y a plus de 7 jours et jamais validé (${bilanEnCours.bilan.salarieCode}) a été effacé (D195).`;
        bilanEnCours = null;
      } else if (age >= ALERTE_BROUILLON_MS) {
        avertissement = `Attention : le bilan en cours sera effacé le ${dateFr(new Date(new Date(bilanEnCours.bilan.debut).getTime() + DUREE_BROUILLON_MS))} s'il n'est pas validé.`;
      }
    }
  } catch (e) { alerte("Impossible de lire le bilan en cours sur la tablette : " + e.message); }
  if (bilanEnCours) {
    const s = etat.salaries.find((x) => x.code === bilanEnCours.bilan.salarieCode);
    boutons.push(
      el("button", { class: "gros principal", id: "reprendre-bilan", onclick: () => reprendreBilan(bilanEnCours.bilan, s) }, `Reprendre le bilan en cours : ${nomSalarie(s)}`),
      el("button", { class: "gros", id: "abandonner-bilan", onclick: async () => {
        if (!confirm("Abandonner le bilan en cours ? Ce qui a été saisi sera perdu.")) return;
        try { await supprimer("reglages", bilanEnCours.cle); ecranAccueil(); }
        catch (e) { alerte("Impossible d'effacer le bilan en cours : " + e.message); }
      } }, "Abandonner le bilan en cours"));
  }
  if (brouillon) {
    try {
      const deja = (await lireTout("fiches")).some((x) => x.auteur.id === etat.personne.id && x.brouillonDebut === brouillon.fiche.debut);
      if (deja) {
        brouillon = null;
        try { await supprimer("brouillons", etat.personne.id); } catch (e) { /* il reste, mais n'est jamais reproposé */ }
      }
    } catch (e) { alerte("Impossible de lire la tablette : " + e.message); }
  }
  if (brouillon) {
    const age = Date.now() - new Date(brouillon.fiche.debut).getTime();
    if (age >= DUREE_BROUILLON_MS) {
      try { await supprimer("brouillons", etat.personne.id); }
      catch (e) { alerte("Impossible d'effacer un brouillon trop ancien : " + e.message); }
      avertissement = "Une fiche commencée il y a plus de 7 jours et jamais finie a été effacée (règle D86).";
      brouillon = null;
    } else if (age >= ALERTE_BROUILLON_MS) {
      avertissement = `Attention : la fiche en cours sera effacée le ${dateFr(new Date(new Date(brouillon.fiche.debut).getTime() + DUREE_BROUILLON_MS))} si elle n'est pas finie.`;
    }
  }
  if (brouillon) {
    const s = etat.salaries.find((x) => x.code === brouillon.salarieCode);
    boutons.push(
      el("button", { class: "gros principal", onclick: () => reprendreBrouillon(brouillon) },
        `Reprendre la fiche en cours : ${s ? nomSalarie(s) : brouillon.salarieCode} – ${brouillon.guideCode}`),
      el("button", { class: "gros", onclick: async () => {
        if (!confirm("Abandonner la fiche en cours ? Ce qui a été saisi sera perdu.")) return;
        try { await supprimer("brouillons", etat.personne.id); ecranAccueil(); }
        catch (e) { alerte("Impossible d'effacer le brouillon : " + e.message); }
      } }, "Abandonner la fiche en cours"),
    );
  } else {
    boutons.push(el("button", { class: "gros principal", onclick: ecranChoixSalarie }, "Nouvelle fiche de fin de guide"));
  }
  boutons.push(el("button", { class: "gros", onclick: () => ecranListe() }, "Fiches (toutes les tablettes)"));
  boutons.push(el("button", { class: "gros", onclick: ecranSuivi }, "Suivi des salariés")); // D261
  // D43 : la gestion des salariés est réservée à l'accompagnatrice et à la direction
  if (ROLES_SECOURS.includes(etat.personne.role)) boutons.push(el("button", { class: "gros", onclick: ecranSalaries }, "Salariés"));
  // D235 : seulement pour la direction, en cas de feuille Google remplacée par une copie de sauvegarde
  if (etat.personne.role === "direction") boutons.push(el("button", { class: "gros", id: "changer-adresse", onclick: ecranChangerAdresse }, "Changer l'adresse de Google"));
  await compterEnvois();
  let bilans = null;
  try { bilans = blocBilansProches((await calculerFiches()).fiches, await calculerBilans()); }
  catch (e) { alerte("Impossible de calculer les bilans à venir : " + e.message); }
  afficher(
    el("div", { class: "barre" }, el("h1", {}, "Accueil"),
      el("button", { class: "petit", onclick: () => ecranAide(() => ecranAccueil()) }, "Aide"),
      el("button", { class: "petit", onclick: verrouiller }, "Verrouiller")),
    el("p", { class: "qui" }, `Connecté : ${etat.personne.nom}`),
    bilans,
    ...boutons,
    blocEtatEchange(),
  );
  if (avertissement) alerte(avertissement);
  else if (messageOk) alerte(messageOk, true);
}

// D86 : au démarrage, effacer les brouillons de plus de 7 jours, quelle que soit la personne
async function purgerBrouillons() {
  const tous = await lireTout("brouillons");
  for (const b of tous) {
    if (Date.now() - new Date(b.fiche.debut).getTime() >= DUREE_BROUILLON_MS) {
      await supprimer("brouillons", b.personneId);
      // la personne sera prévenue à sa prochaine connexion
      await ecrire("reglages", { cle: "brouillon-efface-" + b.personneId, salarieCode: b.salarieCode, guideCode: b.guideCode });
    }
  }
}

// ---------- Choix du salarié puis du guide (D45 : seulement les activités du salarié) ----------
function ecranChoixSalarie() {
  effacerAlerte();
  const lignes = etat.salaries.map((s) => ({ s, e: el("button", { class: "gros", "data-choix-salarie": s.code, onclick: () => ecranChoixGuide(s) },
    nomSalarie(s), el("br"), el("span", { class: "qui" }, s.activites.join(", "))) }));
  afficher(
    el("div", { class: "barre" }, el("h1", {}, "Quel salarié ?"), el("button", { class: "petit", onclick: () => ecranAccueil() }, "Retour")),
    zoneRecherche(lignes),
    ...lignes.map((l) => l.e),
  );
}
function ecranChoixGuide(salarie) {
  const guides = etat.referentiel.guides.filter((g) => salarie.activites.includes(g.activite));
  const parActivite = {};
  for (const g of guides) (parActivite[g.activite] ||= []).push(g);
  afficher(
    el("div", { class: "barre" }, el("h1", {}, "Quel guide ?"), el("button", { class: "petit", onclick: ecranChoixSalarie }, "Retour")),
    el("p", { class: "qui" }, nomSalarie(salarie)),
    ...Object.entries(parActivite).flatMap(([act, gs]) => [
      el("h2", {}, act),
      ...gs.map((g) => el("button", { class: "gros", onclick: () => ecranDocumentGuide(salarie, g) }, `${g.code} – ${g.titre}`)),
    ]),
  );
}

// ---------- La fiche ----------
function pointsDuGuide(guide, permis) {
  const faire = (codes, section) => [...codes].sort(comparerCodes).map((code) => {
    const p = etat.points[code];
    const bloque = !permis && estPointPermis(p.libelle); // D13 : sans permis → Non concerné
    return { code, libelle: p.libelle, section, bloquePermis: bloque, encadrant: bloque ? "nc" : null, salarie: bloque ? "nc" : null };
  });
  return [...faire(guide.codes_metier, "metier"), ...faire(guide.codes_competences_cles, "cles")];
}
function nouvelleFiche(salarie, guide) {
  etat.fiche = {
    salarieCode: salarie.code, guideCode: guide.code, permis: !!salarie.permis,
    points: pointsDuGuide(guide, !!salarie.permis), reussi: "", observations: "",
    signatures: { salarie: null, encadrant: null }, debut: new Date().toISOString(),
  };
  sauverBrouillon();
  ecranFiche();
}
// D188, D191 : une fiche commencée avant la mise à jour peut avoir « Non concerné » sur un point ordinaire : on l'efface et on le dit
const ncInterdit = (p) => !p.bloquePermis && (p.encadrant === "nc" || p.salarie === "nc");
function reprendreBrouillon(b) {
  etat.fiche = b.fiche;
  let n = 0;
  for (const p of b.fiche.points) if (ncInterdit(p)) {
    n++;
    if (p.encadrant === "nc") p.encadrant = null;
    if (p.salarie === "nc") p.salarie = null;
  }
  if (n && b.fiche.signatures) { b.fiche.signatures.salarie = null; b.fiche.signatures.encadrant = null; } // la fiche a changé (D98)
  ecranFiche(n ? `Fiche reprise. ${n} point(s) étaient en « Non concerné » : choisissez une couleur (D188). Faites signer à nouveau.`
    : "Fiche reprise. Vérifiez les signatures avant d'enregistrer.");
  if (n) sauverBrouillon();
}

let minuterieBrouillon = null;

// D98 : si la fiche change après une signature, les deux signatures sont effacées
function invaliderSignatures() {
  const s = etat.fiche.signatures;
  const encre = Object.values(zonesSignature).some((z) => z.encre() > 0); // P80 : même un trait court non retenu
  if (!s.salarie && !s.encadrant && !encre) return;
  Object.values(zonesSignature).forEach((z) => z.vider());
  alerte("La fiche a changé après les signatures : les signatures ont été effacées. Faites signer à nouveau.");
}
function sauverBrouillon() {
  clearTimeout(minuterieBrouillon);
  const personne = etat.personne, fiche = etat.fiche;
  if (!personne || !fiche) return;
  minuterieBrouillon = setTimeout(async () => {
    if (fiche.enregistrementEnCours) return; // jamais de brouillon recréé pendant ou après l'enregistrement
    try { await ecrire("brouillons", { personneId: personne.id, salarieCode: fiche.salarieCode, guideCode: fiche.guideCode, fiche }); }
    catch (e) { alerte("Attention : la fiche en cours n'a pas pu être gardée sur la tablette (" + e.message + ")."); }
  }, 300);
}

// Étape 8b (D144, D147) : la dernière couleur donnée par l'encadrant à ce point, dans n'importe quel guide, pour ce salarié.
// Calculée à partir des fiches (non annulées, non refusées), jamais enregistrée (D18).
function couleursPrecedentes(salarieCode, fiches) {
  const parPoint = {};
  for (const f of fiches) { // de la plus récente à la plus ancienne
    if (f.salarie.code !== salarieCode || f.refusee) continue;
    // D149 : « Non concerné » n'est pas une couleur : on le saute et on garde la dernière vraie couleur
    for (const p of f.points) if (p.encadrant && p.encadrant !== "nc" && !parPoint[p.code]) {
      parPoint[p.code] = { v: p.encadrant, date: f.dateHeure, guide: f.guide.code, aVerifier: !!(f.heureDouteuse || f.douteuseGoogle) };
    }
  }
  return parPoint;
}

function blocPastilles(point, qui) {
  const conteneur = el("div", { class: "pastilles" });
  const dessiner = () => {
    // D188 : le bouton « Non concerné » n'apparaît que sur un point « (permis) » bloqué (il y est mis d'office)
    conteneur.replaceChildren(...ECHELLE.filter((n) => n.v !== "nc" || point.bloquePermis).map((n) => {
      const choisi = point[qui] === n.v;
      return el("button", {
        class: "pastille" + (choisi ? " choisie" : point[qui] ? " attenuee" : ""), "data-v": n.v,
        "aria-pressed": choisi ? "true" : "false", disabled: point.bloquePermis,
        "data-point": point.code, "data-qui": qui,
        onclick: () => { if (point[qui] === n.v) return; point[qui] = n.v; dessiner(); invaliderSignatures(); sauverBrouillon(); },
      }, qui === "encadrant" ? n.encadrant : n.salarie);
    }));
  };
  dessiner();
  return el("div", { class: "ligne-avis", "data-ligne": qui }, el("span", { class: "etiquette" }, qui === "encadrant" ? "Encadrant" : "Salarié"), conteneur);
}

// D147 : sur la ligne de l'encadrant seulement, à droite, la couleur donnée la fois précédente, avec sa date.
// Ajoutée juste après l'affichage de la fiche (la fiche s'affiche tout de suite, sans attendre ce calcul).
async function ajouterCouleursPrecedentes(f) {
  let precedentes;
  try { precedentes = couleursPrecedentes(f.salarieCode, (await calculerFiches()).fiches); }
  catch (e) { return alerte("Impossible de lire les fiches précédentes de ce salarié : " + e.message); }
  if (etat.fiche !== f) return; // une autre fiche ou un autre écran entre-temps
  for (const p of f.points) {
    const precedent = precedentes[p.code];
    const ligne = document.querySelector(`[id="point-${CSS.escape(p.code)}"] [data-ligne="encadrant"]`);
    if (!precedent || !ligne || ligne.querySelector(".precedent")) continue;
    ligne.append(el("div", { class: "precedent", "data-precedent": precedent.v, "data-point": p.code },
      el("span", { class: "avis-lecture", "data-v": precedent.v }, "Avant : " + nomAvis("encadrant", precedent.v)),
      el("div", { class: "qui" }, `${dateFr(new Date(precedent.date))}${precedent.aVerifier ? " (à vérifier)" : ""} · ${precedent.guide}`))); // D150
  }
}

// Règle de la signature (P76, P78) :
// - tous les traits s'additionnent depuis le dernier « Effacer » : des initiales en plusieurs petits traits sont possibles ;
// - la signature est retenue dès que le total atteint SEUIL_SIGNATURE_PX ; chaque trait suivant s'y ajoute ;
// - dès qu'on touche ailleurs (ou à la reprise d'une fiche), le cadre signé est figé : un toucher involontaire
//   ne change plus rien ; pour recommencer, bouton « Effacer la signature ».
const SEUIL_SIGNATURE_PX = 40; // D99 : environ 1 cm au total (à vérifier sur la vraie tablette, étape 4)
const zonesSignature = {}; // qui -> { vider, figer, encre }
document.addEventListener("pointerdown", (ev) => {
  for (const [qui, z] of Object.entries(zonesSignature)) if (!ev.target.closest || ev.target.closest(`[data-signature="${qui}"]`) === null) z.figer();
}, true);

// cible() : l'objet qui garde les signatures (la fiche par défaut, le bilan à l'étape 10) ; sauver() : après chaque signature
function zoneSignature(qui, cible = () => etat.fiche && etat.fiche.signatures, sauver = sauverBrouillon, titre = null, largeurImage = 0) {
  const canvas = el("canvas", { class: "signature", "data-signature": qui });
  const aide = el("div", { class: "qui", hidden: true }, "Signé. Pour recommencer : « Effacer la signature ».");
  let dessine = false, ctx, trait = 0, encre = 0, dernier = null, largeur = 0, hauteur = 0, fige = false;
  const majAide = () => { aide.hidden = !fige; };
  const preparer = () => {
    const r = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
    largeur = r.width; hauteur = r.height;
    canvas.width = r.width * ratio; canvas.height = r.height * ratio;
    ctx = canvas.getContext("2d"); ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.strokeStyle = "#000";
    const existante = cible() && cible()[qui];
    if (existante) {
      fige = true; majAide(); // fiche reprise : la signature déjà faite est figée
      const img = new Image(); img.onload = () => ctx.drawImage(img, 0, 0, largeur, hauteur); img.src = existante;
    }
  };
  const pos = (ev) => { const r = canvas.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
  canvas.addEventListener("pointerdown", (ev) => {
    if (fige || !ctx) return;
    dessine = true; trait = 0; dernier = pos(ev); canvas.setPointerCapture(ev.pointerId); ctx.beginPath(); ctx.moveTo(...dernier);
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!dessine) return;
    const p = pos(ev);
    trait += Math.hypot(p[0] - dernier[0], p[1] - dernier[1]);
    dernier = p; ctx.lineTo(...p); ctx.stroke();
  });
  const fin = () => {
    if (!dessine) return; dessine = false; dernier = null;
    encre += trait;
    if (encre >= SEUIL_SIGNATURE_PX && cible()) { cible()[qui] = imageSignature(canvas, largeurImage); sauver(); }
  };
  canvas.addEventListener("pointerup", fin); canvas.addEventListener("pointercancel", fin);
  requestAnimationFrame(preparer);
  const vider = () => { if (cible()) cible()[qui] = null; trait = 0; encre = 0; fige = false; majAide(); if (ctx) ctx.clearRect(0, 0, largeur, hauteur); };
  zonesSignature[qui] = {
    vider,
    figer: () => { if (cible() && cible()[qui] && !fige) { fige = true; majAide(); } },
    encre: () => encre,
  };
  const effacer = el("button", { class: "petit", onclick: () => { vider(); sauver(); } }, "Effacer la signature");
  return el("div", { class: "carte", id: "signature-" + qui },
    el("div", { class: "barre" }, el("strong", {}, titre || (qui === "salarie" ? "Signature du salarié" : "Signature de l'encadrant")), effacer),
    canvas, aide);
}

// largeurImage > 0 : image réduite à cette largeur, en noir et blanc, beaucoup plus légère (D204, bilans)
function imageSignature(canvas, largeurImage) {
  if (!largeurImage || canvas.width <= largeurImage) return canvas.toDataURL("image/png");
  const petit = document.createElement("canvas");
  petit.width = largeurImage; petit.height = Math.max(1, Math.round(canvas.height * largeurImage / canvas.width));
  const c = petit.getContext("2d");
  c.fillStyle = "#fff"; c.fillRect(0, 0, petit.width, petit.height);
  c.drawImage(canvas, 0, 0, petit.width, petit.height);
  return petit.toDataURL("image/jpeg", 0.6);
}

function viderZonesSignature() { for (const k of Object.keys(zonesSignature)) delete zonesSignature[k]; }

function ecranFiche(messageOk) {
  viderZonesSignature();
  const f = etat.fiche;
  const salarie = etat.salaries.find((s) => s.code === f.salarieCode);
  const guide = etat.referentiel.guides.find((g) => g.code === f.guideCode);
  const carte = (p) => el("div", { class: "carte", id: "point-" + p.code },
    el("div", {}, el("span", { class: "code" }, p.code), p.libelle),
    p.bloquePermis ? el("div", { class: "note-permis" }, "Le salarié n'a pas le permis : point « Non concerné ».") : null,
    blocPastilles(p, "encadrant"), blocPastilles(p, "salarie"));
  const metier = f.points.filter((p) => p.section === "metier"), cles = f.points.filter((p) => p.section === "cles");
  const zone = (cle, titre) => {
    const t = el("textarea", { id: "texte-" + cle }); t.value = f[cle];
    t.addEventListener("input", () => { f[cle] = t.value; invaliderSignatures(); sauverBrouillon(); });
    return el("div", { class: "carte" }, el("strong", {}, titre), t);
  };
  afficher(
    el("div", { class: "barre" }, el("h1", {}, `${guide.code} – ${guide.titre}`),
      el("button", { class: "petit", onclick: () => ecranAide(() => ecranFiche()) }, "Aide"),
      el("button", { class: "petit", onclick: () => ecranAccueil() }, "Accueil (la fiche reste en cours)")),
    el("p", { class: "qui" }, `Salarié : ${nomSalarie(salarie)} · Encadrant : ${etat.personne.nom} · Date : ${dateFr(new Date())}`),
    metier.length ? el("h2", {}, "Compétences du métier") : el("p", { class: "qui" }, "Ce guide n'a pas de compétence du métier."),
    ...metier.map(carte),
    el("h2", {}, "Comportements et savoirs de base"),
    ...cles.map(carte),
    zone("reussi", "Ce que j'ai bien réussi / ce que je dois retravailler (salarié)"),
    zone("observations", "Observations de l'encadrant"),
    zoneSignature("salarie"), zoneSignature("encadrant"),
    el("button", { class: "gros principal", id: "enregistrer", onclick: enregistrerFiche }, "Enregistrer la fiche"),
  );
  if (messageOk) alerte(messageOk, true);
  ajouterCouleursPrecedentes(f); // étape 8b, juste après l'affichage
}

async function enregistrerFiche() {
  const f = etat.fiche;
  if (!f || f.enregistrementEnCours) return; // un double appui n'enregistre qu'une fiche
  document.querySelectorAll(".manque").forEach((e) => e.classList.remove("manque"));
  const incomplets = f.points.filter((p) => !p.encadrant || !p.salarie || ncInterdit(p)); // D191 : jamais « Non concerné » hors permis
  const manques = [];
  if (incomplets.length) manques.push(`${incomplets.length} point(s) sans les deux avis`);
  const courte = (qui) => (zonesSignature[qui] && zonesSignature[qui].encre() > 0 ? " (trait trop court : signez plus grand)" : "");
  if (!f.signatures.salarie) manques.push("la signature du salarié" + courte("salarie"));
  if (!f.signatures.encadrant) manques.push("la signature de l'encadrant" + courte("encadrant"));
  if (manques.length) {
    incomplets.forEach((p) => document.getElementById("point-" + p.code)?.classList.add("manque"));
    if (!f.signatures.salarie) document.getElementById("signature-salarie").classList.add("manque");
    if (!f.signatures.encadrant) document.getElementById("signature-encadrant").classList.add("manque");
    alerte("Fiche pas encore enregistrée. Il manque : " + manques.join(", ") + ".");
    return;
  }
  const salarie = etat.salaries.find((s) => s.code === f.salarieCode);
  const guide = etat.referentiel.guides.find((g) => g.code === f.guideCode);
  const maintenant = new Date();
  f.enregistrementEnCours = true;
  clearTimeout(minuterieBrouillon);
  const bouton = document.getElementById("enregistrer");
  if (bouton) { bouton.disabled = true; bouton.textContent = "Enregistrement…"; }
  let raisonsDoute = [];
  try {
    const appareil = await numeroAppareil();
    // Conception §4 : contrôles de bon sens sur la date (la date « dans le futur » se contrôlera à l'envoi, étape 5)
    if (salarie.date_entree && maintenant < new Date(salarie.date_entree + "T00:00:00")) raisonsDoute.push("date avant l'entrée du salarié");
    const fichesAppareil = (await lireTout("fiches")).filter((x) => x.appareil === appareil && !x.heureDouteuse);
    const derniere = fichesAppareil.map((x) => x.dateHeure).sort().pop();
    if (derniere && maintenant.toISOString() < derniere) raisonsDoute.push("date plus ancienne que la dernière fiche de cet appareil");
    const fiche = {
      id: `${appareil}-${hexAleatoire(6)}`, version: 1, remplace: null, appareil,
      auteur: { id: etat.personne.id, nom: etat.personne.nom },
      salarie: { code: salarie.code, nom: salarie.nom, prenom: salarie.prenom },
      guide: { code: guide.code, titre: guide.titre, activite: guide.activite },
      dateHeure: maintenant.toISOString(), permisCeJour: f.permis,           // conception §6
      points: f.points.map(({ code, libelle, section, encadrant, salarie: s }) => ({ code, libelle, section, encadrant, salarie: s })),
      reussi: f.reussi, observations: f.observations, signatures: f.signatures,
      heureDouteuse: raisonsDoute.length > 0, raisonsDoute,
      brouillonDebut: f.debut, // relie la fiche à son brouillon : un brouillon déjà enregistré n'est jamais reproposé
      envoyee: false,
    };
    const evenement = { id: fiche.id, type: "fiche", date_action: fiche.dateHeure, personne: fiche.auteur.id,
      salarie: fiche.salarie.code, objet: fiche.id, contenu: fiche };
    await enregistrerFicheEtEnvoi(fiche, evenement); // la fiche et son envoi sont écrits ensemble, ou pas du tout
    const relue = await lire("fiches", fiche.id); // on relit pour être sûr que c'est bien écrit
    if (!relue) throw new Error("la fiche relue est vide");
  } catch (e) {
    f.enregistrementEnCours = false;
    if (bouton) { bouton.disabled = false; bouton.textContent = "Enregistrer la fiche"; }
    // la dernière action (ex. signature) n'est pas perdue : on garde tout de suite la fiche en cours
    try { await ecrire("brouillons", { personneId: etat.personne.id, salarieCode: f.salarieCode, guideCode: f.guideCode, fiche: f }); }
    catch (e2) { /* le message d'échec ci-dessous suffit */ }
    return alerte("ÉCHEC : la fiche n'a pas pu être enregistrée sur cet appareil (" + e.message + "). Ne fermez pas l'application.");
  }
  // À partir d'ici la fiche EST enregistrée : on ne lève plus le verrou, elle ne peut pas être réenregistrée.
  etat.fiche = null;
  let messageBrouillon = "";
  try { await supprimer("brouillons", etat.personne.id); }
  catch (e) { messageBrouillon = " Attention : la fiche en cours n'a pas pu être retirée de la tablette ; elle ne sera pas proposée à nouveau."; }
  await ecranAccueil(`Fiche enregistrée sur cet appareil (${guide.code}, ${nomSalarie(salarie)}, ${dateFr(maintenant)} à ${heureFr(maintenant)}). Elle sera envoyée à Google au retour du Wifi.`
    + (raisonsDoute.length ? ` Attention, heure douteuse : ${raisonsDoute.join(", ")}. Vérifiez la date de la tablette.` : "")
    + messageBrouillon);
  synchroniser(); // essai d'envoi tout de suite ; l'accueil affiche le résultat
}

// ---------- Liste des fiches (toutes les tablettes) ----------
// Les fiches à montrer : reçues de Google + celles de cet appareil (avec leurs signatures), sans les fiches
// annulées (D74) ni celles d'un salarié effacé. Une fiche refusée par Google est marquée « refusee ».
async function calculerFiches() {
  let fiches = [], illisibles = 0;
  {
    const miennes = await lireTout("fiches");
    const journal = await lireTout("journal");
    const effaces = new Set(journal.filter((l) => l.type === "effacement").map((l) => l.salarie));
    const annules = await idsAnnules(journal); // D74 : une fiche annulée disparaît des écrans
    // règle 14 : une fiche refusée par Google est montrée « refusée » (et pas « pas encore envoyée »)
    const refuses = Object.fromEntries((await lireTout("envois")).filter((e) => e.etat === "refuse").map((e) => [e.id, e.raison]));
    const parId = {};
    for (const l of journal) if (l.type === "fiche" && l.contenu) parId[l.id] = { ...l.contenu, recueDeGoogle: true, douteuseGoogle: l.douteuse };
    for (const f of miennes) parId[f.id] = { ...f, douteuseGoogle: parId[f.id] ? parId[f.id].douteuseGoogle : "", refusee: refuses[f.id] || "" }; // les miennes ont leurs signatures
    const toutes = Object.values(parId);
    // une fiche reçue incomplète (par exemple une ancienne fiche d'essai) n'est pas affichée, mais elle est comptée (règle 18)
    const lisible = (f) => f && f.salarie && f.salarie.code && f.guide && f.guide.code && f.auteur && f.dateHeure && Array.isArray(f.points);
    illisibles = toutes.filter((f) => !lisible(f)).length;
    fiches = toutes.filter((f) => lisible(f) && !effaces.has(f.salarie.code) && !annules.has(f.id));
  }
  fiches.sort((a, b) => b.dateHeure.localeCompare(a.dateHeure));
  return { fiches, illisibles };
}

// D272 à D274 : par défaut, seulement les fiches pas encore passées en bilan (faites après le dernier bilan validé du salarié,
// ni annulé ni refusé ; salarié sans bilan : toutes) ; « tout » affiche aussi les autres ; recherche sur le nom
async function ecranListe(tout = false) {
  effacerAlerte();
  tout = tout === true;
  let fiches = [], illisibles = 0, bilans = [];
  try { ({ fiches, illisibles } = await calculerFiches()); }
  catch (e) { alerte("Impossible de lire les fiches de cet appareil : " + e.message); }
  try { bilans = await calculerBilans(); }
  catch (e) { alerte("Impossible de lire les bilans de cet appareil : " + e.message); }
  const dernierBilan = {}; // le plus récent bilan de chaque salarié (ni annulé ni refusé)
  for (const b of bilans) if (!b.refuse && (!dernierBilan[b.salarie.code] || b.dateHeure > dernierBilan[b.salarie.code].dateHeure)) dernierBilan[b.salarie.code] = b;
  const passee = (f) => !!dernierBilan[f.salarie.code] && !apresBilan(f, dernierBilan[f.salarie.code]); // D275 : même limite que les bilans
  const aVoir = fiches.filter((f) => !passee(f));
  const montrees = tout ? fiches : aVoir;
  const retour = () => ecranListe(tout);
  const lignes = montrees.map((f) => {
      const d = new Date(f.dateHeure);
      const pasEnvoyee = !f.recueDeGoogle && !f.envoyee && !f.refusee;
      return { s: f.salarie, e: el("button", { class: "carte liste-fiche", "data-fiche": f.id, onclick: () => ecranDetailFiche(f, retour) },
        el("strong", {}, `${f.guide.code} – ${f.salarie.code} ${f.salarie.prenom} ${f.salarie.nom}`), el("br"),
        `${dateFr(d)} à ${heureFr(d)} · par ${f.auteur.nom} · ${f.points.length} points`,
        passee(f) ? el("div", { class: "qui", "data-passee-bilan": "1" }, `Déjà passée en bilan (bilan du ${dateFr(new Date(dernierBilan[f.salarie.code].dateHeure))} ou avant)`) : null,
        pasEnvoyee ? el("div", { class: "note-permis", "data-pas-envoyee": "1" }, "Pas encore envoyée à Google.") : null,
        f.refusee ? el("div", { class: "note-permis", "data-refusee": "1" }, "Refusée par Google : " + f.refusee + ".") : null,
        f.heureDouteuse ? el("div", { class: "note-permis" }, "Heure douteuse : " + f.raisonsDoute.join(", ")) : null,
        f.douteuseGoogle ? el("div", { class: "note-permis" }, "À vérifier : " + f.douteuseGoogle) : null) };
    });
  afficher(
    el("div", { class: "barre" }, el("h1", {}, "Fiches"), el("button", { class: "petit", onclick: () => ecranAccueil() }, "Retour")),
    el("p", { class: "qui", "data-compte-fiches": String(montrees.length) }, tout
      ? `${fiches.length} fiche(s), toutes tablettes confondues, dont ${aVoir.length} pas encore passée(s) en bilan (selon le dernier échange avec Google).`
      : `${aVoir.length} fiche(s) pas encore passée(s) en bilan, toutes tablettes confondues (selon le dernier échange avec Google).`),
    illisibles ? el("p", { class: "note-permis", "data-illisibles": illisibles }, `${illisibles} fiche(s) reçue(s) incomplète(s), non affichée(s).`) : null,
    zoneRecherche(lignes),
    ...lignes.map((l) => l.e),
    el("button", { class: "gros", id: tout ? "fiches-a-voir" : "fiches-toutes", onclick: () => ecranListe(!tout) },
      tout ? "Ne voir que les fiches pas encore passées en bilan" : `Voir aussi les fiches déjà passées en bilan (${fiches.length - aVoir.length})`),
  );
}

// ---------- Étape 8a : tableau d'ensemble centré sur le salarié (D136, D137, D142, D143, D18) ----------
// Calculé à chaque affichage à partir des fiches, jamais enregistré (D18). Pour chaque guide : la fiche la plus récente
// (D38). « À faire » = tous les guides de ses activités pas encore évalués (D143). Fiches refusées : jamais comptées.
function suiviSalarie(salarie, fiches) {
  const siennes = fiches.filter((f) => f.salarie.code === salarie.code && !f.refusee);
  return (salarie.activites || []).map((activite) => {
    const guides = etat.referentiel.guides.filter((g) => g.activite === activite).slice().sort((a, b) => comparerCodes(a.code, b.code));
    const lignes = guides.map((g) => {
      const faites = siennes.filter((f) => f.guide.code === g.code); // déjà triées de la plus récente à la plus ancienne
      return { guide: g, derniere: faites[0] || null, nombre: faites.length };
    });
    return { activite, lignes, faits: lignes.filter((l) => l.derniere).length, total: lignes.length };
  });
}
// D148 : guides évalués qui ne sont pas dans ses activités actuelles (par exemple une activité retirée de son dossier)
function autresGuidesEvalues(salarie, fiches) {
  const activites = new Set(salarie.activites || []);
  const parGuide = {};
  for (const f of fiches.filter((x) => x.salarie.code === salarie.code && !x.refusee)) {
    const g = etat.referentiel.guides.find((x) => x.code === f.guide.code);
    if (g && activites.has(g.activite)) continue;
    (parGuide[f.guide.code] = parGuide[f.guide.code] || []).push(f); // fiches déjà triées de la plus récente à la plus ancienne
  }
  return Object.values(parGuide).map((faites) => ({ guide: { code: faites[0].guide.code, titre: faites[0].guide.titre }, derniere: faites[0], nombre: faites.length }))
    .sort((a, b) => comparerCodes(a.guide.code, b.guide.code));
}

// ---------- Étape 9b : dates des bilans et alertes (D140, D141, D161 à D169, D18 : calculé, jamais enregistré) ----------
const ALERTE_BILAN_JOURS = 30;
const texteDate = (d) => { const deux = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${deux(d.getMonth() + 1)}-${deux(d.getDate())}`; };
const dateDuTexte = (t) => new Date(t + "T00:00:00");

// AAAA-MM-JJ + n mois ; un jour qui n'existe pas dans le mois d'arrivée devient le dernier jour du mois (31/12 + 2 mois = 28 ou 29/02)
function ajouterMois(t, n) {
  const [a, m, j] = t.split("-").map(Number);
  const total = (a * 12 + (m - 1)) + n, an = Math.floor(total / 12), mois = total - an * 12;
  const dernier = new Date(an, mois + 1, 0).getDate();
  return texteDate(new Date(an, mois, Math.min(j, dernier)));
}
const joursEntre = (a, b) => Math.round((dateDuTexte(b) - dateDuTexte(a)) / 86400000); // arrondi : changement d'heure (23 h ou 25 h)

// Calendrier d'un salarié : depart (début du comptage des guides) et date(k) = k-ième bilan (k = 0, 1, 2…)
function calendrierBilans(s) {
  const valable = (t) => /^\d{4}-\d{2}-\d{2}$/.test(t || "");
  if (s.date_retour) { // D166 : salarié revenu : 1 mois avant la fin du nouveau contrat, puis tous les 3 mois
    if (!valable(s.date_fin_contrat)) return { manque: "fin du contrat à indiquer" };
    // D169 : contrat très court (1 mois avant la fin tombe avant le retour) : 1 mois après le retour, puis tous les 3 mois
    if (ajouterMois(s.date_fin_contrat, -1) < s.date_retour)
      return { depart: s.date_retour, retour: true, date: (k) => ajouterMois(s.date_retour, 3 * k + 1) };
    return { depart: s.date_retour, retour: true, date: (k) => ajouterMois(s.date_fin_contrat, 3 * k - 1) };
  }
  if (!valable(s.date_entree)) return { manque: "date d'entrée à indiquer" };
  // D165 : entrée + 1 mois, + 3 mois, puis tous les 3 mois (+ 6, + 9…)
  return { depart: s.date_entree, date: (k) => ajouterMois(s.date_entree, k === 0 ? 1 : 3 * k) };
}

// Prochain bilan à partir d'aujourd'hui. D161 : en attendant l'étape 10, une date passée n'est plus le « prochain » dès le lendemain.
// D162 : « depuis » = date du bilan précédent prévu (ou le début du parcours). D141 : nombre de guides différents évalués depuis.
// D207 : après un bilan fait dans l'application, la date est celle choisie à ce bilan (D187) et l'alerte reste, « en retard »,
// tant qu'un nouveau bilan n'est pas fait (D161) ; les guides se comptent depuis ce bilan (D168 : le jour même n'en fait pas partie).
// D208 : sans aucun bilan dans l'application, prochaine date de la règle à partir d'aujourd'hui (jamais « en retard »).
function prochainBilan(s, fiches, aujourdhui = aujourdhuiLocal(), bilans = []) {
  const dernier = bilans.find((b) => b.salarie.code === s.code && !b.refuse && /^\d{4}-\d{2}-\d{2}$/.test(b.prochainBilan || ""));
  if (dernier) {
    const depuis = texteDate(new Date(dernier.dateHeure)), date = dernier.prochainBilan;
    const guides = new Set(fiches.filter((f) => f.salarie.code === s.code && !f.refusee && apresBilan(f, dernier)).map((f) => f.guide.code)); // D275
    return { date, jours: joursEntre(aujourdhui, date), depuis, debutParcours: false, bilanFait: true, guides: guides.size };
  }
  const cal = calendrierBilans(s);
  if (cal.manque) return { manque: cal.manque };
  let k = 0, depuis = cal.depart, date = cal.date(0);
  while (date < aujourdhui && k < 1000) { depuis = date; date = cal.date(++k); }
  const debutParcours = depuis === cal.depart;
  // D168 : une fiche du jour même d'un bilan compte pour la période qui se termine par ce bilan (donc « après » ce jour-là) ;
  // le jour de l'entrée ou du retour compte (D169 : jamais une fiche d'avant le retour)
  const dansPeriode = (jour) => debutParcours ? jour >= depuis : jour > depuis;
  const guides = new Set(fiches.filter((f) => f.salarie.code === s.code && !f.refusee && dansPeriode(texteDate(new Date(f.dateHeure))))
    .map((f) => f.guide.code));
  return { date, jours: joursEntre(aujourdhui, date), depuis, debutParcours, retour: !!cal.retour, guides: guides.size };
}

const quandBilan = (b) => b.jours < 0 ? `en retard de ${-b.jours} jour(s)` : b.jours === 0 ? "aujourd'hui" : b.jours === 1 ? "demain" : `dans ${b.jours} jours`;
const texteDepuis = (b) => `${b.guides} guide(s) évalué(s) depuis ${b.bilanFait ? "le bilan du " + dateFr(dateDuTexte(b.depuis))
  : !b.debutParcours ? "le bilan prévu du " + dateFr(dateDuTexte(b.depuis))
  : b.retour ? "son retour le " + dateFr(dateDuTexte(b.depuis)) : "le début du parcours"}`; // D167
const texteProchain = (b) => b.manque ? `Prochain bilan : inconnu (${b.manque})`
  : `Prochain bilan : ${dateFr(dateDuTexte(b.date))} (${quandBilan(b)}) · ${texteDepuis(b)}`;

// salariés présents classés du bilan le plus proche au plus lointain ; ceux sans date en dernier (D163)
function salariesParBilan(fiches, bilans = []) {
  return etat.salaries.map((s) => ({ s, b: prochainBilan(s, fiches, aujourdhuiLocal(), bilans) }))
    .sort((x, y) => (x.b.manque ? 1 : 0) - (y.b.manque ? 1 : 0) || (x.b.date || "").localeCompare(y.b.date || "") || comparerCodes(x.s.code, y.s.code));
}

// D140, D164 : encadré de l'accueil, vu par tout le monde ; rien si aucun bilan dans les 30 jours
function blocBilansProches(fiches, bilans = []) {
  const proches = salariesParBilan(fiches, bilans).filter((x) => !x.b.manque && x.b.jours <= ALERTE_BILAN_JOURS);
  if (!proches.length) return null;
  return el("div", { class: "carte bilans-proches", "data-bilans": "1" },
    el("h2", {}, `Bilans dans les ${ALERTE_BILAN_JOURS} jours : ${proches.length}`),
    ...proches.map(({ s, b }) => el("button", { class: "liste-fiche ligne-bilan" + (b.jours < 0 ? " bilan-retard" : ""), "data-bilan": s.code, onclick: () => ecranSalarie(s, () => ecranAccueil()) },
      el("strong", {}, nomSalarie(s)), ` – bilan le ${dateFr(dateDuTexte(b.date))} (${quandBilan(b)})`, el("br"),
      el("span", { class: "qui" }, texteDepuis(b)))));
}

async function ecranSuivi() {
  effacerAlerte();
  let fiches = [];
  try { ({ fiches } = await calculerFiches()); }
  catch (e) { alerte("Impossible de lire les fiches de cet appareil : " + e.message); }
  let bilansFaits = [];
  try { bilansFaits = await calculerBilans(); } catch (e) { alerte("Impossible de lire les bilans de cet appareil : " + e.message); }
  const classes = salariesParBilan(fiches, bilansFaits); // les salariés sortis n'y sont pas (D137) ; classés par prochain bilan (D163)
  afficher(
    el("div", { class: "barre" }, el("h1", {}, "Suivi des salariés"), el("button", { class: "petit", onclick: () => ecranAccueil() }, "Retour")),
    el("p", { class: "qui" }, `${classes.length} salarié(s) présent(s), du bilan le plus proche au plus lointain. Touchez un salarié pour voir ses guides (selon le dernier échange avec Google).`),
    ...classes.map(({ s, b }) => el("button", { class: "carte liste-fiche" + (!b.manque && b.jours <= ALERTE_BILAN_JOURS ? " bilan-proche" : "") + (!b.manque && b.jours < 0 ? " bilan-retard" : ""),
      "data-salarie": s.code, onclick: () => ecranSalarie(s) },
      el("strong", {}, nomSalarie(s)),
      el("div", { class: "prochain-bilan", "data-prochain": b.manque ? "inconnu" : b.date }, texteProchain(b)),
      ...suiviSalarie(s, fiches).map((a) => el("div", { class: "qui", "data-activite": a.activite }, `${a.activite} : ${a.faits} / ${a.total}`)),
      autresGuidesEvalues(s, fiches).length ? el("div", { class: "qui", "data-autres": "1" }, `Autres guides évalués : ${autresGuidesEvalues(s, fiches).length}`) : null)),
  );
}

async function ecranSalarie(salarie, retourEcran = ecranSuivi) {
  effacerAlerte();
  let fiches = [];
  try { ({ fiches } = await calculerFiches()); }
  catch (e) { alerte("Impossible de lire les fiches de cet appareil : " + e.message); }
  const retour = () => ecranSalarie(salarie, retourEcran);
  let bilansFaits = [];
  try { bilansFaits = await calculerBilans(); } catch (e) { alerte("Impossible de lire les bilans de cet appareil : " + e.message); }
  const bilan = prochainBilan(salarie, fiches, aujourdhuiLocal(), bilansFaits);
  const siens = bilansFaits.filter((b) => b.salarie.code === salarie.code);
  const aEvaluer = pointsAEvaluer(siens.find((b) => !b.refuse), fiches);
  const autres = autresGuidesEvalues(salarie, fiches);
  const ligne = (l) => {
    if (!l.derniere) return el("div", { class: "ligne-guide a-faire", "data-guide": l.guide.code },
      el("span", { class: "code" }, l.guide.code), el("span", { class: "titre-guide" }, l.guide.titre), el("span", { class: "etat-guide" }, "à faire"));
    const f = l.derniere, d = new Date(f.dateHeure);
    return el("button", { class: "ligne-guide fait", "data-guide": l.guide.code, onclick: () => ecranDetailFiche(f, retour) },
      el("span", { class: "code" }, l.guide.code), el("span", { class: "titre-guide" }, l.guide.titre),
      el("span", { class: "etat-guide" }, dateFr(d) + (f.heureDouteuse || f.douteuseGoogle ? " (à vérifier)" : "")
        + (l.nombre > 1 ? ` · ${l.nombre} évaluations` : "")));
  };
  afficher(
    el("div", { class: "barre" }, el("h1", {}, nomSalarie(salarie)), el("button", { class: "petit", onclick: () => retourEcran() }, "Retour")),
    el("p", { class: "qui" }, `Entré(e) le ${salarie.date_entree ? dateFr(new Date(salarie.date_entree + "T00:00:00")) : "—"} · Permis : ${salarie.permis ? "oui" : "non"}`),
    el("p", { class: "prochain-bilan" + (!bilan.manque && bilan.jours <= ALERTE_BILAN_JOURS ? " bilan-proche" : "") + (!bilan.manque && bilan.jours < 0 ? " bilan-retard" : ""), "data-prochain": bilan.manque ? "inconnu" : bilan.date },
      texteProchain(bilan)),
    ROLES_SECOURS.includes(etat.personne.role)
      ? el("button", { class: "gros principal", id: "faire-bilan", onclick: () => nouveauBilan(salarie, retour) }, "Faire un bilan") : null,
    ROLES_SECOURS.includes(etat.personne.role) // D216
      ? el("button", { class: "gros", id: "imprimer-livret", onclick: () => ecranLivret(salarie, retour) }, "Imprimer le livret") : null,
    el("button", { class: "gros", id: "voir-evolution", onclick: () => ecranEvolution(salarie, retour) }, "Voir son évolution"), // D246
    ROLES_SECOURS.includes(etat.personne.role) // D260
      ? el("button", { class: "gros", id: "imprimer-fiches", onclick: () => ecranImprimerFiches(
        fiches.filter((f) => f.salarie.code === salarie.code && !f.refusee).reverse(), "Fiches de " + nomSalarie(salarie), retour) }, "Imprimer toutes ses fiches") : null,
    ROLES_SECOURS.includes(etat.personne.role) // D262
      ? el("button", { class: "gros", id: "imprimer-preparation", onclick: () => ecranPreparationBilan(salarie, bilan, retour) }, "Imprimer la préparation du bilan") : null,
    siens.length ? el("h2", { "data-bilans-salarie": "1" }, `Bilans : ${siens.length}`) : null,
    siens.length ? el("div", { class: "carte" }, ...siens.map((b) => el("button", { class: "ligne-guide fait", "data-bilan-lu": b.id, onclick: () => ecranLireBilan(b, retour) },
      el("span", { class: "titre-guide" }, `Bilan du ${dateFr(new Date(b.dateHeure))}`),
      el("span", { class: "etat-guide" }, b.refuse ? `refusé par Google (${b.refuse})` : b.envoye ? "" : "pas encore envoyé")))) : null,
    aEvaluer.length ? el("div", { class: "carte note-permis", "data-a-evaluer": "1" },
      el("strong", {}, `À évaluer avant le prochain bilan : ${aEvaluer.length} point(s)`), el("br"),
      `Pas évalués pendant la période du dernier bilan (D194) : ${aEvaluer.join(", ")}.`) : null,
    ...suiviSalarie(salarie, fiches).flatMap((a) => [
      el("h2", { "data-activite": a.activite }, `${a.activite} : ${a.faits} / ${a.total} guides évalués`),
      el("div", { class: "carte" }, ...a.lignes.map(ligne)),
    ]),
    ...(autres.length ? [el("h2", { "data-autres": "1" }, `Autres guides évalués : ${autres.length}`),
      el("p", { class: "qui" }, "Guides qui ne sont pas dans ses activités actuelles (par exemple une activité retirée de son dossier)."),
      el("div", { class: "carte" }, ...autres.map(ligne))] : []),
  );
}

// ---------- Étape 10b : bilan pas fini gardé sur la tablette (D195), une seule fois par personne ----------
const CLE_BILAN_EN_COURS = "bilan-en-cours-";
let minuterieBilan = null;
async function ecrireBilanEnCours(b, personne) {
  if (b.enregistrementEnCours) return; // jamais recréé pendant ou après la validation
  const { salarie, retour, enregistrementEnCours, ...garde } = b; // (la fonction « retour » ne se garde pas)
  try { await ecrire("reglages", { cle: CLE_BILAN_EN_COURS + personne.id, bilan: { ...garde, salarieCode: salarie.code } }); }
  catch (e) { alerte("Attention : le bilan en cours n'a pas pu être gardé sur la tablette (" + e.message + ")."); }
}
function sauverBilan() {
  clearTimeout(minuterieBilan);
  const b = etat.bilan, personne = etat.personne;
  if (!b || !personne || b.enregistrementEnCours) return;
  minuterieBilan = setTimeout(() => ecrireBilanEnCours(b, personne), 300);
}
function reprendreBilan(garde, salarie) {
  etat.bilan = { ...garde, salarie, retour: () => ecranAccueil() };
  ecranBilan("Bilan repris. Les couleurs proposées sont celles du moment où le bilan a été commencé. Vérifiez les signatures avant de valider.");
}
async function oublierBilanEnCours() {
  clearTimeout(minuterieBilan);
  try { await supprimer("reglages", CLE_BILAN_EN_COURS + etat.personne.id); return ""; }
  catch (e) { return " Attention : le bilan en cours n'a pas pu être retiré de la tablette (" + e.message + ")."; }
}

// ---------- Étape 10a : faire, valider et lire un bilan (cahier §4.3 ; D18, D31, D36, D41, D42, D149, D184, D186 à D199) ----------
// La proposition (dernière couleur de l'encadrant sur la période) est calculée, jamais enregistrée (D18) ; seule la couleur
// définitive l'est. La règle des comportements se calcule sur les couleurs définitives et n'est pas enregistrée non plus.
const COMPORTEMENTS_OBLIGATOIRES = ["1.1", "1.4", "1.5", "1.7"], COMPORTEMENTS_SEUIL = 11; // référentiel d'AGACI, regle_comportements
const POINTS_NOTES_AU_BILAN = ["C18", "C30", "C33"]; // D31 (espaces verts)
const estComportement = (code) => /^1\.\d+$/.test(code);

// Bilans : reçus de Google + ceux de cet appareil pas encore acceptés (sauf refusés), du plus récent au plus ancien
async function calculerBilans() {
  const journal = await lireTout("journal"), envois = await lireTout("envois");
  const annules = await idsAnnules(journal); // D185 : un bilan annulé disparaît, comme une fiche (D74)
  const effaces = new Set(journal.filter((l) => l.type === "effacement").map((l) => l.salarie));
  const parId = {};
  for (const l of journal) if (l.type === "bilan" && l.contenu) parId[l.id] = { ...l.contenu, envoye: true };
  for (const e of envois) if (e.ev.type === "bilan" && !parId[e.id]) parId[e.id] = { ...e.ev.contenu, envoye: false, refuse: e.etat === "refuse" ? e.raison || "refusé" : "" };
  // un bilan refusé par Google reste affiché « refusé » (règle 18), mais ne compte ni pour la période ni pour le rappel
  return Object.values(parId).filter((b) => b.salarie && b.dateHeure && Array.isArray(b.points) && !effaces.has(b.salarie.code) && !annules.has(b.id))
    .sort((a, b) => b.dateHeure.localeCompare(a.dateHeure));
}

// D205 : seuls les points présents dans au moins un guide peuvent être évalués par une fiche (les autres se notent au bilan)
const pointsEvaluablesParFiche = () => new Set(etat.referentiel.guides.flatMap((g) => [...g.codes_metier, ...g.codes_competences_cles]));
const TAILLE_MAX_BILAN = 250000;
const LARGEUR_SIGNATURE_BILAN = 400; // pixels (D204) // le programme Google refuse au-delà de 270 000 caractères (6 cellules)

// D194, D203 : les points « pas évalués » et restés sans couleur au dernier bilan, tant qu'aucune fiche ne les a évalués depuis
function pointsAEvaluer(dernier, fiches) {
  if (!dernier) return [];
  const evalues = new Set(fiches.filter((f) => f.salarie.code === dernier.salarie.code && !f.refusee && apresBilan(f, dernier)) // D275
    .flatMap((f) => f.points.filter((p) => p.encadrant && p.encadrant !== "nc").map((p) => p.code)));
  return dernier.points.filter((p) => p.pasEvalue && !p.definitive && !evalues.has(p.code)).map((p) => p.code);
}

// Les points du bilan, dans l'ordre de D42 : comportements, compétences clés et métier des guides de ses activités, accompagnement
function pointsDuBilan(salarie) {
  const ref = etat.referentiel, guides = ref.guides.filter((g) => (salarie.activites || []).includes(g.activite));
  const groupes = [];
  const point = (code, groupe) => {
    const p = etat.points[code];
    if (!p) return null;
    const bloque = !salarie.permis && estPointPermis(p.libelle); // D13, D188
    return { code, libelle: p.libelle, groupe, bloquePermis: bloque };
  };
  const ajouter = (titre, codes) => {
    const liste = [...new Set(codes)].sort(comparerCodes).map((c) => point(c, titre)).filter(Boolean);
    if (liste.length) groupes.push({ titre, points: liste });
  };
  ajouter("Comportements (domaine 1)", ref.points.filter((p) => estComportement(p.code)).map((p) => p.code));
  ajouter("Compétences clés (domaines 2 à 9)", guides.flatMap((g) => g.codes_competences_cles).filter((c) => !estComportement(c)));
  for (const a of salarie.activites || []) {
    const codes = guides.filter((g) => g.activite === a).flatMap((g) => g.codes_metier);
    if (a === "Espaces verts") codes.push(...POINTS_NOTES_AU_BILAN.filter((c) => etat.points[c])); // D31
    ajouter("Métier – " + a, codes); // D193 : C20 puis C20.c1 à C20.c6 (ordre des codes)
  }
  ajouter("Accompagnement socioprofessionnel", ref.points.filter((p) => /^ASP/.test(p.code)).map((p) => p.code)); // D199
  return groupes;
}

// D275 (remplace la règle du jour de D168 après un bilan fait) : la limite d'un bilan est le moment où il a été COMMENCÉ ;
// une fiche faite avant compte dans ce bilan, une fiche faite à partir de ce moment compte pour le suivant.
// Bilans faits avant cette règle (sans « debutBilan ») : l'heure de leur validation.
const limiteBilan = (b) => b.debutBilan || b.dateHeure;
const apresBilan = (f, b) => f.dateHeure >= limiteBilan(b);

// Période : depuis le début du dernier bilan (D275) ou depuis la date d'entrée (comprise, D186) jusqu'à aujourd'hui
function periodeBilan(salarie, bilans) {
  const dernier = bilans.find((b) => b.salarie.code === salarie.code && !b.refuse);
  return dernier ? { debut: texteDate(new Date(dernier.dateHeure)), debutCompris: false, precedent: dernier.id, limite: limiteBilan(dernier) }
    : { debut: salarie.date_entree || "", debutCompris: true, precedent: null };
}

// D149 : proposition = dernière couleur de l'encadrant sur la période, en sautant « Non concerné » ; jamais une fiche refusée
// (les fiches annulées sont déjà retirées par calculerFiches, P129)
function propositionsBilan(salarie, fiches, periode) {
  const dans = (f) => periode.limite ? f.dateHeure >= periode.limite // D275
    : !periode.debut || (periode.debutCompris ? texteDate(new Date(f.dateHeure)) >= periode.debut : texteDate(new Date(f.dateHeure)) > periode.debut);
  const res = {};
  for (const f of fiches) { // de la plus récente à la plus ancienne
    if (f.salarie.code !== salarie.code || f.refusee || !dans(f)) continue;
    for (const p of f.points) if (p.encadrant && p.encadrant !== "nc" && !res[p.code]) res[p.code] = { v: p.encadrant, date: f.dateHeure, guide: f.guide.code };
  }
  return res;
}

// D209, D210 : couleurs du bilan précédent (dernier bilan du salarié avant « avant », ni annulé ni refusé ; jamais « Non concerné »)
function couleursBilanPrecedent(salarieCode, bilans, avant = null) {
  const prec = bilans.find((b) => b.salarie.code === salarieCode && !b.refuse && (!avant || b.dateHeure < avant));
  const res = {};
  if (prec) for (const p of prec.points) if (p.definitive && p.definitive !== "nc") res[p.code] = { v: p.definitive, date: prec.dateHeure };
  return res;
}
const blocBilanPrecedent = (pr, code) => pr ? el("div", { class: "precedent", "data-bilan-precedent": pr.v, "data-point": code },
  el("span", { class: "avis-lecture", "data-v": pr.v }, "Bilan précédent : " + nomAvis("encadrant", pr.v)),
  el("div", { class: "qui" }, dateFr(new Date(pr.date)))) : null;

// Règle des comportements (cahier §4.3) sur les couleurs définitives
function regleComportements(points) {
  const comp = points.filter((p) => estComportement(p.code));
  const bons = comp.filter((p) => p.definitive === "orange" || p.definitive === "vert");
  const obligManquants = COMPORTEMENTS_OBLIGATOIRES.filter((c) => !bons.some((p) => p.code === c));
  return { acquis: bons.length >= COMPORTEMENTS_SEUIL && !obligManquants.length, bons: bons.length, total: comp.length, obligManquants };
}
const texteRegle = (r) => r.acquis ? `Comportements : ACQUIS (${r.bons} sur ${r.total} en orange ou vert, dont 1.1, 1.4, 1.5 et 1.7)`
  : `Comportements : pas encore acquis (${r.bons} sur ${r.total} en orange ou vert ; il en faut ${COMPORTEMENTS_SEUIL}`
    + (r.obligManquants.length ? ` ; obligatoires pas en orange ou vert : ${r.obligManquants.join(", ")}` : "") + ")";

async function nouveauBilan(salarie, retour) {
  try {
    const encours = await lire("reglages", CLE_BILAN_EN_COURS + etat.personne.id);
    if (encours && !confirm(`Un bilan est déjà en cours (${encours.bilan.salarieCode}). Le remplacer par un nouveau bilan pour ${salarie.code} ? Ce qui a été saisi sera perdu.`)) return;
  } catch (e) { return alerte("Impossible de lire la tablette : " + e.message); }
  let fiches = [], bilans = [];
  try { ({ fiches } = await calculerFiches()); bilans = await calculerBilans(); }
  catch (e) { return alerte("Impossible de lire les fiches de cet appareil : " + e.message); }
  const periode = periodeBilan(salarie, bilans), props = propositionsBilan(salarie, fiches, periode);
  const groupes = pointsDuBilan(salarie), evaluables = pointsEvaluablesParFiche();
  const precedent = couleursBilanPrecedent(salarie.code, bilans); // D209
  for (const g of groupes) for (const p of g.points) {
    const pr = props[p.code];
    p.bilanPrecedent = precedent[p.code] || null;
    p.proposition = pr ? pr.v : null; p.propositionDe = pr ? { date: pr.date, guide: pr.guide } : null;
    p.definitive = p.bloquePermis ? "nc" : p.proposition; // D197 : la proposition est déjà cochée
    p.auBilanSeulement = !evaluables.has(p.code); // D205
    p.pasEvalue = !pr && !p.bloquePermis && !p.auBilanSeulement; // D194, D198
  }
  const demain = texteDate(new Date(Date.now() + 86400000));
  const prochain = prochainBilan(salarie, [], demain); // D187 : date proposée par la règle (D165, D166), modifiable
  const dernier = bilans.find((x) => x.salarie.code === salarie.code && !x.refuse);
  const guidesAFaire = suiviSalarie(salarie, fiches).flatMap((a) => a.lignes.filter((l) => !l.derniere).map((l) => l.guide.code)); // D238
  etat.bilan = {
    salarie, groupes, periode, retour, participants: [], prochain: prochain.manque ? "" : prochain.date,
    signatures: {}, debut: new Date().toISOString(),
    // D239 : objectifs de ce bilan, et suivi de ceux du bilan précédent
    objectifs: [0, 1, 2].map(() => ({ objectif: "", comment: "", avecQui: "", pourQuand: "" })), objectifsASP: "",
    suivi: ((dernier && dernier.objectifs) || []).map((o) => ({ ...o, statut: null })), guidesAFaire,
    avisSalarie: avisSalarieVide(), // D267
  };
  sauverBilan();
  ecranBilan();
}

const participantsPossibles = () => etat.personnes.filter((p) => p.id !== etat.personne.id && ["encadrant", "accompagnatrice", "direction"].includes(p.role));
const nomRole = { encadrant: "encadrant", accompagnatrice: "accompagnatrice", direction: "direction" };

// D98 (même règle que la fiche) : si le bilan change après une signature, toutes les signatures sont effacées
function invaliderSignaturesBilan() {
  const b = etat.bilan;
  const encre = Object.values(zonesSignature).some((z) => z.encre() > 0);
  if (!Object.values(b.signatures).some(Boolean) && !encre) return;
  Object.values(zonesSignature).forEach((z) => z.vider());
  alerte("Le bilan a changé après les signatures : les signatures ont été effacées. Faites signer à nouveau.");
}

function ecranBilan(messageOk) {
  viderZonesSignature();
  const b = etat.bilan, s = b.salarie;
  if (!b.avisSalarie) b.avisSalarie = avisSalarieVide(); // bilan commencé avec une version d'avant (D267)
  const tous = b.groupes.flatMap((g) => g.points);
  const regle = el("p", { class: "carte regle-comportements", id: "regle-comportements" });
  const majRegle = () => { const r = regleComportements(tous); regle.textContent = texteRegle(r); regle.dataset.acquis = r.acquis ? "1" : "0"; };
  const pastilles = (p) => {
    const conteneur = el("div", { class: "pastilles" });
    const dessiner = () => conteneur.replaceChildren(...ECHELLE.filter((n) => n.v !== "nc" || p.bloquePermis).map((n) => {
      const choisi = p.definitive === n.v;
      return el("button", { class: "pastille" + (choisi ? " choisie" : p.definitive ? " attenuee" : ""), "data-v": n.v, "data-point": p.code,
        "aria-pressed": choisi ? "true" : "false", disabled: p.bloquePermis,
        onclick: () => { if (choisi) return; p.definitive = n.v; dessiner(); majRegle(); rafraichirPistes(); invaliderSignaturesBilan(); sauverBilan(); } }, n.encadrant); // D202
    }));
    dessiner();
    return conteneur;
  };
  const carte = (p) => el("div", { class: "carte", id: "bilan-point-" + p.code, "data-point-bilan": p.code },
    el("div", {}, el("span", { class: "code" }, p.code), p.libelle),
    p.bloquePermis ? el("div", { class: "note-permis" }, "Le salarié n'a pas le permis : point « Non concerné ».")
      : p.proposition ? el("div", { class: "qui", "data-proposition": p.proposition },
        `Proposé : ${nomAvis("encadrant", p.proposition)} (${dateFr(new Date(p.propositionDe.date))} · ${p.propositionDe.guide})`)
      : p.auBilanSeulement ? el("div", { class: "qui", "data-au-bilan": "1" }, "Se note au bilan (aucune fiche ne l'évalue)")
      : el("div", { class: "qui pas-evalue", "data-pas-evalue": "1" }, "Pas évalué cette période (à évaluer avant le prochain bilan)"),
    el("div", { class: "ligne-avis" }, pastilles(p), blocBilanPrecedent(p.bilanPrecedent, p.code)), // D209
    /^ASP/.test(p.code) ? el("div", { class: "avis-salarie-asp" }, el("span", { class: "qui" }, "Avis du salarié (feuille de préparation) :"),
      boutonsAvisSalarie(b.avisSalarie.asp[p.code], (v) => { b.avisSalarie.asp[p.code] = v; }, "asp-" + p.code)) : null); // D267
  const echange = etat.echange.derniere;
  const ancien = !echange || Date.now() - echange.getTime() > 3600 * 1000; // conception §4
  const cases = participantsPossibles().map((p) => {
    const c = el("input", { type: "checkbox", "data-participant": p.id }); c.checked = b.participants.includes(p.id);
    c.addEventListener("change", () => {
      b.participants = c.checked ? [...b.participants, p.id] : b.participants.filter((x) => x !== p.id);
      invaliderSignaturesBilan(); sauverBilan(); ecranBilan(); // les zones de signature suivent les participants
    });
    return el("label", { class: "case" }, c, ` ${p.nom} (${nomRole[p.role]})`);
  });
  const prochain = el("input", { id: "bilan-prochain", type: "date", class: "champ" }); prochain.value = b.prochain;
  prochain.addEventListener("change", () => { b.prochain = prochain.value; invaliderSignaturesBilan(); sauverBilan(); });
  const qui = (id) => etat.personnes.find((p) => p.id === id);
  const signataires = [etat.personne.id, ...b.participants].map(qui).filter(Boolean);
  afficher(
    el("div", { class: "barre" }, el("h1", {}, "Bilan – " + nomSalarie(s)),
      el("button", { class: "petit", onclick: async () => {
        clearTimeout(minuterieBilan); await ecrireBilanEnCours(b, etat.personne); // gardé tout de suite, avant de quitter
        etat.bilan = null; ecranAccueil("Le bilan reste en cours sur cette tablette : « Reprendre le bilan en cours » sur l'accueil.");
      } }, "Accueil (le bilan reste en cours)")),
    el("p", { class: "qui" }, `Période : ${b.periode.debut ? (b.periode.debutCompris ? "depuis l'entrée le " : "depuis le bilan du ") + dateFr(dateDuTexte(b.periode.debut)) : "début inconnu"} jusqu'à aujourd'hui · Fait par : ${etat.personne.nom}`),
    ancien ? el("p", { class: "note-permis", "data-echange-ancien": "1" },
      "Attention : cette tablette n'a pas échangé avec Google depuis plus d'une heure. Des fiches d'autres tablettes peuvent manquer. Touchez « Mettre à jour maintenant » sur l'accueil si le Wifi est là.") : null,
    el("div", { class: "carte bloc-champ" }, el("strong", {}, "Participants (cochez les personnes présentes ; il faut au moins un encadrant et l'accompagnatrice)"), ...cases),
    regle,
    ...b.groupes.flatMap((g) => [el("h2", {}, g.titre), ...g.points.map(carte)]),
    ...blocAvisSalarie(b),
    ...blocObjectifsBilan(b),
    el("label", { class: "carte bloc-champ" }, el("strong", {}, "Date du prochain bilan (proposée, modifiable)"), prochain),
    ...signataires.map((p) => zoneSignature("bilan-" + p.id, () => etat.bilan && etat.bilan.signatures, sauverBilan, `Signature : ${p.nom} (${nomRole[p.role]})`, LARGEUR_SIGNATURE_BILAN)),
    zoneSignature("bilan-salarie", () => etat.bilan && etat.bilan.signatures, sauverBilan, "Signature du salarié : " + nomSalarie(s), LARGEUR_SIGNATURE_BILAN),
    el("button", { class: "gros principal", id: "valider-bilan", onclick: validerBilan }, "Valider le bilan"),
  );
  majRegle();
  if (messageOk) alerte(messageOk, true);
}

async function validerBilan() {
  const b = etat.bilan;
  if (!b || b.enregistrementEnCours) return; // un double appui n'enregistre qu'un bilan
  document.querySelectorAll(".manque").forEach((e) => e.classList.remove("manque"));
  const qui = (id) => etat.personnes.find((p) => p.id === id);
  const presents = [etat.personne, ...b.participants.map(qui).filter(Boolean)];
  const manques = [];
  if (!presents.some((p) => p.role === "encadrant")) manques.push("au moins un encadrant parmi les participants");
  if (!presents.some((p) => p.role === "accompagnatrice")) manques.push("l'accompagnatrice parmi les participants");
  const demain = texteDate(new Date(Date.now() + 86400000));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.prochain || "") || b.prochain < demain) manques.push("une date de prochain bilan après aujourd'hui");
  (b.objectifs || []).forEach((o, i) => { if (!o.objectif.trim() && (o.comment.trim() || o.avecQui.trim() || o.pourQuand)) manques.push(`le texte de l'objectif ${i + 1}`); });
  const sansSignature = [...presents.map((p) => "bilan-" + p.id), "bilan-salarie"].filter((k) => !b.signatures[k]);
  if (sansSignature.length) manques.push(`${sansSignature.length} signature(s)`);
  if (manques.length) {
    sansSignature.forEach((k) => document.getElementById("signature-" + k)?.classList.add("manque"));
    return alerte("Bilan pas encore validé. Il manque : " + manques.join(", ") + ".");
  }
  b.enregistrementEnCours = true;
  const bouton = document.getElementById("valider-bilan");
  if (bouton) { bouton.disabled = true; bouton.textContent = "Enregistrement…"; }
  const maintenant = new Date(), s = b.salarie;
  let bilan;
  try {
    const appareil = await numeroAppareil();
    bilan = {
      id: `${appareil}-B${hexAleatoire(6)}`, appareil, dateHeure: maintenant.toISOString(),
      auteur: { id: etat.personne.id, nom: etat.personne.nom, role: etat.personne.role },
      participants: presents.map((p) => ({ id: p.id, nom: p.nom, role: p.role })),
      salarie: { code: s.code, nom: s.nom, prenom: s.prenom, permis: !!s.permis },
      periode: { debut: b.periode.debut, debutCompris: b.periode.debutCompris, fin: texteDate(maintenant), precedent: b.periode.precedent, limite: b.periode.limite || null },
      debutBilan: b.debut || maintenant.toISOString(), // D275 : limite entre ce bilan et le suivant
      // seule la couleur définitive est enregistrée (D18) ; « pasEvalue » sert au rappel D194
      points: b.groupes.flatMap((g) => g.points.map((p) => ({ code: p.code, libelle: p.libelle, groupe: g.titre, definitive: p.definitive || null, pasEvalue: p.pasEvalue }))),
      prochainBilan: b.prochain, signatures: b.signatures,
      // D239, D241 : 0 à 3 objectifs ; suivi de ceux du bilan précédent
      objectifs: (b.objectifs || []).filter((o) => o.objectif.trim()).map((o) => ({ objectif: o.objectif.trim(), comment: o.comment.trim(), avecQui: o.avecQui.trim(), pourQuand: o.pourQuand })),
      objectifsASP: (b.objectifsASP || "").trim(),
      suiviObjectifs: (b.suivi || []).map((o) => ({ objectif: o.objectif, statut: o.statut || null })),
      avisSalarie: avisSalarieAEnregistrer(b.avisSalarie), // D267 : null si rien n'a été recopié
    };
    const ev = { id: bilan.id, type: "bilan", date_action: bilan.dateHeure, personne: etat.personne.id, salarie: s.code, objet: bilan.id, contenu: bilan };
    const taille = JSON.stringify(bilan).length;
    if (taille > TAILLE_MAX_BILAN) { // D204 : rien n'est enregistré, rien n'est perdu à l'écran
      b.enregistrementEnCours = false;
      if (bouton) { bouton.disabled = false; bouton.textContent = "Valider le bilan"; }
      return alerte(`Bilan pas encore validé : il est trop lourd pour Google (${taille} caractères, au plus ${TAILLE_MAX_BILAN}), à cause des signatures. Touchez « Effacer la signature » sur la plus chargée et faites-la plus simplement, puis validez à nouveau.`);
    }
    await ecrire("envois", { id: ev.id, etat: "a_envoyer", ev });
    if (!(await lire("envois", ev.id))) throw new Error("le bilan relu est vide");
    await ecrire("reglages", { cle: "bilan-local-" + bilan.id, bilan }); // D221 : copie complète, pour le renvoyer après une restauration
  } catch (e) {
    b.enregistrementEnCours = false;
    if (bouton) { bouton.disabled = false; bouton.textContent = "Valider le bilan"; }
    return alerte("ÉCHEC : le bilan n'a pas pu être enregistré sur cet appareil (" + e.message + "). Ne fermez pas l'application.");
  }
  etat.bilan = null;
  const messageOubli = await oublierBilanEnCours();
  await b.retour();
  alerte(`Bilan enregistré sur cet appareil (${nomSalarie(s)}, ${dateFr(maintenant)} à ${heureFr(maintenant)}). Il sera envoyé à Google au retour du Wifi.` + messageOubli, true);
  synchroniser();
}

// ---------- Étape 10c : objectifs au bilan et fiche d'entretien préparée (D237 à D242) ----------
const RANG_COULEUR = { bleu: 1, rose: 2, orange: 3, vert: 4 };
const STATUTS_OBJECTIF = [["atteint", "Atteint"], ["en-partie", "En partie"], ["pas-atteint", "Pas atteint"]];
const texteStatut = (v) => (STATUTS_OBJECTIF.find((x) => x[0] === v) || [null, "Non renseigné"])[1];

// D238 : pistes calculées à partir des couleurs du bilan (jamais enregistrées)
function pistesBilan(points, precedent, guidesAFaire = []) {
  const forts = points.filter((p) => p.definitive === "vert"
    || (precedent[p.code] && RANG_COULEUR[p.definitive] > RANG_COULEUR[precedent[p.code].v]));
  const aTravailler = points.filter((p) => p.definitive === "bleu" || p.definitive === "rose");
  const aEvaluer = points.filter((p) => p.pasEvalue && !p.definitive);
  return { forts, aTravailler, aEvaluer, guidesAFaire };
}
const listePoints = (liste, max = 8) => liste.length
  ? liste.slice(0, max).map((p) => `${p.code} ${p.libelle}`).join(" ; ") + (liste.length > max ? ` ; … et ${liste.length - max} autre(s)` : "") : "aucun";

// les pistes suivent les couleurs : recalculées à chaque couleur touchée
function contenuPistes(b) {
  const tous = b.groupes.flatMap((g) => g.points);
  const precedent = Object.fromEntries(tous.filter((p) => p.bilanPrecedent).map((p) => [p.code, p.bilanPrecedent]));
  const pistes = pistesBilan(tous, precedent, b.guidesAFaire || []);
  return [el("strong", {}, "Pistes pour l'entretien (une aide, rien n'est rempli tout seul)"),
    el("div", { "data-pistes-forts": "1" }, "Points forts (vert, ou en progrès depuis le bilan précédent) : " + listePoints(pistes.forts)),
    el("div", { "data-pistes-travailler": "1" }, "À travailler (bleu ou rose) : " + listePoints(pistes.aTravailler)),
    el("div", {}, "Pas évalués cette période : " + listePoints(pistes.aEvaluer)),
    el("div", {}, "Guides pas encore faits : " + (pistes.guidesAFaire.length ? pistes.guidesAFaire.join(", ") : "aucun"))];
}
function rafraichirPistes() {
  const zone = document.querySelector("[data-pistes]");
  if (zone && etat.bilan) zone.replaceChildren(...contenuPistes(etat.bilan));
}

function blocObjectifsBilan(b) {
  if (!b.objectifs) b.objectifs = [0, 1, 2].map(() => ({ objectif: "", comment: "", avecQui: "", pourQuand: "" })); // bilan commencé avec une version d'avant
  const change = () => { invaliderSignaturesBilan(); sauverBilan(); };
  const suivi = (b.suivi || []).map((o, i) => {
    const boutons = el("div", { class: "statuts" });
    const dessiner = () => boutons.replaceChildren(...STATUTS_OBJECTIF.map(([v, t]) => el("button", { class: "petit" + (o.statut === v ? " choisi" : ""),
      "data-statut": v, "data-suivi": String(i), "aria-pressed": o.statut === v ? "true" : "false",
      onclick: () => { if (o.statut === v) return; o.statut = v; dessiner(); change(); } }, t)));
    dessiner();
    return el("div", { class: "carte", "data-objectif-precedent": String(i) }, el("strong", {}, `${i + 1}. ${o.objectif}`),
      el("div", { class: "qui" }, [o.comment && "Comment : " + o.comment, o.avecQui && "Avec qui : " + o.avecQui, o.pourQuand && "Pour le " + dateFr(dateDuTexte(o.pourQuand))].filter(Boolean).join(" · ")), boutons);
  });
  const champ = (o, k, type = "text", etiquette) => {
    const c = el("input", { type, class: "champ", "data-objectif-champ": k });
    c.value = o[k] || ""; c.addEventListener("input", () => { o[k] = c.value; change(); });
    return el("label", {}, etiquette, c);
  };
  const lignes = (b.objectifs || []).map((o, i) => el("div", { class: "carte bloc-champ", "data-objectif": String(i) }, el("strong", {}, `Objectif ${i + 1}`),
    champ(o, "objectif", "text", "Objectif"), champ(o, "comment", "text", "Comment ? (guide, atelier, PMSMP…)"), champ(o, "avecQui", "text", "Avec qui ?"),
    champ(o, "pourQuand", "date", "Pour quand ?")));
  const asp = el("textarea", { id: "objectifs-asp" }); asp.value = b.objectifsASP || "";
  asp.addEventListener("input", () => { b.objectifsASP = asp.value; change(); });
  return [
    el("h2", {}, "Fin de bilan : objectifs"),
    suivi.length ? el("h3", {}, "Objectifs du bilan précédent : atteints ?") : null, ...suivi,
    el("div", { class: "carte pistes", "data-pistes": "1" }, ...contenuPistes(b)),
    el("p", { class: "qui" }, "Objectifs pour la prochaine période : 2 ou 3 au plus, pas obligatoires (D241)."),
    ...lignes,
    el("label", { class: "carte bloc-champ" }, el("strong", {}, "Objectifs en accompagnement socioprofessionnel"), asp),
  ];
}

// ---------- Étape 16 : avis du salarié recopié au bilan depuis la feuille de préparation (D267, Q77 : facultatif, avec le commentaire) ----------
const AVIS_SALARIE = ECHELLE.filter((n) => n.v !== "nc"); // Je ne sais pas faire… Je peux montrer aux autres
function avisSalarieVide() { return { questions: QUESTIONS_SALARIE.map(() => ({ v: null, commentaire: "" })), asp: {} }; }
function avisSalarieAEnregistrer(a) {
  if (!a) return null;
  const questions = QUESTIONS_SALARIE.map((q, i) => ({ question: q, v: (a.questions[i] || {}).v || null, commentaire: ((a.questions[i] || {}).commentaire || "").trim() }));
  const asp = Object.fromEntries(Object.entries(a.asp || {}).filter(([, v]) => v));
  return questions.some((x) => x.v || x.commentaire) || Object.keys(asp).length ? { questions, asp } : null;
}
// 4 boutons ; toucher de nouveau le bouton choisi le retire (l'avis est facultatif, Q77-1)
function boutonsAvisSalarie(valeur, choisir, cle) {
  const boite = el("div", { class: "avis-salarie", "data-avis-salarie-de": cle });
  const dessiner = (v) => boite.replaceChildren(...AVIS_SALARIE.map((n) => el("button", {
    class: "avis-salarie-bouton" + (v === n.v ? " choisi" : ""), "data-v": n.v, "aria-pressed": v === n.v ? "true" : "false",
    onclick: () => { const nv = v === n.v ? null : n.v; choisir(nv); dessiner(nv); invaliderSignaturesBilan(); sauverBilan(); } }, n.salarie)));
  dessiner(valeur || null);
  return boite;
}
function blocAvisSalarie(b) {
  const a = b.avisSalarie;
  return [
    el("h2", {}, "Avis du salarié (feuille de préparation)"),
    el("p", { class: "qui" }, "Recopiez ici la partie 1 de la feuille remplie par le salarié (facultatif). Son avis sur les points ASP se recopie sur chaque point ASP, plus haut."),
    ...QUESTIONS_SALARIE.map((q, i) => {
      const c = el("input", { type: "text", class: "champ", "data-avis-commentaire": String(i) });
      c.value = a.questions[i].commentaire || "";
      c.addEventListener("input", () => { a.questions[i].commentaire = c.value; invaliderSignaturesBilan(); sauverBilan(); });
      return el("div", { class: "carte", "data-avis-question": String(i) }, el("strong", {}, q),
        boutonsAvisSalarie(a.questions[i].v, (v) => { a.questions[i].v = v; }, "q" + i), el("label", {}, "Commentaire", c));
    }),
  ];
}
function blocAvisSalarieLu(bilan) {
  const a = bilan.avisSalarie;
  if (!a) return [el("h2", {}, "Avis du salarié"), el("p", { class: "qui", "data-avis-lu": "aucun" }, "Pas recopié à ce bilan.")];
  return [el("h2", {}, "Avis du salarié (feuille de préparation)"),
    ...a.questions.map((x, i) => el("div", { class: "carte", "data-avis-lu": String(i) }, `${x.question} : `, el("strong", {}, x.v ? nomAvis("salarie", x.v) : "—"),
      x.commentaire ? el("div", { class: "qui" }, "Commentaire : " + x.commentaire) : null))];
}

const blocObjectifsLus = (bilan) => [
  (bilan.suiviObjectifs || []).length ? el("h2", {}, "Objectifs du bilan précédent") : null,
  ...(bilan.suiviObjectifs || []).map((o, i) => el("div", { class: "carte", "data-suivi-lu": String(i) }, `${i + 1}. ${o.objectif} : `, el("strong", {}, texteStatut(o.statut)))),
  el("h2", {}, "Objectifs pour la prochaine période"),
  ...((bilan.objectifs || []).length ? bilan.objectifs.map((o, i) => el("div", { class: "carte", "data-objectif-lu": String(i) }, el("strong", {}, `${i + 1}. ${o.objectif}`),
    el("div", { class: "qui" }, [o.comment && "Comment : " + o.comment, o.avecQui && "Avec qui : " + o.avecQui, o.pourQuand && "Pour le " + dateFr(dateDuTexte(o.pourQuand))].filter(Boolean).join(" · "))))
    : [el("p", { class: "qui" }, "Aucun objectif noté à ce bilan.")]),
  bilan.objectifsASP ? el("div", { class: "carte" }, el("strong", {}, "Objectifs en accompagnement socioprofessionnel : "), bilan.objectifsASP) : null,
];

// D237, D240 : fiche d'entretien trimestriel 4.2.18.5 préparée à partir du bilan (partie 1 vierge, remplie par le salarié)
const QUESTIONS_SALARIE = ["Je respecte les horaires et je suis présent", "J'applique les consignes et les règles de sécurité", "Je porte mes équipements de protection (EPI)",
  "Je travaille bien en équipe", "J'utilise correctement le matériel ou le véhicule", "Je fais un travail de qualité", "Je range et j'entretiens le matériel", "Je rends compte de mon travail"];
// D266 : sur les feuilles remises au salarié, le libellé comme le modèle Word (sans « (pas dans le livret) »)
const libelleFeuille = (t) => String(t || "").replace(/\s*\(pas dans le livret\)\s*$/i, "");
// Partie 1 de la fiche d'entretien (8 questions) : vierge (préparation du bilan, D262) ou cochée avec l'avis recopié au bilan (D267)
const ORDRE_AVIS = ["bleu", "rose", "orange", "vert"];
function tableauAvisSalarie(avis = null) {
  return el("table", { class: "livret-tableau", "data-avis-salarie": "1" },
    el("thead", {}, el("tr", {}, ...["", "Je ne sais pas faire", "Je fais avec de l'aide", "Je fais seul", "Je peux montrer aux autres", "Commentaire"].map((t) => el("th", {}, t)))),
    el("tbody", {}, ...QUESTIONS_SALARIE.map((q, i) => {
      const x = (avis && avis.questions && avis.questions[i]) || {};
      return el("tr", { "data-entretien-question": String(i) }, el("td", {}, q),
        ...ORDRE_AVIS.map((v) => el("td", { class: "livret-case" }, x.v === v ? "☒" : "☐")), el("td", {}, x.commentaire || ""));
    })));
}
// Partie 5 : comme le modèle Word 4.2.18.5, « Mon avis (salarié) » au-dessus des 4 premières colonnes, « Avis de l'ASP » au-dessus des 4 suivantes (P201)
function tableauASP(avecASP, lignes) {
  const th = (t, a = {}) => el("th", a, t);
  return el("table", { class: "livret-tableau", "data-tableau-asp": "1" },
    el("thead", {},
      el("tr", {}, th("Code", { rowspan: "2" }), th("Ce qui est observé", { rowspan: "2" }), th("Mon avis (salarié)", { colspan: "4", "data-titre-avis": "salarie" }),
        avecASP ? th("Avis de l'ASP", { colspan: "4", "data-titre-avis": "asp" }) : null),
      el("tr", {}, ...["Je ne sais pas faire", "Avec de l'aide", "Je fais seul", "Je peux montrer"].map((t) => th(t)),
        ...(avecASP ? ["Non", "Avec aide", "En autonomie", "Maîtrise"].map((t) => th(t)) : []))),
    el("tbody", {}, ...lignes));
}

// D262 : à imprimer AVANT le bilan, pour l'accompagnatrice et la direction ; le salarié la remplit à la main ; rien n'est enregistré
function ecranPreparationBilan(salarie, prochain, retour) {
  effacerAlerte();
  const asp = Object.values(etat.points || {}).filter((p) => /^ASP/.test(p.code)).sort((a, b) => comparerCodes(a.code, b.code));
  const quand = prochain && !prochain.manque ? dateFr(dateDuTexte(prochain.date)) : "……………";
  afficher(
    el("div", { class: "barre pas-imprime" }, el("h1", {}, "Préparation du bilan"),
      el("button", { class: "petit", id: "lancer-impression-preparation", onclick: () => window.print() }, "Imprimer / PDF"),
      el("button", { class: "petit", onclick: () => retour() }, "Retour")),
    el("div", { class: "livret fiche-entretien", id: "preparation-bilan" },
      el("h1", {}, "AGACI – Préparation du bilan trimestriel"),
      el("p", {}, `Salarié : ${salarie.prenom} ${salarie.nom} (${salarie.code}) · Bilan prévu le : ${quand}`),
      el("p", {}, "À remplir par le salarié avant l'entretien, puis à apporter au bilan."),
      el("h2", {}, "1. Mon avis sur mon travail"),
      tableauAvisSalarie(),
      el("h2", {}, "5. Mon accompagnement socioprofessionnel"),
      tableauASP(false, asp.map((p) => el("tr", { "data-preparation-asp": p.code }, el("td", {}, p.code), el("td", {}, libelleFeuille(p.libelle)),
        ...[1, 2, 3, 4].map(() => el("td", { class: "livret-case" }, "☐"))))),
    ),
  );
}

// D260 : une fiche, ou toutes les fiches d'un salarié (de la plus ancienne à la plus récente), une par page ; rien n'est enregistré
function ecranImprimerFiches(fiches, titre, retour) {
  effacerAlerte();
  const avis = (qui, v) => el("td", { class: "livret-case", "data-v": v || "" }, nomAvis(qui, v));
  const fiche = (f) => {
    const d = new Date(f.dateHeure);
    const lignes = (liste) => liste.map((p) => el("tr", {}, el("td", {}, p.code), el("td", {}, p.libelle), avis("encadrant", p.encadrant), avis("salarie", p.salarie)));
    const tableau = (titreT, liste) => liste.length ? [el("h2", {}, titreT), el("table", { class: "livret-tableau" },
      el("thead", {}, el("tr", {}, ...["Code", "Ce qui est observé", "Avis de l'encadrant", "Avis du salarié"].map((t) => el("th", {}, t)))),
      el("tbody", {}, ...lignes(liste)))] : [];
    return el("div", { class: "livret fiche-imprimee", "data-fiche-imprimee": f.id },
      el("h1", {}, `AGACI – Fiche de fin de guide ${f.guide.code}${f.guide.titre ? " – " + f.guide.titre : ""}`),
      el("p", {}, `Salarié : ${f.salarie.prenom} ${f.salarie.nom} (${f.salarie.code}) · Faite par : ${f.auteur.nom} · ${dateFr(d)} à ${heureFr(d)}`),
      ...tableau("Compétences du métier", f.points.filter((p) => p.section === "metier")),
      ...tableau("Comportements et savoirs de base", f.points.filter((p) => p.section !== "metier")),
      el("h2", {}, "Ce que j'ai bien réussi / ce que je dois retravailler (salarié)"), el("p", { class: "texte-lecture" }, f.reussi || "—"),
      el("h2", {}, "Observations de l'encadrant"), el("p", { class: "texte-lecture" }, f.observations || "—"),
      el("p", { class: "qui" }, f.signatures && f.signatures.salarie && f.signatures.encadrant
        ? "Signée sur la tablette par le salarié et l'encadrant." : "Fiche signée sur la tablette (les signatures restent sur la tablette qui l'a faite)."));
  };
  afficher(
    el("div", { class: "barre pas-imprime" }, el("h1", {}, titre),
      fiches.length ? el("button", { class: "petit", id: "lancer-impression-fiches", onclick: () => window.print() }, "Imprimer / PDF") : null,
      el("button", { class: "petit", onclick: () => retour() }, "Retour")),
    el("p", { class: "qui pas-imprime" }, fiches.length
      ? `${fiches.length} fiche(s), une par page. Pour garder un fichier : « Imprimer / PDF », puis « Enregistrer au format PDF ».`
      : "Aucune fiche à imprimer pour ce salarié."),
    ...fiches.map(fiche),
  );
}

async function ecranFicheEntretien(bilan, retour) {
  effacerAlerte();
  let bilans = [];
  try { bilans = await calculerBilans(); } catch (e) { return alerte("Impossible de lire les bilans de cet appareil : " + e.message); }
  const siens = bilans.filter((b) => b.salarie.code === bilan.salarie.code && !b.refuse).reverse();
  const numero = siens.findIndex((b) => b.id === bilan.id) + 1;
  const precedent = couleursBilanPrecedent(bilan.salarie.code, bilans, bilan.dateHeure);
  const pistes = pistesBilan(bilan.points, precedent);
  const case_ = (oui) => (oui ? "☒" : "☐");
  const qui = (role) => bilan.participants.filter((p) => p.role === role).map((p) => p.nom).join(", ") || "……………";
  const compte = (liste) => {
    const n = (v) => liste.filter((p) => p.definitive === v).length;
    return `${n("vert")} vert, ${n("orange")} orange, ${n("rose")} rose, ${n("bleu")} bleu, ${liste.filter((p) => !p.definitive || p.definitive === "nc").length} sans couleur`;
  };
  const dom = (p) => (etat.points[p.code] || {}).domaine || "";
  const cles = bilan.points.filter((p) => /^\d+\./.test(p.code) && !estComportement(p.code));
  const savoirs = cles.filter((p) => !/^10\./.test(dom(p))), securite = cles.filter((p) => /^10\./.test(dom(p)));
  const metier = bilan.points.filter((p) => /^Métier/.test(p.groupe || "")), asp = bilan.points.filter((p) => /^ASP/.test(p.code));
  const activites = [...new Set(metier.map((p) => p.groupe.replace("Métier – ", "")))];
  const regle = regleComportements(bilan.points);
  const avis = "☐ Oui  ☐ En partie  ☐ Non";
  const ligne2 = (domaine, resultat) => el("tr", {}, el("td", {}, domaine), el("td", {}, resultat), el("td", {}, avis), el("td", {}, ""));
  const tableau = (entete, lignes) => el("table", { class: "livret-tableau" }, el("thead", {}, el("tr", {}, ...entete.map((t) => el("th", {}, t)))), el("tbody", {}, ...lignes));
  const couleurASP = (p) => ["bleu", "rose", "orange", "vert"].map((v) => el("td", { class: "livret-case", "data-v": p.definitive === v ? v : "" }, p.definitive === v ? "☒" : "☐"));
  afficher(
    el("div", { class: "barre pas-imprime" }, el("h1", {}, "Fiche d'entretien"),
      el("button", { class: "petit", id: "imprimer-entretien", onclick: () => window.print() }, "Imprimer / PDF"),
      el("button", { class: "petit", onclick: () => retour() }, "Retour")),
    el("div", { class: "livret fiche-entretien", id: "fiche-entretien" },
      el("h1", {}, "AGACI – Bilan trimestriel de compétences"),
      el("p", {}, `Salarié : ${bilan.salarie.prenom} ${bilan.salarie.nom} (${bilan.salarie.code}) · Date : ${dateFr(new Date(bilan.dateHeure))} · Bilan n° ${numero || "?"}`),
      el("p", {}, `Encadrant : ${qui("encadrant")} · Accompagnatrice : ${qui("accompagnatrice")} · Coordinateur : ……………`),
      el("h2", {}, "1. Mon avis sur mon travail (à remplir par le salarié avant l'entretien)"),
      tableauAvisSalarie(bilan.avisSalarie),
      el("h2", {}, "2. Ce que montre le livret"),
      tableau(["Domaine", "Résultat de la période", "Mon avis rejoint-il celui de l'équipe ?", "Remarque"], [
        ligne2("1. Comportements (règle : 11/16 dont 1.1, 1.4, 1.5, 1.7)", `${case_(regle.acquis)} Acquis  ${case_(!regle.acquis)} Pas encore (${regle.bons} sur ${regle.total})`),
        ligne2("Savoirs de base (domaines 2 à 9)", compte(savoirs)),
        ligne2("Sécurité au travail (domaine 10)", compte(securite)),
        ligne2("Compétences du métier : " + (activites.join(", ") || "—"), compte(metier)),
        ligne2("Accompagnement socioprofessionnel (partie C)", compte(asp)),
      ]),
      el("h2", {}, "3. Mes points forts"),
      el("p", { class: "qui", "data-entretien-forts": "1" }, "Pistes (points en vert, ou en progrès depuis le bilan précédent) : " + listePoints(pistes.forts, 12)),
      el("p", { class: "lignes-vides" }, "……………………………………………………………………………………………………………………\n……………………………………………………………………………………………………………………"),
      el("h2", {}, "4. Mes objectifs pour la prochaine période (2 ou 3 maximum)"),
      tableau(["", "Objectif", "Comment ? (guide, atelier, PMSMP…)", "Avec qui ?", "Pour quand ?"], [0, 1, 2].map((i) => {
        const o = (bilan.objectifs || [])[i] || {};
        return el("tr", { "data-entretien-objectif": String(i) }, el("td", {}, `${i + 1}.`), el("td", {}, o.objectif || ""), el("td", {}, o.comment || ""),
          el("td", {}, o.avecQui || ""), el("td", {}, o.pourQuand ? dateFr(dateDuTexte(o.pourQuand)) : ""));
      })),
      el("h2", {}, "5. Mon accompagnement socioprofessionnel"),
      tableauASP(true, asp.map((p) => el("tr", { "data-entretien-asp": p.code }, el("td", {}, p.code), el("td", {}, libelleFeuille(p.libelle)),
        ...ORDRE_AVIS.map((v) => el("td", { class: "livret-case", "data-avis-salarie-case": v }, bilan.avisSalarie && bilan.avisSalarie.asp[p.code] === v ? "☒" : "☐")), ...couleurASP(p)))),
      el("p", {}, "Objectifs en ASP : " + (bilan.objectifsASP || "……………………………………………………………………")),
      el("p", {}, "Signatures – Salarié :                    Encadrant :                    Accompagnatrice :"),
    ),
  );
}

// D185 : un bilan validé avec une erreur s'annule (avec un motif) et se refait ; accompagnatrice ou direction
function ecranAnnulerBilan(bilan, retour) {
  effacerAlerte();
  const motif = el("textarea", { id: "motif-annulation-bilan" });
  const bouton = el("button", { class: "gros principal", id: "confirmer-annulation-bilan", onclick: async () => {
    if (!motif.value.trim()) return alerte("Écrivez le motif de l'annulation (obligatoire, D185).");
    bouton.disabled = true; // un double toucher n'annule jamais deux fois
    try {
      if ((await idsAnnules()).has(bilan.id)) return retour(); // déjà annulé
      const appareil = await numeroAppareil();
      const ev = { id: `${appareil}-${hexAleatoire(6)}`, type: "annulation", date_action: new Date().toISOString(),
        personne: etat.personne.id, salarie: bilan.salarie.code, objet: bilan.id,
        contenu: { secours: true, motif: motif.value.trim(), bilan: { salarie: bilan.salarie.code, dateHeure: bilan.dateHeure, auteur: bilan.auteur.id } } };
      await ecrire("envois", { id: ev.id, etat: "a_envoyer", ev });
      if (!(await lire("envois", ev.id))) throw new Error("l'annulation relue est vide");
    } catch (e) {
      bouton.disabled = false;
      return alerte("ÉCHEC : l'annulation n'a pas pu être enregistrée sur cet appareil (" + e.message + "). Le bilan n'est pas annulé.");
    }
    await retour();
    alerte(`Bilan du ${dateFr(new Date(bilan.dateHeure))} annulé sur cet appareil (${bilan.salarie.code}). L'annulation sera envoyée à Google au retour du Wifi, puis aux autres tablettes. Vous pouvez refaire le bilan.`, true);
    synchroniser();
  } }, "Oui, annuler définitivement le bilan");
  afficher(
    el("div", { class: "barre" }, el("h1", {}, "Annuler le bilan"), el("button", { class: "petit", onclick: () => ecranLireBilan(bilan, retour) }, "Retour")),
    el("p", {}, `Bilan du ${dateFr(new Date(bilan.dateHeure))} de ${bilan.salarie.code} ${bilan.salarie.prenom} ${bilan.salarie.nom}.`),
    el("p", { class: "note-permis" }, "L'annulation est définitive : le bilan disparaîtra de toutes les tablettes (il reste gardé dans la feuille Google). Pour corriger, refaites un bilan."),
    el("div", { class: "carte" }, el("strong", {}, "Motif de l'annulation (obligatoire)"), motif),
    bouton,
    el("button", { class: "gros", onclick: () => ecranLireBilan(bilan, retour) }, "Non, garder le bilan"),
  );
}

async function ecranLireBilan(bilan, retour) {
  effacerAlerte();
  let precedent = {};
  try { precedent = couleursBilanPrecedent(bilan.salarie.code, await calculerBilans(), bilan.dateHeure); } // D210
  catch (e) { alerte("Impossible de lire les bilans précédents : " + e.message); }
  const groupes = [];
  for (const p of bilan.points) { let g = groupes.find((x) => x.titre === p.groupe); if (!g) groupes.push(g = { titre: p.groupe, points: [] }); g.points.push(p); }
  const r = regleComportements(bilan.points);
  afficher(
    el("div", { class: "barre" }, el("h1", {}, `Bilan du ${dateFr(new Date(bilan.dateHeure))}`), el("button", { class: "petit", onclick: () => retour() }, "Retour")),
    el("p", { class: "qui" }, `Salarié : ${bilan.salarie.code} ${bilan.salarie.prenom} ${bilan.salarie.nom} · Participants : ${bilan.participants.map((p) => p.nom).join(", ")}`
      + ` · Prochain bilan : ${bilan.prochainBilan ? dateFr(dateDuTexte(bilan.prochainBilan)) : "—"}`),
    ROLES_SECOURS.includes(etat.personne.role) // D237
      ? el("button", { class: "gros", id: "fiche-entretien-bouton", onclick: () => ecranFicheEntretien(bilan, () => ecranLireBilan(bilan, retour)) }, "Imprimer la fiche d'entretien") : null,
    ROLES_SECOURS.includes(etat.personne.role) && !bilan.refuse
      ? el("button", { class: "gros", id: "annuler-bilan", onclick: () => ecranAnnulerBilan(bilan, retour) }, "Annuler le bilan") : null,
    el("p", { class: "carte regle-comportements", "data-acquis": r.acquis ? "1" : "0" }, texteRegle(r)),
    ...groupes.flatMap((g) => [el("h2", {}, g.titre), ...g.points.map((p) => el("div", { class: "carte", "data-point-lu": p.code },
      el("div", {}, el("span", { class: "code" }, p.code), p.libelle),
      el("div", { class: "ligne-avis" },
        el("span", { class: "avis-lecture", "data-v": p.definitive || "" }, p.definitive ? nomAvis("encadrant", p.definitive) : "Sans couleur à ce bilan"),
        blocBilanPrecedent(precedent[p.code], p.code)),
      /^ASP/.test(p.code) && bilan.avisSalarie && bilan.avisSalarie.asp[p.code]
        ? el("div", { class: "qui", "data-avis-asp-lu": p.code }, "Avis du salarié : " + nomAvis("salarie", bilan.avisSalarie.asp[p.code])) : null))]),
    ...blocAvisSalarieLu(bilan),
    ...blocObjectifsLus(bilan),
  );
}

// ---------- Étape 10d : graphiques d'évolution du salarié (D243 à D248). Calculés à partir des bilans, jamais enregistrés (D18) ----------
const COULEURS_GRAPHIQUE = { bleu: "#5b9bd5", rose: "#f4a6c8", orange: "#f4b183", vert: "#70ad47" };
const COULEURS_STATUT = { atteint: "#70ad47", "en-partie": "#f4b183", "pas-atteint": "#f4a6c8", aucun: "#d9d9d9" };
const echapper = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const blocSvg = (svg, attrs = {}) => { const d = el("div", { class: "graphique", ...attrs }); d.innerHTML = svg; return d; };

// les parties d'un bilan, dans l'ordre du livret ; chaque point compte dans une seule partie
function partiesEvolution(bilans) {
  const parties = [["Comportements", (p) => estComportement(p.code)], ["Compétences clés", (p) => /^\d+\./.test(p.code) && !estComportement(p.code)]];
  const metiers = [...new Set(bilans.flatMap((b) => b.points.map((p) => p.groupe || "")).filter((g) => /^Métier/.test(g)))];
  for (const m of metiers) parties.push([m.replace("Métier – ", "Métier : "), (p) => p.groupe === m]);
  parties.push(["Accompagnement socioprofessionnel", (p) => /^ASP/.test(p.code) && !HORS_LIVRET.includes(p.code)]); // D23, D249 : jamais budget ni logement
  return parties;
}

// (1) une barre par bilan, découpée par couleur, avec les nombres écrits (lisible en noir et blanc)
function svgCouleurs(titre, bilans, filtre) {
  const L = 56, H = 150, G = 46, largeur = G + bilans.length * (L + 14) + 10;
  const barres = bilans.map((b, i) => {
    const pts = b.points.filter(filtre);
    const n = Object.fromEntries(["bleu", "rose", "orange", "vert"].map((v) => [v, pts.filter((p) => p.definitive === v).length]));
    const total = n.bleu + n.rose + n.orange + n.vert, x = G + i * (L + 14);
    let y = 10 + H;
    const morceaux = ["bleu", "rose", "orange", "vert"].map((v) => {
      if (!n[v]) return "";
      const h = (n[v] / total) * H; y -= h;
      return `<rect x="${x}" y="${y}" width="${L}" height="${h}" fill="${COULEURS_GRAPHIQUE[v]}" data-v="${v}" data-n="${n[v]}"/>`
        + (h >= 12 ? `<text x="${x + L / 2}" y="${y + h / 2 + 4}" text-anchor="middle" font-size="11">${n[v]}</text>` : "");
    }).join("");
    const sans = pts.length - total;
    return `<g data-bilan-barre="${i + 1}">${total ? morceaux : `<rect x="${x}" y="10" width="${L}" height="${H}" fill="none" stroke="#999" stroke-dasharray="3 3"/>`}`
      + `<text x="${x + L / 2}" y="${H + 26}" text-anchor="middle" font-size="11">Bilan ${i + 1}</text>`
      + `<text x="${x + L / 2}" y="${H + 39}" text-anchor="middle" font-size="9">${echapper(dateFr(new Date(b.dateHeure)))}</text>`
      + (sans ? `<text x="${x + L / 2}" y="${H + 51}" text-anchor="middle" font-size="9">${sans} sans couleur</text>` : "") + "</g>";
  }).join("");
  return `<svg viewBox="0 0 ${largeur} ${H + 58}" width="${largeur}" role="img" aria-label="${echapper(titre)}">`
    + `<text x="0" y="${10 + H / 2}" font-size="10" transform="rotate(-90 10 ${10 + H / 2})">part des points</text>${barres}</svg>`;
}

// (2) comportements en orange ou vert, sur 16, avec la ligne des 11
function svgComportements(bilans) {
  const H = 160, G = 34, pas = 70, largeur = G + Math.max(1, bilans.length) * pas + 20, y = (n) => 24 + H - (n / 16) * H; // marge en haut : le « 16 » n'est pas coupé
  const valeurs = bilans.map((b) => regleComportements(b.points).bons);
  const pts = valeurs.map((v, i) => [G + pas / 2 + i * pas, y(v)]);
  const axe = [0, 4, 8, 11, 16].map((n) => `<text x="${G - 6}" y="${y(n) + 4}" text-anchor="end" font-size="10">${n}</text>`).join("");
  return `<svg viewBox="0 0 ${largeur} ${H + 54}" width="${largeur}" role="img" aria-label="Comportements en orange ou vert">${axe}`
    + `<line x1="${G}" y1="${y(11)}" x2="${largeur - 10}" y2="${y(11)}" stroke="#c25e00" stroke-dasharray="5 4"/>`
    + `<text x="${largeur - 12}" y="${y(11) - 4}" text-anchor="end" font-size="10" fill="#8a4200">11 = acquis</text>`
    + (pts.length > 1 ? `<polyline points="${pts.map((p) => p.join(",")).join(" ")}" fill="none" stroke="#1f4e79" stroke-width="2"/>` : "")
    + pts.map(([px, py], i) => `<circle cx="${px}" cy="${py}" r="5" fill="#1f4e79" data-comportements="${valeurs[i]}"/>`
      + `<text x="${px}" y="${py - 9}" text-anchor="middle" font-size="11">${valeurs[i]}</text>`
      + `<text x="${px}" y="${H + 44}" text-anchor="middle" font-size="11">Bilan ${i + 1}</text>`).join("") + "</svg>";
}

// (5) objectifs du bilan précédent : atteints, en partie, pas atteints, non renseignés
function svgObjectifs(bilans) {
  const H = 120, G = 30, L = 56, max = Math.max(1, ...bilans.map((b) => (b.suiviObjectifs || []).length)), largeur = G + bilans.length * (L + 14) + 10;
  const barres = bilans.map((b, i) => {
    const s = b.suiviObjectifs || [], x = G + i * (L + 14);
    const n = { atteint: 0, "en-partie": 0, "pas-atteint": 0, aucun: 0 };
    for (const o of s) n[o.statut || "aucun"]++;
    let y = 10 + H;
    const morceaux = ["atteint", "en-partie", "pas-atteint", "aucun"].map((k) => {
      if (!n[k]) return "";
      const h = (n[k] / max) * H; y -= h;
      return `<rect x="${x}" y="${y}" width="${L}" height="${h}" fill="${COULEURS_STATUT[k]}" data-statut="${k}" data-n="${n[k]}"/>`
        + `<text x="${x + L / 2}" y="${y + h / 2 + 4}" text-anchor="middle" font-size="11">${n[k]}</text>`;
    }).join("");
    return `<g data-objectifs-barre="${i + 1}">${morceaux}`
      + `<text x="${x + L / 2}" y="${H + 26}" text-anchor="middle" font-size="11">Bilan ${i + 1}</text>`
      + `<text x="${x + L / 2}" y="${H + 39}" text-anchor="middle" font-size="9">${(b.objectifs || []).length} fixé(s)</text></g>`;
  }).join("");
  return `<svg viewBox="0 0 ${largeur} ${H + 46}" width="${largeur}" role="img" aria-label="Objectifs">${barres}</svg>`;
}

// les 3 graphiques, pour l'écran et pour le livret ; bilans du plus ancien au plus récent
function blocsEvolution(bilans) {
  if (!bilans.length) return [el("p", { class: "qui", "data-evolution-vide": "1" }, "Pas encore de bilan validé.")];
  const legende = (paires) => el("p", { class: "legende-graphique" }, ...paires.map(([c, t]) => el("span", {}, el("i", { style: `background:${c}` }), t)));
  const oblig = el("table", { class: "livret-tableau", "data-obligatoires": "1" },
    el("thead", {}, el("tr", {}, el("th", {}, "Obligatoire"), ...bilans.map((b, i) => el("th", {}, `Bilan ${i + 1}`)))),
    el("tbody", {}, ...COMPORTEMENTS_OBLIGATOIRES.map((c) => el("tr", {}, el("td", {}, c),
      ...bilans.map((b) => { const p = b.points.find((x) => x.code === c); const ok = p && (p.definitive === "orange" || p.definitive === "vert");
        return el("td", { class: "livret-case", "data-v": ok ? "vert" : "" }, ok ? "oui" : "non"); })))));
  return [
    el("h3", {}, "1. Mes couleurs, bilan après bilan"),
    legende([[COULEURS_GRAPHIQUE.bleu, "Non"], [COULEURS_GRAPHIQUE.rose, "Avec aide"], [COULEURS_GRAPHIQUE.orange, "En autonomie"], [COULEURS_GRAPHIQUE.vert, "Maîtrise"]]),
    ...partiesEvolution(bilans).map(([titre, filtre]) => el("div", { class: "carte", "data-evolution-partie": titre }, el("strong", {}, titre), blocSvg(svgCouleurs(titre, bilans, filtre)))),
    el("h3", {}, "2. Mes comportements (orange ou vert, sur 16)"),
    el("div", { class: "carte", "data-evolution-comportements": "1" }, blocSvg(svgComportements(bilans)), oblig),
    el("h3", {}, "3. Mes objectifs"),
    legende([[COULEURS_STATUT.atteint, "Atteint"], [COULEURS_STATUT["en-partie"], "En partie"], [COULEURS_STATUT["pas-atteint"], "Pas atteint"], [COULEURS_STATUT.aucun, "Non renseigné"]]),
    el("p", { class: "qui" }, "Chaque barre montre ce que sont devenus les objectifs fixés au bilan d'avant."),
    el("div", { class: "carte", "data-evolution-objectifs": "1" }, blocSvg(svgObjectifs(bilans))),
  ];
}

async function ecranEvolution(salarie, retour) {
  effacerAlerte();
  let bilans = [];
  try { bilans = (await calculerBilans()).filter((b) => b.salarie.code === salarie.code && !b.refuse).reverse(); }
  catch (e) { return alerte("Impossible de lire les bilans de cet appareil : " + e.message); }
  afficher(
    el("div", { class: "barre" }, el("h1", {}, "Évolution – " + nomSalarie(salarie)), el("button", { class: "petit", onclick: () => retour() }, "Retour")),
    el("p", { class: "qui" }, `${bilans.length} bilan(s) validé(s). Calculé à partir des bilans (les fiches de fin de guide ne comptent pas ici).`),
    ...blocsEvolution(bilans),
  );
}

// ---------- Étape 11 : le livret du salarié, à imprimer ou enregistrer en PDF avec Chrome (D24, D54, D212 à D216) ----------
// Présentation du modèle papier : partie A (compétences clés, par domaine), partie B pour chacune de ses activités, partie C
// (accompagnement, sans ASP3.4 ni ASP3.6, D23). Une colonne par bilan validé, par tableaux de 4 (D213). Seules les couleurs
// validées aux bilans (D214). Rien n'est enregistré : tout se recalcule à partir des bilans (D18).
const TYPE_METIER = { "Espaces verts": "Métier EV", "Conduite": "Métier Conduite", "Peinture en bâtiment (BTP)": "Métier BTP" };
const HORS_LIVRET = ["ASP3.4", "ASP3.6"];
const COURT = { bleu: "Non", rose: "Aide", orange: "Auto.", vert: "Maît.", nc: "NC" }; // lisible aussi en noir et blanc

function partiesLivret(salarie) {
  const pts = etat.referentiel.points.filter((p) => !HORS_LIVRET.includes(p.code));
  const parDomaine = (liste) => {
    const g = [];
    for (const p of liste) { let d = g.find((x) => x.domaine === p.domaine); if (!d) g.push(d = { domaine: p.domaine, points: [] }); d.points.push(p); }
    return g;
  };
  const parties = [{ titre: "PARTIE A – Compétences clés : comportements et savoirs de base", groupes: parDomaine(pts.filter((p) => p.type === "Compétence clé")) }];
  for (const a of salarie.activites || []) {
    const type = TYPE_METIER[a];
    if (type) parties.push({ titre: "PARTIE B – " + a, groupes: parDomaine(pts.filter((p) => p.type === type)) });
  }
  parties.push({ titre: "PARTIE C – Accompagnement socioprofessionnel", groupes: parDomaine(pts.filter((p) => /^ASP/.test(p.code))) });
  return parties;
}

async function ecranLivret(salarie, retour) {
  effacerAlerte();
  let bilans = [];
  try { bilans = (await calculerBilans()).filter((b) => b.salarie.code === salarie.code && !b.refuse).reverse(); } // du plus ancien au plus récent
  catch (e) { return alerte("Impossible de lire les bilans de cet appareil : " + e.message); }
  const paquets = [];
  for (let i = 0; i < Math.max(bilans.length, 1); i += 4) paquets.push(bilans.slice(i, i + 4)); // D213 : tableaux de 4
  const couleur = (b, code) => { const p = b && b.points.find((x) => x.code === code); return p && p.definitive ? p.definitive : ""; };
  const tableau = (groupes, paquet, debut, comportements) => {
    const cols = [0, 1, 2, 3].map((i) => paquet[i]);
    const entete = el("tr", {}, el("th", { class: "livret-point" }, "Point"),
      ...cols.map((b, i) => el("th", { class: "livret-col" }, b ? `Bilan ${debut + i + 1}\n${dateFr(new Date(b.dateHeure))}` : `Bilan ${debut + i + 1}\nle …/…/…`)));
    const lignes = groupes.flatMap((g) => [
      el("tr", {}, el("td", { class: "livret-domaine", colspan: "5" }, g.domaine)),
      ...g.points.map((p) => el("tr", { "data-livret-point": p.code }, el("td", { class: "livret-point" }, el("span", { class: "code" }, p.code), " " + p.libelle),
        ...cols.map((b) => { const v = couleur(b, p.code); return el("td", { class: "livret-case", "data-v": v }, v ? COURT[v] : ""); }))),
    ]);
    if (comportements) lignes.push(el("tr", { "data-livret-regle": "1" }, el("td", { class: "livret-point" }, "Comportements acquis (11 sur 16 en orange ou vert, dont 1.1, 1.4, 1.5, 1.7)"),
      ...cols.map((b) => el("td", { class: "livret-case" }, b ? (regleComportements(b.points).acquis ? "Oui" : "Non") : ""))));
    return el("table", { class: "livret-tableau" }, el("thead", {}, entete), el("tbody", {}, ...lignes));
  };
  const parties = partiesLivret(salarie);
  afficher(
    el("div", { class: "barre pas-imprime" }, el("h1", {}, "Livret – " + nomSalarie(salarie)),
      el("button", { class: "petit", id: "lancer-impression", onclick: () => window.print() }, "Imprimer / PDF"),
      el("button", { class: "petit", onclick: () => retour() }, "Retour")),
    el("p", { class: "qui pas-imprime" }, `${bilans.length} bilan(s) validé(s). « Imprimer / PDF » ouvre l'impression de Chrome : choisissez l'imprimante, ou « Enregistrer au format PDF ». Mettez la page en « Paysage » si besoin.`),
    el("div", { class: "livret", id: "livret" },
      el("h1", {}, "AGACI – Mon livret de compétences"),
      el("p", {}, `Nom et prénom : ${salarie.prenom} ${salarie.nom} (${salarie.code}) · Activités : ${(salarie.activites || []).join(", ")} · Date d'entrée : ${salarie.date_entree ? dateFr(dateDuTexte(salarie.date_entree)) : "—"}`),
      el("p", { class: "livret-legende" }, "Les couleurs : ", ...["bleu", "rose", "orange", "vert"].map((v) => el("span", { class: "livret-case", "data-v": v }, `${COURT[v]} = ${nomAvis("encadrant", v)}`)),
        " · Chaque colonne est un bilan (tous les 3 mois). Une case vide : pas de couleur à ce bilan."),
      ...parties.flatMap((pa) => [el("h2", { class: "livret-partie", "data-livret-partie": pa.titre }, pa.titre),
        ...paquets.map((paquet, i) => tableau(pa.groupes, paquet, i * 4, pa.titre.startsWith("PARTIE A")))]),
      el("h2", { class: "livret-partie", "data-livret-partie": "Mon évolution" }, "Mon évolution"),
      ...blocsEvolution(bilans),
    ),
  );
}

// ---------- D235 : changer l'adresse du programme Google sans réinstaller l'appareil ----------
async function ecranChangerAdresse() {
  effacerAlerte();
  let actuelle = "";
  try { actuelle = ((await lire("reglages", "connexion")) || {}).url || ""; } catch (e) { alerte("Impossible de lire l'appareil : " + e.message); }
  const champ = el("input", { id: "nouvelle-adresse", type: "url", class: "champ", placeholder: "https://script.google.com/macros/s/…/exec" });
  const bouton = el("button", { class: "gros principal", id: "verifier-adresse", onclick: async () => {
    if (bouton.disabled) return;
    bouton.disabled = true; bouton.textContent = "Vérification auprès de Google…";
    let r;
    try { r = await changerAdresseGoogle(champ.value); }
    catch (e) { r = { ok: false, raison: e.message }; }
    bouton.disabled = false; bouton.textContent = "Vérifier et changer";
    if (!r.ok) return alerte("Adresse PAS changée : " + String(r.raison).replace(/\.\s*$/, "") + ". L'appareil garde l'ancienne adresse.");
    await ecranAccueil("Nouvelle adresse vérifiée et gardée. Rien n'a été effacé sur cet appareil ; ce qui n'était pas encore envoyé part maintenant.");
    synchroniser();
  } }, "Vérifier et changer");
  afficher(
    el("div", { class: "barre" }, el("h1", {}, "Changer l'adresse de Google"), el("button", { class: "petit", onclick: () => ecranAccueil() }, "Retour")),
    el("p", { class: "note-permis" }, "À utiliser seulement si la feuille Google a été remplacée par une copie de sauvegarde (nouveau déploiement). Sinon, ne changez rien."),
    el("p", { class: "qui" }, "Adresse actuelle : ", el("span", { id: "adresse-actuelle" }, actuelle || "—")),
    el("label", { class: "carte bloc-champ" }, el("strong", {}, "Nouvelle adresse du programme Google"), champ),
    bouton,
  );
}

// ---------- Étape 9a : gestion des salariés (D43, D44, D137, D145, D151 à D160) ----------
// Réservée à l'accompagnatrice et à la direction (le programme Google refuse les dossiers envoyés par un encadrant).
// Ajouter : seulement avec le Wifi, Google vérifie le code (D159). Modifier, sortir, faire revenir : possible sans réseau ;
// chaque enregistrement ne contient que ce qui a changé (D157) ; l'historique reste dans la feuille.
const PROGRAMME_MINIMUM_AJOUT = "2026-11-18"; // programme Google qui contrôle les codes (D159)
const CHAMPS_DOSSIER = ["nom", "prenom", "activites", "date_entree", "date_fin_contrat", "permis", "sorti", "date_sortie", "date_retour"];
const activitesDuReferentiel = () => [...new Set(etat.referentiel.guides.map((g) => g.activite))];

// date du jour à l'heure de la tablette (AAAA-MM-JJ), et non la date « universelle » (fausse entre minuit et 1 h ou 2 h)
function aujourdhuiLocal() {
  const d = new Date(), deux = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${deux(d.getMonth() + 1)}-${deux(d.getDate())}`;
}

function codeSuivant() { // D152 : S06, S07… (codes déjà pris, y compris sortis et effacés, jamais repris)
  const pris = new Set([...(etat.salariesTous || []).map((x) => x.code), ...(etat.codesEffaces || [])]);
  let n = 1;
  for (const c of pris) { const m = /^S(\d+)$/.exec(c); if (m) n = Math.max(n, Number(m[1]) + 1); }
  let code = "S" + String(n).padStart(2, "0");
  while (pris.has(code)) code = "S" + String(++n).padStart(2, "0");
  return code;
}

function ecranSalaries() {
  effacerAlerte();
  const presents = (etat.salariesTous || []).filter((x) => !x.sorti), sortis = (etat.salariesTous || []).filter((x) => x.sorti);
  const carte = (x) => ({ s: x, e: el("button", { class: "carte liste-fiche", "data-dossier": x.code, onclick: () => ecranDossier(x) },
    el("strong", {}, nomSalarie(x)), el("br"),
    (x.activites || []).join(", ") + (x.date_fin_contrat ? ` · fin du contrat : ${dateFr(new Date(x.date_fin_contrat + "T00:00:00"))}` : " · fin du contrat : non indiquée")) });
  const lp = presents.map(carte), ls = sortis.map(carte);
  const hp = el("h2", { id: "titre-presents" }, `Présents : ${presents.length}`), hs = sortis.length ? el("h2", { id: "titre-sortis" }, `Sortis : ${sortis.length}`) : null;
  // D265 : pendant une recherche, le nombre trouvé ; un groupe sans résultat n'est pas affiché
  const titres = (recherche) => {
    for (const [h, liste, mot] of [[hp, lp, "Présents"], [hs, ls, "Sortis"]]) {
      if (!h) continue;
      const n = liste.filter((l) => !l.e.hidden).length;
      h.textContent = `${mot} : ${n}`;
      h.hidden = recherche && n === 0;
    }
  };
  afficher(
    el("div", { class: "barre" }, el("h1", {}, "Salariés"), el("button", { class: "petit", onclick: () => ecranAccueil() }, "Retour")),
    el("button", { class: "gros principal", onclick: () => ecranDossier(null) }, "Ajouter un salarié"),
    zoneRecherche([...lp, ...ls], titres),
    hp, ...lp.map((l) => l.e),
    hs, ...ls.map((l) => l.e),
  );
}

// D157 : ce qui a changé entre le dossier de départ et le dossier enregistré (rien, faux, vide : même chose)
function changementsDossier(base, dossier) {
  const vide = (v) => v === undefined || v === null || v === false || v === "" || (Array.isArray(v) && !v.length);
  const pareil = (a, b) => (vide(a) && vide(b)) || JSON.stringify(a) === JSON.stringify(b);
  const ch = {};
  for (const k of CHAMPS_DOSSIER) if (!pareil(base[k], dossier[k])) ch[k] = dossier[k];
  if (ch.sorti === false) ch.date_retour = dossier.date_retour; // « Faire revenir » envoie toujours sa date (D156)
  return ch;
}

// base : le dossier tel qu'il est (pour « Faire revenir », x est déjà préparé et base est le dossier d'origine)
function ecranDossier(x, base = x) {
  effacerAlerte();
  const nouveau = !x;
  const champ = (id, valeur, type = "text") => { const c = el("input", { id, type, class: "champ" }); c.value = valeur || ""; return c; };
  const code = champ("dossier-code", nouveau ? codeSuivant() : x.code);
  if (!nouveau) code.disabled = true; // le code d'un dossier existant ne change pas
  const nom = champ("dossier-nom", x && x.nom), prenom = champ("dossier-prenom", x && x.prenom);
  const entree = champ("dossier-entree", x && x.date_entree, "date"), fin = champ("dossier-fin-contrat", x && x.date_fin_contrat, "date");
  const permis = el("input", { id: "dossier-permis", type: "checkbox" }); permis.checked = !!(x && x.permis);
  // P141 : les activités sont choisies dans le référentiel, jamais tapées
  const cases = activitesDuReferentiel().map((a) => {
    const c = el("input", { type: "checkbox", "data-activite": a }); c.checked = !!(x && (x.activites || []).includes(a));
    return el("label", { class: "case" }, c, " " + a);
  });
  const ligne = (titre, ...contenu) => el("label", { class: "carte bloc-champ" }, el("strong", {}, titre), ...contenu);
  const bouton = el("button", { class: "gros principal", id: "enregistrer-dossier", onclick: async () => {
    const dossier = {
      ...(x || {}), code: code.value.trim().toUpperCase(), nom: nom.value.trim(), prenom: prenom.value.trim(),
      activites: cases.map((l) => l.querySelector("input")).filter((c) => c.checked).map((c) => c.dataset.activite),
      date_entree: entree.value, date_fin_contrat: fin.value, permis: permis.checked, sorti: x ? !!x.sorti : false,
    };
    const manques = [];
    if (!/^[A-Z0-9-]{1,12}$/.test(dossier.code)) manques.push("un code de 1 à 12 lettres, chiffres ou tirets");
    else if (nouveau && ((etat.salariesTous || []).some((y) => y.code === dossier.code) || (etat.codesEffaces || new Set()).has(dossier.code))) manques.push(`un autre code (${dossier.code} est déjà pris)`);
    if (!dossier.nom) manques.push("le nom");
    if (!dossier.prenom) manques.push("le prénom");
    if (!dossier.activites.length) manques.push("au moins une activité");
    if (!dossier.date_entree) manques.push("la date d'entrée");
    if (!dossier.date_fin_contrat) manques.push("la date de fin du contrat en cours");
    if (manques.length) return alerte("Dossier pas encore enregistré. Il manque : " + manques.join(", ") + ".");
    if (dossier.date_fin_contrat < dossier.date_entree) // D158 (dates AAAA-MM-JJ : l'ordre du texte est celui des dates)
      return alerte("Dossier pas encore enregistré : la date de fin du contrat est avant la date d'entrée.");
    if (nouveau) return ajouterSalarie(dossier, bouton);
    const changements = changementsDossier(base, dossier);
    if (!Object.keys(changements).length) return alerte("Rien n'a changé : rien à enregistrer.");
    await enregistrerDossier(dossier, changements, bouton, "Dossier modifié");
  } }, nouveau ? "Ajouter ce salarié" : "Enregistrer les modifications");
  afficher(
    el("div", { class: "barre" }, el("h1", {}, nouveau ? "Ajouter un salarié" : nomSalarie(x)), el("button", { class: "petit", onclick: () => ecranSalaries() }, "Retour")),
    x && x.sorti ? el("p", { class: "note-permis", "data-sorti": "1" }, `Salarié sorti${x.date_sortie ? " le " + dateFr(new Date(x.date_sortie + "T00:00:00")) : ""}.`) : null,
    ligne("Code du salarié" + (nouveau ? " (proposé, modifiable)" : ""), code),
    ligne("Nom", nom), ligne("Prénom", prenom),
    el("div", { class: "carte bloc-champ" }, el("strong", {}, "Activités"), ...cases),
    ligne("Date d'entrée", entree),
    ligne("Date de fin du contrat en cours (à mettre à jour à chaque renouvellement)", fin),
    el("label", { class: "carte bloc-champ case" }, permis, " Permis de conduire"),
    bouton,
    x && !x.sorti ? el("button", { class: "gros", id: "sortir-salarie", onclick: () => ecranSortie(x) }, "Sortir ce salarié") : null,
    x && x.sorti ? el("button", { class: "gros", id: "faire-revenir", onclick: () => faireRevenir(x) }, "Faire revenir ce salarié (nouveau contrat)") : null,
  );
}

// Modifier, sortir, faire revenir : enregistré sur la tablette, envoyé au retour du Wifi (seulement ce qui a changé, D157)
async function enregistrerDossier(dossier, changements, bouton, quoi) {
  if (bouton) bouton.disabled = true; // un double toucher n'enregistre qu'une fois
  try {
    const appareil = await numeroAppareil();
    const ev = { id: `${appareil}-${hexAleatoire(6)}`, type: "salarie", date_action: new Date().toISOString(),
      personne: etat.personne.id, salarie: dossier.code, objet: dossier.code, contenu: { code: dossier.code, ...changements } };
    await ecrire("envois", { id: ev.id, etat: "a_envoyer", ev });
    if (!(await lire("envois", ev.id))) throw new Error("le dossier relu est vide");
    await recalculerDonnees();
  } catch (e) {
    if (bouton) bouton.disabled = false;
    return alerte("ÉCHEC : le dossier n'a pas pu être enregistré sur cet appareil (" + e.message + ").");
  }
  ecranSalaries();
  alerte(`${quoi} sur cet appareil (${nomSalarie(dossier)}). Envoyé à Google au retour du Wifi, puis aux autres tablettes.`, true);
  synchroniser();
}

// D159 : ajouter un salarié demande le Wifi. Le dossier part tout de suite ; Google vérifie que le code n'est pas pris ;
// le salarié n'apparaît qu'une fois accepté. Sans réponse de Google, rien n'est gardé sur la tablette.
async function ajouterSalarie(dossier, bouton) {
  bouton.disabled = true;
  const ech = etat.echange;
  const pasAjoute = (texte) => { bouton.disabled = false; alerte("Salarié PAS ajouté : " + texte); };
  alerte("Envoi à Google en cours… (il faut le Wifi pour ajouter un salarié)", true);
  try {
    // toujours un échange juste avant : il dit si Google répond MAINTENANT (jamais une erreur ancienne, P151),
    // si le programme Google contrôle les codes, et met la liste des salariés à jour
    await synchroniser(); // (si un échange était déjà en cours, on attend sa fin : son résultat est tout récent)
    if (ech.erreur) return pasAjoute("il faut le Wifi pour ajouter un salarié. " + ech.erreur);
    if (!(ech.programme >= PROGRAMME_MINIMUM_AJOUT))
      return pasAjoute("le programme Google doit d'abord être mis à jour (fiche 9). Prévenez la direction.");
    const appareil = await numeroAppareil();
    const ev = { id: `${appareil}-${hexAleatoire(6)}`, type: "salarie", nouveau: true, date_action: new Date().toISOString(),
      personne: etat.personne.id, salarie: dossier.code, objet: dossier.code, contenu: dossier };
    await ecrire("envois", { id: ev.id, etat: "a_envoyer", ev });
    await synchroniser();
    let envoi = await lire("envois", ev.id);
    // un échange déjà en cours avant l'écriture ne l'a pas emporté : un second échange
    if (envoi && envoi.etat === "a_envoyer" && !ech.erreur) { await synchroniser(); envoi = await lire("envois", ev.id); }
    if (!envoi) { // accepté par Google (l'envoi accepté est retiré de la tablette)
      ecranSalaries();
      return alerte(`Salarié ajouté et enregistré chez Google (${nomSalarie(dossier)}).`, true);
    }
    if (envoi.etat === "refuse") {
      await ecrire("envois", { ...envoi, vu: true }); // le refus est dit ici, à l'écran ; inutile de le répéter sur l'accueil
      await compterEnvois();
      return pasAjoute(`Google a refusé (${envoi.raison}). Changez le code et recommencez.`);
    }
    await supprimer("envois", ev.id);
    await compterEnvois();
    return pasAjoute("pas de réponse de Google, il faut le Wifi pour ajouter un salarié. " + (ech.erreur || "")
      + " Si ce salarié apparaît plus tard dans la liste, c'est que Google l'a quand même reçu.");
  } catch (e) {
    return pasAjoute("erreur sur cet appareil (" + e.message + ").");
  }
}

function ecranSortie(x) {
  effacerAlerte();
  const bouton = el("button", { class: "gros principal", id: "confirmer-sortie", onclick: () =>
    enregistrerDossier(x, { sorti: true, date_sortie: aujourdhuiLocal() }, bouton, "Salarié sorti") }, "Oui, sortir ce salarié");
  afficher(
    el("div", { class: "barre" }, el("h1", {}, "Sortir un salarié"), el("button", { class: "petit", onclick: () => ecranDossier(x) }, "Retour")),
    el("p", {}, `Sortir ${nomSalarie(x)} ?`),
    el("p", { class: "note-permis" }, "Il n'apparaîtra plus dans les listes ni dans le suivi des salariés (D137). Ses fiches restent gardées. Il pourra revenir plus tard avec le même dossier (D153). Effacer son dossier se fait seulement dans la feuille Google, par la direction (D44, D106)."),
    bouton,
    el("button", { class: "gros", onclick: () => ecranDossier(x) }, "Non, revenir"),
  );
}

function faireRevenir(x) { // D153 : on reprend son dossier ; la date de fin du nouveau contrat est demandée
  ecranDossier({ ...x, sorti: false, date_sortie: "", date_retour: aujourdhuiLocal(), date_fin_contrat: "" }, x);
  alerte("Indiquez la date de fin du nouveau contrat, puis enregistrez.");
}

// ---------- Étape 6a : ouvrir une fiche, l'annuler (D15, D52, D74, D127) ----------
const ROLES_SECOURS = ["accompagnatrice", "direction"];
// Qui peut annuler cette fiche (D133 : on ne modifie pas, on annule et on refait) : son auteur, ou en secours l'accompagnatrice et la direction
// (le programme Google refait le même contrôle, conception §9).
function droitSurFiche(f) {
  if (!etat.personne || !f.auteur || f.refusee) return null; // une fiche refusée par Google ne s'annule pas
  if (f.auteur.id === etat.personne.id) return "auteur";
  return ROLES_SECOURS.includes(etat.personne.role) ? "secours" : null;
}

// Fiches annulées : annulations reçues de Google + annulations de cet appareil pas encore envoyées (sauf refusées).
async function idsAnnules(journal) {
  const envois = await lireTout("envois");
  return new Set((journal || await lireTout("journal")).filter((l) => l.type === "annulation").map((l) => l.objet)
    .concat(envois.filter((e) => e.ev.type === "annulation" && e.etat !== "refuse").map((e) => e.ev.objet)));
}

function nomAvis(qui, v) {
  const n = ECHELLE.find((x) => x.v === v);
  return n ? (qui === "encadrant" ? n.encadrant : n.salarie) : "—";
}

function ecranDetailFiche(f, retour = ecranListe) {
  effacerAlerte();
  const d = new Date(f.dateHeure);
  const droit = droitSurFiche(f);
  const avis = (qui, v) => el("span", { class: "avis-lecture", "data-v": v || "", "data-qui": qui },
    `${qui === "encadrant" ? "Encadrant" : "Salarié"} : ${nomAvis(qui, v)}`);
  const point = (p) => el("div", { class: "carte", "data-point": p.code },
    el("div", {}, el("span", { class: "code" }, p.code), p.libelle),
    el("div", { class: "ligne-lecture" }, avis("encadrant", p.encadrant), avis("salarie", p.salarie)));
  const texte = (titre, t) => el("div", { class: "carte" }, el("strong", {}, titre), el("div", { class: "texte-lecture" }, t || "—"));
  const metier = f.points.filter((p) => p.section === "metier"), cles = f.points.filter((p) => p.section !== "metier");
  afficher(
    el("div", { class: "barre" }, el("h1", {}, `${f.guide.code} – ${f.guide.titre || ""}`),
      el("button", { class: "petit", onclick: () => retour() }, "Retour")),
    el("p", { class: "qui" }, `Salarié : ${f.salarie.code} ${f.salarie.prenom} ${f.salarie.nom} · Par : ${f.auteur.nom} · ${dateFr(d)} à ${heureFr(d)}`),
    ROLES_SECOURS.includes(etat.personne.role) // D260
      ? el("button", { class: "gros", id: "imprimer-fiche", onclick: () => ecranImprimerFiches([f], `Fiche ${f.guide.code} – ${f.salarie.code}`, () => ecranDetailFiche(f, retour)) }, "Imprimer / PDF") : null,
    droit
      ? el("button", { class: "gros", id: "annuler-fiche", onclick: () => ecranAnnulerFiche(f, droit, retour) }, "Annuler la fiche")
      : el("p", { class: "qui", "data-lecture-seule": "1" }, "Seuls l'auteur de la fiche, l'accompagnatrice et la direction peuvent l'annuler."),
    metier.length ? el("h2", {}, "Compétences du métier") : null,
    ...metier.map(point),
    el("h2", {}, "Comportements et savoirs de base"),
    ...cles.map(point),
    texte("Ce que j'ai bien réussi / ce que je dois retravailler (salarié)", f.reussi),
    texte("Observations de l'encadrant", f.observations),
  );
}

function ecranAnnulerFiche(f, droit, retour = ecranListe) {
  effacerAlerte();
  const secours = droit === "secours";
  const motif = secours ? el("textarea", { id: "motif-annulation" }) : null;
  const bouton = el("button", { class: "gros principal", id: "confirmer-annulation", onclick: async () => {
    if (secours && !motif.value.trim()) return alerte("Écrivez le motif de l'annulation (obligatoire en secours, D127).");
    bouton.disabled = true; // un double toucher n'annule jamais deux fois
    try {
      if ((await idsAnnules()).has(f.id)) return ecranListe(); // déjà annulée
      const appareil = await numeroAppareil();
      const evenement = { id: `${appareil}-${hexAleatoire(6)}`, type: "annulation", date_action: new Date().toISOString(),
        personne: etat.personne.id, salarie: f.salarie.code, objet: f.id,
        contenu: { secours, motif: secours ? motif.value.trim() : "",
          fiche: { guide: f.guide.code, salarie: f.salarie.code, auteur: f.auteur.id, dateHeure: f.dateHeure } } };
      await ecrire("envois", { id: evenement.id, etat: "a_envoyer", ev: evenement });
      if (!(await lire("envois", evenement.id))) throw new Error("l'annulation relue est vide");
    } catch (e) {
      bouton.disabled = false;
      return alerte("ÉCHEC : l'annulation n'a pas pu être enregistrée sur cet appareil (" + e.message + "). La fiche n'est pas annulée.");
    }
    await ecranAccueil(`Fiche annulée sur cet appareil (${f.guide.code}, ${f.salarie.code}). L'annulation sera envoyée à Google au retour du Wifi, puis aux autres tablettes.`);
    synchroniser();
  } }, "Oui, annuler définitivement la fiche");
  const d = new Date(f.dateHeure);
  afficher(
    el("div", { class: "barre" }, el("h1", {}, "Annuler la fiche"), el("button", { class: "petit", onclick: () => ecranDetailFiche(f, retour) }, "Retour")),
    el("p", {}, `Fiche ${f.guide.code} de ${f.salarie.code} ${f.salarie.prenom} ${f.salarie.nom}, faite par ${f.auteur.nom} le ${dateFr(d)} à ${heureFr(d)}.`),
    el("p", { class: "note-permis" }, "L'annulation est définitive : la fiche disparaîtra de toutes les tablettes (elle reste gardée dans la feuille Google). Pour corriger, il faudra refaire une fiche."),
    secours ? el("div", { class: "carte" }, el("strong", {}, "Motif de l'annulation (obligatoire : vous annulez la fiche d'une autre personne)"), motif) : null,
    bouton,
    el("button", { class: "gros", onclick: () => ecranDetailFiche(f, retour) }, "Non, garder la fiche"),
  );
}

// ---------- Démarrage ----------
// Fonctionnement sans réseau : les fichiers de l'application sont gardés sur l'appareil (sw.js)
function installerFonctionnementHorsReseau() {
  if (!("serviceWorker" in navigator)) { etat.horsReseauImpossible = "Ce navigateur ne permet pas d'ouvrir l'application sans réseau."; return; }
  navigator.serviceWorker.register("sw.js").catch((e) => {
    etat.horsReseauImpossible = "L'application ne pourra pas s'ouvrir sans réseau sur cet appareil (" + e.message + ").";
    if (typeof majEtatEchange === "function") majEtatEchange();
  });
}

async function demarrer() {
  try {
    installerFonctionnementHorsReseau();
    // Stockage protégé : sans lui, Chrome peut effacer les fiches non envoyées si l'appareil manque de place (affiché sur l'accueil)
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().then((ok) => { etat.stockageProtege = ok; if (typeof majEtatEchange === "function") majEtatEchange(); })
        .catch(() => { etat.stockageProtege = false; });
    } else etat.stockageProtege = false;
    await ouvrirBase();
    await recalculerDonnees();
    await purgerBrouillons();
    await compterEnvois();
    const connexion = await lire("reglages", "connexion");
    if (!connexion) return ecranInstallation();
    const derniere = await lire("reglages", "dernier-echange");
    if (derniere) etat.echange.derniere = new Date(derniere.valeur);
    ecranPin();
    synchroniser().then(() => { if (!etat.personne && !document.querySelector(".clavier")) ecranPin(); });
  } catch (e) {
    afficher(el("h1", {}, "Évaluations AGACI"));
    alerte("L'application ne peut pas démarrer : stockage de l'appareil indisponible (" + e.message + ").");
  }
}
window.addEventListener("DOMContentLoaded", demarrer);
