const { getStore } = require("@netlify/blobs");

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

  let store;
  try {
    store = getStore("analyzer-history");
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Netlify Blobs non disponibile: " + err.message }) };
  }

  if (event.httpMethod === "GET") {
    try {
      const data = await store.get("history", { type: "json" });
      return { statusCode: 200, headers, body: JSON.stringify(data || []) };
    } catch (err) {
      return { statusCode: 200, headers, body: JSON.stringify([]) }; // chiave non ancora esistente = storico vuoto, non un errore
    }
  }

  if (event.httpMethod === "POST") {
    try {
      const body = JSON.parse(event.body || "[]");
      if (!Array.isArray(body)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Il corpo della richiesta deve essere un array" }) };
      }
      await store.setJSON("history", body);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, count: body.length }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: "Metodo non consentito" }) };
};
