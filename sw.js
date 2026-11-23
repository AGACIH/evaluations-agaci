// Service worker de l'application AGACI : garde les fichiers de l'application sur l'appareil,
// pour qu'elle s'ouvre même sans réseau (D5 : fonctionnement sans internet sur le chantier).
// Les données (fiches, journal) ne passent jamais par ici : elles sont dans IndexedDB.
// À CHAQUE nouvelle publication, changer VERSION (et la même valeur dans app.js) : le test « version » le vérifie.
const VERSION = "2026-11-23-4";
const CACHE = "agaci-appli-" + VERSION;
const FICHIERS = ["./", "index.html", "style.css", "app.js", "echange.js", "documents.js", "pdf.min.js", "pdf.worker.min.js",
  "manifest.json", "icone-192.png", "icone-512.png", "LICENSE-pdfjs"]; // D211 : licence lisible aussi sans réseau

self.addEventListener("install", (ev) => {
  // « reload » : on va chercher les fichiers sur le serveur, jamais dans le cache du navigateur,
  // sinon une nouvelle version pourrait se remplir avec les ANCIENS fichiers (constat du Vérificateur)
  // Fichiers chargés l'un après l'autre : en parallèle, un petit serveur peut échouer (constaté avec les gros fichiers de PDF.js).
  // Si un seul fichier manque, l'installation échoue entièrement : jamais une version incomplète.
  ev.waitUntil((async () => {
    const c = await caches.open(CACHE);
    for (const f of FICHIERS) {
      const r = await fetch(new Request(f, { cache: "reload" }));
      if (!r.ok) throw new Error(f + " : " + r.status);
      await c.put(f, r);
    }
    await self.skipWaiting();
  })().catch(async (e) => { await caches.delete(CACHE); throw e; }));
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil(caches.keys()
    .then((cles) => Promise.all(cles.filter((k) => k.startsWith("agaci-appli-") && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Seuls les fichiers de l'application (même adresse, lecture) sont servis depuis l'appareil.
// Les échanges avec Google (autre adresse) ne sont jamais interceptés.
self.addEventListener("fetch", (ev) => {
  const req = ev.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  ev.respondWith(
    caches.open(CACHE).then(async (c) => {
      const enCache = await c.match(req, { ignoreSearch: true }) || (req.mode === "navigate" ? await c.match("index.html") : undefined);
      if (enCache) return enCache;
      return fetch(req);
    })
  );
});
