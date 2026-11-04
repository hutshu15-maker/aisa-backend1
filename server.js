import "dotenv/config";
import fs from "node:fs";
import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "./systemPrompt.js";

// ---------- Konfiguration ----------
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Fehler: ANTHROPIC_API_KEY ist nicht gesetzt (siehe .env.example).");
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const MAX_HISTORY = 40; // max. Nachrichten im Verlauf
const MAX_CHARS = 2000; // max. Zeichen pro Nachricht

const KNOWLEDGE_FILE = process.env.KNOWLEDGE_FILE || "./firmenwissen.md";
const firmenWissen = fs.existsSync(KNOWLEDGE_FILE)
  ? fs.readFileSync(KNOWLEDGE_FILE, "utf8").trim()
  : "";
if (!firmenWissen) {
  console.warn(`Hinweis: ${KNOWLEDGE_FILE} fehlt oder ist leer – AISA leitet Sachfragen ans Team weiter.`);
}

const SYSTEM_PROMPT = buildSystemPrompt(firmenWissen, {
  calendly: process.env.CALENDLY_LINK || "[CALENDLY_LINK]",
  newsletter: process.env.NEWSLETTER_LINK || "[NEWSLETTER_LINK]",
  pdf: process.env.PDF_LINK || "[PDF_LINK]",
});

const FALLBACK_REPLY =
  "Entschuldigung, dabei kann ich Ihnen gerade nicht weiterhelfen. Gerne leite ich Ihr Anliegen an mein Team weiter – unter welcher E-Mail-Adresse erreichen wir Sie am besten?";

const client = new Anthropic(); // liest ANTHROPIC_API_KEY aus process.env

// ---------- Validierung ----------
// chatHistory kommt vom Browser und ist daher nicht vertrauenswürdig:
// nur user/assistant mit reinem Text, begrenzte Länge.
function validateRequest(body) {
  const { message, chatHistory = [] } = body ?? {};

  if (typeof message !== "string" || !message.trim()) {
    return { error: "'message' muss ein nicht-leerer String sein." };
  }
  if (message.length > MAX_CHARS) {
    return { error: `'message' darf höchstens ${MAX_CHARS} Zeichen lang sein.` };
  }
  if (!Array.isArray(chatHistory)) {
    return { error: "'chatHistory' muss ein Array sein." };
  }
  if (chatHistory.length > MAX_HISTORY) {
    return { error: `'chatHistory' darf höchstens ${MAX_HISTORY} Nachrichten enthalten.` };
  }

  const history = [];
  for (const [i, m] of chatHistory.entries()) {
    if (!m || !["user", "assistant"].includes(m.role) || typeof m.content !== "string") {
      return { error: `chatHistory[${i}] braucht role 'user' oder 'assistant' und content als String.` };
    }
    if (m.content.length > MAX_CHARS) {
      return { error: `chatHistory[${i}] ist zu lang.` };
    }
    if (m.content.trim()) history.push({ role: m.role, content: m.content });
  }

  // Die API verlangt, dass der Verlauf mit einer user-Nachricht beginnt
  // (z. B. wenn das Widget eine Begrüßung des Assistenten zuerst zeigt).
  while (history.length && history[0].role !== "user") history.shift();

  return { messages: [...history, { role: "user", content: message.trim() }] };
}

// ---------- Server ----------
const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(
  cors({
    // Kommagetrennte Liste erlaubter Domains, z. B. https://www.ihre-firma.de
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",") : false,
  }),
);

// Chat-Frontend (public/index.html) unter http://localhost:PORT/ ausliefern
app.use(express.static("public"));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/api/chat", async (req, res) => {
  const { error, messages } = validateRequest(req.body);
  if (error) return res.status(400).json({ error });

  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: "low" }, // kurze Chat-Antworten, geringe Latenz
      // Bei einer Sicherheits-Ablehnung versucht die API automatisch ein Ersatzmodell.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" }, // fester Prompt wird gecacht
        },
      ],
      messages,
    });

    if (response.stop_reason === "refusal") {
      console.warn("Antwort abgelehnt:", response.stop_details?.category ?? "unbekannt");
      return res.json({ reply: FALLBACK_REPLY });
    }

    const reply = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    if (!reply) {
      console.warn("Leere Antwort, stop_reason:", response.stop_reason);
      return res.json({ reply: FALLBACK_REPLY });
    }

    return res.json({ reply });
  } catch (err) {
    // Spezifische Fehler zuerst prüfen (APIConnectionError erbt von APIError).
    if (err instanceof Anthropic.AuthenticationError) {
      console.error("Ungültiger API-Key.");
      return res.status(500).json({ error: "Serverkonfiguration fehlerhaft." });
    }
    if (err instanceof Anthropic.RateLimitError) {
      console.error("Rate-Limit erreicht.");
      return res.status(429).json({ error: "Zu viele Anfragen – bitte gleich noch einmal versuchen." });
    }
    if (err instanceof Anthropic.BadRequestError) {
      console.error("Ungültige Anfrage an die API:", err.message);
      return res.status(400).json({ error: "Die Anfrage konnte nicht verarbeitet werden." });
    }
    if (err instanceof Anthropic.APIConnectionError) {
      console.error("Keine Verbindung zur Anthropic-API:", err.message);
      return res.status(503).json({ error: "Der Assistent ist gerade nicht erreichbar." });
    }
    if (err instanceof Anthropic.APIError) {
      console.error(`API-Fehler ${err.status}:`, err.message);
      return res.status(502).json({ error: "Der Assistent ist gerade nicht erreichbar." });
    }
    console.error("Unerwarteter Fehler:", err);
    return res.status(500).json({ error: "Interner Serverfehler." });
  }
});

// Ungültiges JSON im Request-Body
app.use((err, _req, res, _next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Ungültiges JSON." });
  }
  console.error(err);
  return res.status(500).json({ error: "Interner Serverfehler." });
});

app.listen(PORT, () => {
  console.log(`AISA-Backend läuft auf http://localhost:${PORT} (Modell: ${MODEL})`);
});
