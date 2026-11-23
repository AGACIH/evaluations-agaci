// Étape 4 bis : document du guide d'apprentissage avant la fiche (D109) et bouton d'aide (D113).
// Les PDF viennent du dossier Drive « Documents » (D119), sont copiés sur l'appareil (D120) et affichés
// sans réseau avec PDF.js (D118). Ils ne sont jamais publiés sur internet (D64, D111).
"use strict";

if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = "pdf.worker.min.js";
const DELAI_DOCUMENT_MS = 120 * 1000; // délai maximum pour copier un document

// ---------- Copie des documents sur l'appareil ----------
async function telechargerDocuments(docs, connexion, appareil) {
  if (!docs) return;
  const erreurs = [];
  let locaux = {};
  try {
    await ecrire("reglages", { cle: "documents-index", valeur: docs.index, manquants: docs.manquants, dossierTrouve: docs.dossierTrouve });
    locaux = Object.fromEntries((await lireTout("documents")).map((d) => [d.nom, d.modifie]));
  } catch (e) {
    etat.echange.erreurDocuments = "Impossible d'écrire la liste des documents sur l'appareil : " + e.message;
    return;
  }
  for (const f of docs.fichiers) {
    if (locaux[f.nom] === f.modifie) continue; // déjà à jour sur l'appareil
    const arret = new AbortController();
    const minuterie = setTimeout(() => arret.abort(), DELAI_DOCUMENT_MS);
    try {
      const r = await fetch(connexion.url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, signal: arret.signal,
        body: JSON.stringify({ action: "document", appareil, cle: connexion.cleTablette, nom: f.nom }) });
      const rep = JSON.parse(await r.text());
      if (!rep.ok) throw new Error(rep.erreur || "refusé");
      const octets = Uint8Array.from(atob(rep.base64), (c) => c.charCodeAt(0));
      await ecrire("documents", { nom: f.nom, modifie: rep.modifie, donnees: octets.buffer });
    } catch (e) {
      erreurs.push(`${f.nom} (${e.name === "AbortError" ? "pas de réponse en 2 minutes" : e.message})`);
    } finally {
      clearTimeout(minuterie);
    }
  }
  etat.echange.erreurDocuments = erreurs.length ? "Document(s) pas encore reçu(s) : " + erreurs.join(" ; ") + ". Nouvel essai au prochain échange." : null;
}

async function etatDocuments() {
  const index = await lire("reglages", "documents-index");
  const locaux = new Set((await lireTout("documents")).map((d) => d.nom));
  if (!index) return { connu: false };
  const noms = [...new Set(index.valeur.map((x) => x.fichier))];
  return { connu: true, total: noms.length, presents: noms.filter((n) => locaux.has(n)).length, manquantsDrive: index.manquants || [] };
}

// ---------- Affichage de pages d'un PDF gardé sur l'appareil ----------
async function afficherPages(conteneur, ligne) {
  const doc = await lire("documents", ligne.fichier);
  if (!doc) {
    // règle 14 : juste après une installation, la copie est EN COURS (constat du Vérificateur sur dd9a412)
    conteneur.replaceChildren(etat.echange && etat.echange.copieDocumentsEnCours
      ? el("p", { class: "note-permis", "data-document": "copie-en-cours" },
        "Copie des documents en cours sur cet appareil. Revenez sur cet écran dans un moment.")
      : el("p", { class: "note-permis", "data-document": "absent" },
        "Ce document n'est pas encore sur cet appareil. Connectez-le au Wifi : il sera copié au prochain échange avec Google."));
    return false;
  }
  if (!window.pdfjsLib) {
    conteneur.replaceChildren(el("p", { class: "note-permis" }, "Impossible d'afficher le document : l'outil d'affichage (PDF.js) n'est pas chargé."));
    return false;
  }
  try {
    // isEvalSupported:false : un PDF ne peut jamais faire exécuter du code (faille CVE-2024-4367 de PDF.js 3.11)
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(doc.donnees.slice(0)), isEvalSupported: false }).promise;
    const fin = ligne.page_fin && ligne.page_fin <= pdf.numPages ? ligne.page_fin : pdf.numPages;
    conteneur.replaceChildren();
    const largeur = Math.max(300, conteneur.clientWidth || document.getElementById("ecran").clientWidth - 32);
    for (let n = ligne.page_debut; n <= fin; n++) {
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const vue = page.getViewport({ scale: (largeur / base.width) * (window.devicePixelRatio || 1) });
      const canvas = el("canvas", { class: "page-document", "data-page": n });
      canvas.width = vue.width; canvas.height = vue.height;
      canvas.style.width = "100%";
      conteneur.append(canvas);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vue }).promise;
    }
    return true;
  } catch (e) {
    conteneur.replaceChildren(el("p", { class: "note-permis" }, "Impossible d'afficher le document (" + e.message + ")."));
    return false;
  }
}

