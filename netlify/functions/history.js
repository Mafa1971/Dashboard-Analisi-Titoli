// Storico condiviso tra dispositivi, salvato come UN UNICO file JSON su
// Netlify Blobs (chiave "history"). Progettato per uso da UN dispositivo
// alla volta: ogni scrittura sovrascrive l'intero file, quindi se due
// dispositivi salvano contemporaneamente l'ultimo vince e l'altro perde
// le proprie modifiche non ancora sincronizzate — accettabile per un uso
// personale a singolo utente, ma non usare due schede/dispositivi insieme.
exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  // Il require() viene fatto QUI DENTRO (non in cima al file) e in un
  // try/catch: se il modulo non fosse installato correttamente in fase di
  // build, un require() a livello di file farebbe crashare l'intera
  // function con un errore 500 muto, senza nessun corpo JSON — così invece
  // otteniamo un messaggio leggibile per capire la vera causa.
  let getStore;
  try {
    ({ getStore } = require("@netlify/blobs"));
  } catch (err) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({
        error: "Impossibile caricare la libreria @netlify/blobs: " + err.message,
        hint: "La dipendenza probabilmente non è stata installata in fase di build. Verifica che package.json contenga \"@netlify/blobs\" tra le dependencies, poi rifai un deploy con 'Clear cache and deploy site'."
      })
    };
  }

  function getHistoryStore() {
    // Su alcuni siti Netlify l'auto-configurazione di Blobs non funziona da
    // sola — serve passare esplicitamente siteID e un access token, salvati
    // come variabili d'ambiente (stesso procedimento fatto per
    // ALPHA_VANTAGE_KEY e ANTHROPIC_API_KEY).
    const siteID = process.env.BLOBS_SITE_ID;
    const token = process.env.BLOBS_TOKEN;
    if (siteID && token) {
      return getStore({ name: "analyzer-history", siteID, token });
    }
    return getStore("analyzer-history"); // tentativo automatico, come fallback
  }

  let store;
  try {
    store = getHistoryStore();
  } catch (err) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({
        error: "Netlify Blobs non configurato: " + err.message,
        hint: "Controlla che le variabili d'ambiente BLOBS_SITE_ID e BLOBS_TOKEN siano impostate correttamente su Netlify (Site settings → Environment variables)."
      })
    };
  }

  if (event.httpMethod === "GET") {
    try {
      const data = await store.get("history", { type: "json" });
      return { statusCode: 200, headers, body: JSON.stringify(data || []) };
    } catch (err) {
      // Chiave non ancora esistente = storico vuoto, comportamento normale, non un errore
      return { statusCode: 200, headers, body: JSON.stringify([]) };
    }
  }

  if (event.httpMethod === "POST") {
    try {
      const bodyRaw = event.body || "[]";
      const body = JSON.parse(bodyRaw);
      if (!Array.isArray(body)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Il corpo della richiesta deve essere un array" }) };
      }
      await store.setJSON("history", body);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, count: body.length }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Errore durante il salvataggio: " + err.message }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: "Metodo non consentito" }) };
};
