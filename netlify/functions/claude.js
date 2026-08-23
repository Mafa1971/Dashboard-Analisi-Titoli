// netlify/functions/claude.js
// Proxy verso l'API Anthropic (Claude). La chiave API NON è scritta qui:
// viene letta da una variabile d'ambiente su Netlify (ANTHROPIC_API_KEY),
// così non finisce mai nel codice pubblico su GitHub.
//
// Accetta { prompt, imageBase64 } — imageBase64 è opzionale (screenshot del
// grafico), senza il prefisso "data:image/png;base64," che va tolto lato client.

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ error: "Metodo non consentito" }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "ANTHROPIC_API_KEY non configurata su Netlify (Project configuration → Environment variables)" })
    };
  }

  let prompt, imageBase64;
  try {
    const body = JSON.parse(event.body || "{}");
    prompt = body.prompt;
    imageBase64 = body.imageBase64 || null;
  } catch (e) {
    return { statusCode: 400, headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ error: "Body non valido" }) };
  }
  if (!prompt) {
    return { statusCode: 400, headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ error: "Parametro 'prompt' mancante" }) };
  }

  const content = [];
  if (imageBase64) {
    content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: imageBase64 } });
  }
  content.push({ type: "text", text: prompt });

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-5", // controlla su docs.claude.com/en/docs/about-claude/models se è uscito un modello più recente
        max_tokens: 900, // ridotto per stare più comodi entro i 10s di timeout delle Netlify Functions gratuite
        messages: [{ role: "user", content }]
      })
    });

    const data = await res.json();

    if (data.error) {
      return {
        statusCode: 200,
        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
        body: JSON.stringify({ error: data.error.message || "Errore Anthropic API" })
      };
    }

    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");

    return {
      statusCode: 200,
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    };
  } catch (err) {
    return { statusCode: 500, headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ error: err.message }) };
  }
};
