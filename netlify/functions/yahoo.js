// netlify/functions/yahoo.js
// Proxy verso l'API pubblica di Yahoo Finance (chart endpoint + quoteSummary).
// Serve a bypassare il CORS: il browser chiama questa function,
// la function chiama Yahoo dal server e restituisce il JSON al browser.

const commonHeaders = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
};

// ── Autenticazione "crumb/cookie" per quoteSummary ──────────────────────
// Da un po' di tempo Yahoo risponde 401 a quoteSummary se la richiesta non
// porta un cookie di sessione valido + un "crumb" (token anti-CSRF) legato
// a quel cookie. Il flusso (lo stesso usato da librerie come yfinance):
//   1) GET https://fc.yahoo.com/            → ottiene i cookie di sessione
//   2) GET .../v1/test/getcrumb (con quei cookie) → ottiene il crumb
//   3) la chiamata vera porta sia i cookie che ?crumb=... in coda all'URL
// Cache in memoria di modulo: su un container "caldo" di Netlify le
// invocazioni successive riusano lo stesso crumb per ~50 minuti, evitando
// 2 richieste extra ad ogni chiamata.
let cachedAuth = null; // { cookie, crumb, at }
const AUTH_TTL_MS = 50 * 60 * 1000;

function extractSetCookies(res) {
  if (typeof res.headers.getSetCookie === "function") {
    const all = res.headers.getSetCookie();
    if (all && all.length) return all;
  }
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

async function getYahooAuth() {
  const now = Date.now();
  if (cachedAuth && (now - cachedAuth.at) < AUTH_TTL_MS) return cachedAuth;

  const res1 = await fetch("https://fc.yahoo.com", { headers: commonHeaders, redirect: "manual" });
  const setCookies = extractSetCookies(res1);
  const cookie = setCookies.map(c => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("Yahoo non ha restituito cookie di sessione (fc.yahoo.com)");

  const res2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { ...commonHeaders, Cookie: cookie }
  });
  const crumb = (await res2.text()).trim();
  if (!crumb || crumb.length > 100 || crumb.toLowerCase().includes("<html")) {
    throw new Error("Yahoo non ha restituito un crumb valido");
  }

  cachedAuth = { cookie, crumb, at: now };
  return cachedAuth;
}

// Esegue una chiamata autenticata (cookie+crumb) verso un URL Yahoo
// costruito da `buildUrl(auth)`; se l'autenticazione fallisce o la chiamata
// torna comunque 401, ritenta UNA volta forzando un nuovo handshake (il
// crumb in cache potrebbe essere scaduto lato Yahoo prima del previsto).
async function fetchYahooAuth(buildUrl) {
  let auth = await getYahooAuth();
  let res = await fetch(buildUrl(auth), { headers: { ...commonHeaders, Cookie: auth.cookie } });
  if (res.status === 401) {
    cachedAuth = null; // forza un nuovo handshake
    auth = await getYahooAuth();
    res = await fetch(buildUrl(auth), { headers: { ...commonHeaders, Cookie: auth.cookie } });
  }
  return res;
}

function fetchQuoteSummaryAuth(ticker, modules) {
  return fetchYahooAuth(auth =>
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}&crumb=${encodeURIComponent(auth.crumb)}`
  );
}

exports.handler = async function (event) {
  const { ticker, range = "max", interval = "1d", period1, period2, type } = event.queryStringParameters || {};

  if (!ticker) {
    return {
      statusCode: 400,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Parametro 'ticker' mancante" })
    };
  }

  // type=quoteSummary: dati di mercato attuali (P/E, dividend yield, market cap,
  // target price analisti). Endpoint NON garantito al 100%: se Yahoo cambia
  // ancora le regole di autenticazione, il frontend deve sempre prevedere un
  // fallback (Alpha Vantage OVERVIEW) se questa chiamata fallisce o torna
  // dati vuoti.
  if (type === "quoteSummary") {
    const modules = "price,summaryDetail,defaultKeyStatistics,financialData,assetProfile";
    try {
      const res = await fetchQuoteSummaryAuth(ticker, modules);
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

  // type=fundamentals: bilanci annuali (conto economico, stato patrimoniale,
  // flussi di cassa) via l'endpoint "fundamentals-timeseries" — lo stesso
  // che alimenta oggi la pagina Financials di finance.yahoo.com, con una
  // copertura internazionale (Borsa Italiana inclusa) molto più ampia del
  // vecchio modulo quoteSummary "balanceSheetHistory" (che per molti titoli
  // non-USA torna vuoto pur avendo conto economico/cash flow popolati).
  // NOTA: i nomi esatti dei campi ("annualStockholdersEquity" ecc.) sono gli
  // stessi usati da librerie come yfinance, ma Yahoo può cambiarli senza
  // preavviso — se un campo smette di arrivare, nel frontend risulterà
  // semplicemente null (nessun crash) e andrà aggiornato qui il nome campo.
  if (type === "fundamentals") {
    const types = [
      "annualTotalRevenue", "annualNetIncome", "annualGrossProfit", "annualEBIT",
      "annualTotalAssets", "annualStockholdersEquity", "annualRetainedEarnings",
      "annualCurrentAssets", "annualCurrentLiabilities", "annualLongTermDebt",
      "annualTotalLiabilitiesNetMinorityInterest", "annualOrdinarySharesNumber",
      "annualOperatingCashFlow", "annualCapitalExpenditure"
    ].join(",");
    const nowSec = Math.floor(Date.now() / 1000);
    const period1 = nowSec - 15 * 365 * 24 * 3600; // ~15 anni di storico, poi il frontend tiene gli ultimi 8
    try {
      const res = await fetchYahooAuth(auth =>
        `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(ticker)}?symbol=${encodeURIComponent(ticker)}&type=${types}&period1=${period1}&period2=${nowSec}&crumb=${encodeURIComponent(auth.crumb)}`
      );
      if (!res.ok) {
        return { statusCode: res.status, headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ error: `Yahoo fundamentals-timeseries ha risposto con status ${res.status}` }) };
      }
      const data = await res.json();
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" },
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
