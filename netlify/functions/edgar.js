// netlify/functions/edgar.js
// Proxy verso SEC EDGAR (dati ufficiali, gratuiti, senza chiave) solo per società quotate negli USA.
//   ?ticker=NVDA&type=facts    → bilanci annuali (fino a 12 anni) già nel formato righe dell'app
//   ?ticker=NVDA&type=filings  → Form 4 (insider, ultimi 90 gg), 8-K (ultimi 180 gg), NT 10-K/10-Q, 13D/13G, S-3/424B, Form 144
// La SEC richiede uno User-Agent che identifichi chi chiama, con un contatto.
// Imposta su Netlify (Site configuration → Environment variables) la variabile SEC_USER_AGENT,
// ad esempio:  NomeApp tuo-contatto@esempio.it
// Limite SEC: 10 richieste/secondo (qui restiamo molto sotto).

const UA = process.env.SEC_USER_AGENT || "QuantAnalyses (imposta SEC_USER_AGENT)";
const HDR = { "User-Agent": UA, "Accept": "application/json, text/xml, */*" };
const CORS = { "Access-Control-Allow-Origin": "*" };

let tickerMap = null, tickerMapAt = 0;
async function getCik(ticker) {
  const now = Date.now();
  if (!tickerMap || now - tickerMapAt > 24 * 3600 * 1000) {
    const r = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: HDR });
    if (!r.ok) throw new Error(`SEC company_tickers ha risposto con status ${r.status}`);
    const j = await r.json();
    tickerMap = {};
    Object.values(j).forEach(e => { if (e && e.ticker) tickerMap[String(e.ticker).toUpperCase()] = { cik: e.cik_str, name: e.title }; });
    tickerMapAt = now;
  }
  const key = String(ticker).toUpperCase().replace(/\./g, "-");
  return tickerMap[key] || null;
}
const pad10 = c => String(c).padStart(10, "0");