// Toutes les lignes de l'onglet « Documents » pour ce code, dans l'ordre de l'onglet
// (pour un guide : le guide d'apprentissage, puis ses fiches techniques – D121).
async function lignesDocument(code) {
  const index = await lire("reglages", "documents-index");
  return index ? index.valeur.filter((x) => x.code === code) : [];
}

async function afficherLignes(conteneur, lignes) {
  conteneur.replaceChildren();
  for (const ligne of lignes) {
    const bloc = el("div", { class: "bloc-document" });
    conteneur.append(el("h2", { class: "titre-document" }, ligne.titre || ""), bloc);
    await afficherPages(bloc, ligne);
  }
}

// ---------- Le guide d'apprentissage avant la fiche (D109) ----------
async function ecranDocumentGuide(salarie, guide) {
  effacerAlerte();
  const passer = () => el("button", { class: "gros principal", onclick: () => nouvelleFiche(salarie, guide) }, "Passer à la fiche de fin de guide");
  const pages = el("div", { class: "pages-document" }, el("p", { class: "qui" }, "Chargement du document…"));
  afficher(
    el("div", { class: "barre" }, el("h1", {}, `${guide.code} – ${guide.titre}`),
      el("button", { class: "petit", onclick: () => ecranChoixGuide(salarie) }, "Retour"),
      el("button", { class: "petit", onclick: () => ecranAide(() => ecranDocumentGuide(salarie, guide)) }, "Aide")),
    el("p", { class: "qui" }, `Salarié : ${nomSalarie(salarie)} · Guide d'apprentissage`),
    passer(), pages, passer(),
  );
  const lignes = await lignesDocument(guide.code);
  if (!lignes.length) pages.replaceChildren(el("p", { class: "note-permis", "data-document": "inconnu" },
    "Aucun document n'est indiqué pour ce guide dans l'onglet « Documents » de la feuille Google (à compléter par la direction)."));
  else await afficherLignes(pages, lignes);
}

// ---------- Le bouton d'aide (D113) ----------
async function ecranAide(retour) {
  effacerAlerte();
  const zone = el("div", { class: "pages-document" });
  const bouton = (code, titre) => el("button", { class: "gros", onclick: async () => {
    zone.replaceChildren(el("h2", {}, titre), el("p", { class: "qui" }, "Chargement…"));
    const lignes = await lignesDocument(code);
    const pages = el("div");
    zone.replaceChildren(el("h2", {}, titre), pages);
    if (!lignes.length) pages.append(el("p", { class: "note-permis" }, "Ce document n'est pas indiqué dans l'onglet « Documents » de la feuille Google."));
    else for (const ligne of lignes) { const bloc = el("div"); pages.append(bloc); await afficherPages(bloc, ligne); }
  } }, titre);
  afficher(
    el("div", { class: "barre" }, el("h1", {}, "Aide"), el("button", { class: "petit", onclick: () => retour() }, "Retour")),
    bouton("AIDE-MODE-EMPLOI", "Mode d'emploi"),
    bouton("AIDE-EVALUATEUR", "Guide de l'évaluateur"),
    zone,
    el("p", { class: "qui" }, "Affichage des documents : PDF.js (Mozilla), licence Apache 2.0 – ",
      el("button", { class: "petit", id: "voir-licence", onclick: () => ecranLicence(() => ecranAide(retour)) }, "texte de la licence"), "."),
  );
}

// D211 : la licence s'affiche dans l'application (un lien ouvrait une page à part et faisait sortir de l'application)
async function ecranLicence(retour) {
  effacerAlerte();
  const texte = el("pre", { class: "texte-licence", id: "texte-licence" }, "Chargement…");
  afficher(el("div", { class: "barre" }, el("h1", {}, "Licence de PDF.js"), el("button", { class: "petit", onclick: () => retour() }, "Retour")), texte);
  try {
    const r = await fetch("LICENSE-pdfjs");
    if (!r.ok) throw new Error("code " + r.status);
    texte.textContent = await r.text();
  } catch (e) { texte.textContent = ""; alerte("Le texte de la licence n'a pas pu être lu sur cet appareil (" + e.message + ")."); }
}
