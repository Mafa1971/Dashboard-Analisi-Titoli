// netlify/functions/fundamentals.js
// Proxy verso Alpha Vantage per i dati di bilancio (conto economico,
// stato patrimoniale, flussi di cassa). La chiave API NON è scritta qui:
// viene letta da una variabile d'ambiente impostata su Netlify
// (Site configuration → Environment variables → ALPHA_VANTAGE_KEY),
// così non finisce mai nel codice pubblico su GitHub.

exports.handler = async function (event) {
  const { ticker, statement = "income" } = event.queryStringParameters || {};

  if (!ticker) {
    return {
      statusCode: 400,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Parametro 'ticker' mancante" })
    };
  }

  const apiKey = process.env.ALPHA_VANTAGE_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "ALPHA_VANTAGE_KEY non configurata su Netlify (Site configuration → Environment variables)" })
    };
  }

  const fnMap = { income: "INCOME_STATEMENT", balance: "BALANCE_SHEET", cashflow: "CASH_FLOW", overview: "OVERVIEW" };
  const fn = fnMap[statement] || "INCOME_STATEMENT";
  const url = `https://www.alphavantage.co/query?function=${fn}&symbol=${encodeURIComponent(ticker)}&apikey=${encodeURIComponent(apiKey)}`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600" // dati di bilancio cambiano poco, cache 1 ora
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