// ── bilanci (companyfacts) ────────────────────────────────────────────
const FORMS = new Set(["10-K", "10-K/A", "10-KT", "20-F", "40-F"]);
function pick(facts, tags, unit, kind, earliest) {
  const out = {};
  for (const tag of tags) {
    const ns = tag.indexOf(":") > 0 ? tag.split(":")[0] : "us-gaap", nm = tag.indexOf(":") > 0 ? tag.split(":")[1] : tag;
    const node = facts[ns] && facts[ns][nm] && facts[ns][nm].units && facts[ns][nm].units[unit];
    if (!node) continue;
    const tmp = {};
    for (const e of node) {
      if (!FORMS.has(e.form)) continue;
      if (e.fp && e.fp !== "FY") continue;
      if (kind === "flow") {
        if (!e.start) continue;
        const d = (Date.parse(e.end) - Date.parse(e.start)) / 864e5;
        if (!(d >= 340 && d <= 380)) continue;
      }
      const cur = tmp[e.end];
      if (!cur || (earliest ? e.filed < cur.filed : e.filed > cur.filed)) tmp[e.end] = { val: e.val, filed: e.filed };
    }
    for (const end in tmp) if (!(end in out)) out[end] = tmp[end].val; // tag successivi riempiono gli anni mancanti (cambi di tassonomia)
  }
  return out;
}
function buildRows(json, maxYears, splits) {
  const f = json.facts || {};
  const rev = pick(f, ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet", "SalesRevenueGoodsNet", "RevenueFromContractWithCustomerIncludingAssessedTax"], "USD", "flow");
  const ni = pick(f, ["NetIncomeLoss", "ProfitLoss"], "USD", "flow");
  const gp = pick(f, ["GrossProfit"], "USD", "flow");
  const ebit = pick(f, ["OperatingIncomeLoss"], "USD", "flow");
  const da = pick(f, ["DepreciationDepletionAndAmortization", "DepreciationAndAmortization", "DepreciationAmortizationAndAccretionNet"], "USD", "flow");
  const opcf = pick(f, ["NetCashProvidedByUsedInOperatingActivities"], "USD", "flow");
  // capex: prima le voci note, poi (per gli anni ancora vuoti) qualsiasi voce di pagamento per immobilizzazioni/investimenti produttivi
  const capexTags = Object.keys(f["us-gaap"] || {}).filter(t => /^Payments(ToAcquire|For)(Productive|PropertyPlant|Property|CapitalImprovements|OtherPropertyPlant)/.test(t) && !/Business|Investment|Intangible$|Software|Land|Mineral|Oil|RealEstate|Equity/i.test(t.replace("PropertyPlantAndEquipmentAndIntangibleAssets", "PPEIA")));
  // voci personalizzate dell'azienda (altri spazi di nomi, es. "nvda"): acquisti di immobilizzazioni
  const customCapex = [];
  Object.keys(f).forEach(ns => { if (ns === "us-gaap" || ns === "dei" || ns === "srt" || ns === "invest") return;
    Object.keys(f[ns]).forEach(t => { if (/^(Payments|Purchases?)[A-Za-z]*(Property|Equipment|Capital|Productive)/.test(t) && !/Business|Securit|Investment|Acquisition|Lease|Software/i.test(t)) customCapex.push(ns + ":" + t); }); });
  const capex = pick(f, ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets", "PaymentsToAcquirePropertyPlantAndEquipmentAndIntangibleAssets", "PaymentsForCapitalImprovements", "PaymentsToAcquireOtherPropertyPlantAndEquipment"].concat(capexTags, customCapex), "USD", "flow");
  const assets = pick(f, ["Assets"], "USD", "inst");
  const eq = pick(f, ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"], "USD", "inst");
  const liab = pick(f, ["Liabilities"], "USD", "inst");
  const ca = pick(f, ["AssetsCurrent"], "USD", "inst");
  const cl = pick(f, ["LiabilitiesCurrent"], "USD", "inst");
  const ltd = pick(f, ["LongTermDebtNoncurrent", "LongTermDebt"], "USD", "inst");
  const re = pick(f, ["RetainedEarningsAccumulatedDeficit"], "USD", "inst");
  const sh = pick(f, ["CommonStockSharesOutstanding"], "shares", "inst", true); // valore come riportato all'epoca (prima degli split successivi)
  const shW = pick(f, ["WeightedAverageNumberOfDilutedSharesOutstanding", "WeightedAverageNumberOfSharesOutstandingBasic"], "shares", "flow", true);
  const ends = Array.from(new Set([...Object.keys(rev), ...Object.keys(ni)])).sort();
  return ends.slice(-maxYears).map(end => {
    const g = m => (m[end] != null ? m[end] : null);
    const revenue = g(rev), netIncome = g(ni);
    let shares = g(sh) != null ? g(sh) : g(shW);
    if (shares != null && splits && splits.length) { const t = Date.parse(end); splits.forEach(s => { if (s.t > t) shares *= s.ratio; }); } // porta le azioni alla base di oggi
    const o = g(opcf), cx = g(capex), e = g(ebit), d = g(da);
    let tl = g(liab); if (tl == null && g(assets) != null && g(eq) != null) tl = g(assets) - g(eq);
    return {
      year: end, revenue, netIncome,
      netMargin: (revenue && netIncome != null) ? netIncome / revenue * 100 : null,
      ebitda: (e != null && d != null) ? e + d : null, ebit: e, grossProfit: g(gp),
      eps: (netIncome != null && shares) ? netIncome / shares : null,
      totalAssets: g(assets), totalEquity: g(eq), totalLiab: tl,
      totalCurrentAssets: g(ca), totalCurrentLiab: g(cl), longTermDebt: g(ltd), retainedEarnings: g(re),
      sharesOutstanding: shares, opCF: o, fcf: (o != null && cx != null) ? o - Math.abs(cx) : null
    };
  });
}

// Frazionamenti (split) del titolo da Yahoo: servono per rendere confrontabili le azioni in circolazione nel tempo,
// perché i prezzi storici sono già corretti per gli split.
async function getSplits(ticker) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=max&interval=3mo&events=split`, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" } });
    if (!r.ok) return null;
    const j = await r.json(); const ev = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].events;
    if (!ev || !ev.splits) return [];
    return Object.values(ev.splits).map(s => ({ t: (s.date || 0) * 1000, ratio: (s.numerator && s.denominator) ? s.numerator / s.denominator : 1 })).filter(s => s.t > 0 && s.ratio > 0);
  } catch (e) { return null; }
}

// ── Form 4 ───────────────────────────────────────────────────────────
function tag1(xml, t) { const m = xml.match(new RegExp("<" + t + ">\\s*([^<]*?)\\s*</" + t + ">")); return m ? m[1] : null; }
function val1(block, t) { const m = block.match(new RegExp("<" + t + ">[\\s\\S]*?<value>\\s*([^<]*?)\\s*</value>")); return m ? m[1] : null; }
function parseForm4(xml) {
  const owner = tag1(xml, "rptOwnerName") || "n.d.";
  const relB = (xml.match(/<reportingOwnerRelationship>([\s\S]*?)<\/reportingOwnerRelationship>/) || [])[1] || "";
  const flag = t => { const v = tag1(relB, t); return v === "1" || v === "true"; };
  const title = tag1(relB, "officerTitle");
  const role = flag("isOfficer") ? (title || "dirigente") : (flag("isDirector") ? "consigliere" : (flag("isTenPercentOwner") ? "azionista >10%" : "altro"));
  const plan = /10b5-1/i.test(xml) || /<aff10b5One>\s*(1|true)\s*<\/aff10b5One>/i.test(xml); // casella "operazione eseguita secondo un piano 10b5-1" (Form 4 dal 2023) o nota
  const txs = [];
  const re = /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g; let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const shares = parseFloat(val1(b, "transactionShares")), price = parseFloat(val1(b, "transactionPricePerShare"));
    txs.push({ date: val1(b, "transactionDate"), code: tag1(b, "transactionCode"), ad: val1(b, "transactionAcquiredDisposedCode"), shares: isFinite(shares) ? shares : null, price: isFinite(price) ? price : null });
  }
  return { owner, role, plan, txs };
}
async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = null; } } }));
  return out;
}
const RISK8K = { "4.02": "bilanci passati non più affidabili (restatement)", "1.03": "fallimento o amministrazione controllata", "3.01": "rischio di esclusione dalla quotazione", "4.01": "cambio del revisore", "5.02": "partenza o nomina di dirigenti/consiglieri", "2.04": "accelerazione di obblighi di debito", "2.06": "svalutazione rilevante (impairment)", "1.02": "risoluzione di un contratto rilevante" };

async function filings(cik, info) {
  const r = await fetch(`https://data.sec.gov/submissions/CIK${pad10(cik)}.json`, { headers: HDR });
  if (!r.ok) throw new Error(`SEC submissions ha risposto con status ${r.status}`);
  const sub = await r.json(); const rc = (sub.filings && sub.filings.recent) || {};
  const n = (rc.form || []).length, now = Date.now(), day = 864e5;
  const list = [];
  for (let i = 0; i < n; i++) list.push({ form: rc.form[i], date: rc.filingDate[i], acc: rc.accessionNumber[i], doc: rc.primaryDocument[i], items: rc.items ? rc.items[i] : "" });
  const age = x => (now - Date.parse(x.date)) / day;
  const f4 = list.filter(x => /^4(\/A)?$/.test(x.form) && age(x) <= 90).slice(0, 30);
  const parsed = await mapLimit(f4, 4, async x => {
    const raw = x.doc.replace(/^xsl[^/]*\//, "");
    const url = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${x.acc.replace(/-/g, "")}/${raw}`;
    const t = await fetch(url, { headers: HDR }); if (!t.ok) return null;
    const p = parseForm4(await t.text()); p.filed = x.date; return p;
  });
  const tx = [];
  parsed.filter(Boolean).forEach(p => p.txs.forEach(t => { if (t.code === "P" || t.code === "S") tx.push({ filed: p.filed, owner: p.owner, role: p.role, plan: p.plan, date: t.date, code: t.code, shares: t.shares, price: t.price, value: (t.shares != null && t.price != null) ? t.shares * t.price : null }); }));
  const eightK = list.filter(x => /^8-K/.test(x.form) && age(x) <= 180).map(x => { const items = (x.items || "").split(",").map(s => s.trim()).filter(Boolean); return { date: x.date, items, risk: items.filter(i => RISK8K[i]).map(i => ({ item: i, text: RISK8K[i] })) }; });
  const other = list.filter(x => (/^NT 10-[KQ]/.test(x.form) && age(x) <= 365) || (/^(SC 13D|SC 13G|SCHEDULE 13D|SCHEDULE 13G)/.test(x.form) && age(x) <= 180) || (/^(S-3|424B|S-1|144)/.test(x.form) && age(x) <= 180)).map(x => ({ form: x.form, date: x.date }));
  return { name: info.name, form4Count: f4.length, form4Parsed: parsed.filter(Boolean).length, tx, eightK, other };
}

exports.handler = async function (event) {
  const { ticker, type = "facts" } = event.queryStringParameters || {};
  const send = (code, obj, cache) => ({ statusCode: code, headers: { ...CORS, "Content-Type": "application/json", ...(cache ? { "Cache-Control": cache } : {}) }, body: JSON.stringify(obj) });
  if (type === "debug") {
    const ua = process.env.SEC_USER_AGENT || "";
    return send(200, { variabilePresente: !!ua, lunghezza: ua.length, contieneChiocciola: ua.includes("@"), parole: ua.trim().split(/\s+/).filter(Boolean).length });
  }
  if (!ticker) return send(400, { error: "Parametro 'ticker' mancante" });
  try {
    if (/[:=^]/.test(ticker) || (/\./.test(ticker) && !/^[A-Za-z]+\.[A-Za-z]$/.test(ticker))) return send(404, { error: "non-US", us: false });
    const info = await getCik(ticker);
    if (!info) return send(404, { error: "non-US", us: false });
    if (type === "facts") {
      const r = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${pad10(info.cik)}.json`, { headers: HDR });
      if (!r.ok) return send(r.status, { error: `SEC companyfacts ha risposto con status ${r.status}` });
      const [json, splits] = await Promise.all([r.json(), getSplits(ticker)]);
      const rows = buildRows(json, 12, splits);
      return send(200, { us: true, name: info.name, cik: info.cik, rows, splitsApplied: splits ? splits.length : null, splitAdjusted: splits !== null }, "public, max-age=21600");
    }
    if (type === "tags") {
      // diagnostica: voci us-gaap di flusso (annuali, da 10-K) il cui nome ricorda pagamenti/investimenti, con gli anni coperti
      const r = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${pad10(info.cik)}.json`, { headers: HDR });
      if (!r.ok) return send(r.status, { error: `SEC companyfacts ha risposto con status ${r.status}` });
      const all = (await r.json()).facts || {}; const out = {};
      Object.keys(all).filter(ns => ns !== "dei").forEach(ns => { const f = all[ns];
      Object.keys(f).filter(t => /^(Payments|Purchase|Capital)/i.test(t) && (ns !== "us-gaap" || /Property|Productive|Capital|Equipment/i.test(t))).forEach(t => {
        const ends = new Set(); ((f[t].units && f[t].units.USD) || []).forEach(e => { if (FORMS.has(e.form) && e.start && (!e.fp || e.fp === "FY")) { const d = (Date.parse(e.end) - Date.parse(e.start)) / 864e5; if (d >= 340 && d <= 380) ends.add(e.end.slice(0, 4)); } });
        if (ends.size) out[(ns === "us-gaap" ? "" : ns + ":") + t] = Array.from(ends).sort().join(",");
      }); });
      return send(200, out);
    }
    if (type === "filings") return send(200, { us: true, ...(await filings(info.cik, info)) }, "public, max-age=1800");
    return send(400, { error: "type non valido" });
  } catch (err) {
    return send(500, { error: err.message });
  }
};
exports._test = { buildRows, parseForm4 };
