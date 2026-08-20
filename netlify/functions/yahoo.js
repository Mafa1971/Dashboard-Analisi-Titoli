// netlify/functions/yahoo.js
// Proxy verso l'API pubblica di Yahoo Finance (chart endpoint).
// Serve a bypassare il CORS: il browser chiama questa function,
// la function chiama Yahoo dal server e restituisce il JSON al browser.

exports.handler = async function (event) {
  const { ticker, range = "max", interval = "1d" } = event.queryStringParameters || {};

  if (!ticker) {
    return {
      statusCode: 400,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Parametro 'ticker' mancante" })
    };
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`;

  try {
    const res = await fetch(url, {
      headers: {
        // Yahoo a volte blocca richieste senza uno User-Agent "da browser"
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
      }
    });

    if (!res.ok) {
      return {
        statusCode: res.status,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: `Yahoo ha risposto con status ${res.status}` })
      };
    }

    const data = await res.json();

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=60"
      },
      body: JSON.stringify(data)
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: err.message })
    };
  }
};
