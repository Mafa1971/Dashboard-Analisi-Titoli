// netlify/functions/yahoo.js
// Proxy verso l'API pubblica di Yahoo Finance (chart endpoint).
// Serve a bypassare il CORS: il browser chiama questa function,
// la function chiama Yahoo dal server e restituisce il JSON al browser.

exports.handler = async function (event) {
  const { ticker, range = "max", interval = "1d", period1, period2, type } = event.queryStringParameters || {};

  if (!ticker) {
    return {
      statusCode: 400,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Parametro 'ticker' mancante" })
    };
  }

  const commonHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
  };

  // type=quoteSummary: dati di mercato attuali (P/E, dividend yield, market cap,
  // target price analisti). Endpoint NON garantito: Yahoo a volte richiede
  // un'autenticazione "crumb/cookie" che cambia senza preavviso — per questo
  // il frontend deve sempre prevedere un fallback (Alpha Vantage OVERVIEW)
  // se questa chiamata fallisce o torna dati vuoti.
  if (type === "quoteSummary") {
    const modules = "price,summaryDetail,defaultKeyStatistics,financialData,assetProfile";
    const qsUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}`;
    try {
      const res = await fetch(qsUrl, { headers: commonHeaders });
      if (!res.ok) {
        return { statusCode: res.status, headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ error: `Yahoo quoteSummary ha risposto con status ${res.status}` }) };
      }
      const data = await res.json();
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" },
        body: JSON.stringify(data)
      };
    } catch (err) {
      return { statusCode: 500, headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ error: err.message }) };
    }
  }

  // Con period1/period2 espliciti Yahoo restituisce dati giornalieri reali
  // anche su archi lunghi, evitando l'aggregazione automatica che avviene
  // a volte con range=max (che può ridurre i punti a poche decine).
  const url = (period1 && period2)
    ? `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${encodeURIComponent(period1)}&period2=${encodeURIComponent(period2)}&interval=${encodeURIComponent(interval)}`
    : `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`;

  try {
    const res = await fetch(url, { headers: commonHeaders });

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
