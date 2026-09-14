// Proxy verso Supabase per i portafogli ottimali costruiti dalla Watchlist.
// Usa la service_role key (mai esposta al browser) per leggere/scrivere le
// tabelle qa_portfolios e qa_portfolio_equity — lo stesso progetto Supabase
// già usato dal Coma Screener (schema separato, tabelle nuove).
//
// Variabili d'ambiente richieste su Netlify (stesse credenziali già usate
// come GitHub Secrets per il Coma Screener):
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
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

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: "Variabili d'ambiente SUPABASE_URL / SUPABASE_SERVICE_KEY non configurate su Netlify." })
    };
  }

  const sbHeaders = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": "Bearer " + SUPABASE_SERVICE_KEY,
    "Content-Type": "application/json"
  };

  // GET → restituisce { portfolios: [...], equity: [...], ratings: [...] }
  if (event.httpMethod === "GET") {
    try {
      const [portfoliosRes, equityRes, ratingsRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/qa_portfolios?select=*`, { headers: sbHeaders }),
        fetch(`${SUPABASE_URL}/rest/v1/qa_portfolio_equity?select=*&order=date.asc`, { headers: sbHeaders }),
        fetch(`${SUPABASE_URL}/rest/v1/qa_portfolio_ratings?select=*&order=date.desc`, { headers: sbHeaders })
      ]);
      if (!portfoliosRes.ok) throw new Error("qa_portfolios: " + portfoliosRes.status);
      if (!equityRes.ok) throw new Error("qa_portfolio_equity: " + equityRes.status);
      if (!ratingsRes.ok) throw new Error("qa_portfolio_ratings: " + ratingsRes.status);
      const portfolios = await portfoliosRes.json();
      const equity = await equityRes.json();
      const ratings = await ratingsRes.json();
      return { statusCode: 200, headers, body: JSON.stringify({ portfolios, equity, ratings }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Errore lettura Supabase: " + err.message }) };
    }
  }

  // POST → upsert di uno o più portafogli in qa_portfolios
  // Body atteso: { portfolios: [{ portfolio_name, inception_date, budget, holdings, last_rebalance_date }, ...] }
  if (event.httpMethod === "POST") {
    try {
      const body = JSON.parse(event.body || "{}");
      const list = body.portfolios;
      if (!Array.isArray(list) || list.length === 0) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Il corpo deve contenere 'portfolios' (array non vuoto)" }) };
      }
      const res = await fetch(`${SUPABASE_URL}/rest/v1/qa_portfolios?on_conflict=portfolio_name`, {
        method: "POST",
        headers: { ...sbHeaders, "Prefer": "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(list.map(p => ({ ...p, updated_at: new Date().toISOString() })))
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error("status " + res.status + " — " + errText);
      }
      const saved = await res.json();
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, saved }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Errore scrittura Supabase: " + err.message }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: "Metodo non consentito" }) };
};
