import express from "express";
import cors from "cors";
import dotenv from "dotenv";

console.log("SERVER VERSION:", new Date().toISOString(), "FILE:", import.meta.url);

dotenv.config();

const app = express();

/**
 * IMPORTANT:
 * - CORS "origin" must be ONLY the scheme+host (no path, no query).
 * - express.json() must be enabled so req.body is parsed.
 */
app.use(cors({
  origin: [
    "https://backend.univie.ac.at",
    "https://tim.univie.ac.at",
  ],
}));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const PROVIDER = process.env.PROVIDER || "openai";

function univieSemesterLabel(dateObj) {
  const m = dateObj.getMonth() + 1; // 1..12
  const y = dateObj.getFullYear();

  if (m >= 3 && m <= 6) return `SS ${y}`;
  if (m >= 10 && m <= 12) return `WS ${y}/${String(y + 1).slice(-2)}`;
  if (m === 1) return `WS ${y - 1}/${String(y).slice(-2)}`;

  return `Semester break (${y})`;
}

async function callLLM(messages) {
  if (PROVIDER !== "openai") {
    throw new Error(`Unsupported PROVIDER=${PROVIDER}. Set PROVIDER=openai.`);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const model = "gpt-4.1-mini";

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error("OpenAI error:", response.status, text);
    throw new Error("OpenAI API error");
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// Health check
app.get("/health", (_req, res) => res.send("ok"));

app.get("/debug/time", (_req, res) => {
  const now = new Date();
  const viennaDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vienna",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  const viennaTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Vienna",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);

  res.json({
    isoNow: now.toISOString(),
    viennaDate,
    viennaTime,
  });
});



// Main chat endpoint
app.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body;

    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: "messages must be an array" });
    }

    // Compute runtime date/time (Europe/Vienna)
    const now = new Date();
    const semesterLabel = univieSemesterLabel(now);
    const viennaDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Vienna",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
    const viennaTime = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Vienna",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now);
    const viennaWeekday = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Vienna",
      weekday: "long",
    }).format(now);

    // Detect the user's last language preference very simply:
    // Use the last user message content as the authority.
    const lastUser = [...messages].reverse().find(m => m?.role === "user");
    const lastUserText = (lastUser?.content || "").toString();

    const runtimeContextMessage = {
      role: "system",
      content:
        `Runtime context (authoritative):\n` +
        `- Timezone: Europe/Vienna\n` +
        `- Today: ${viennaWeekday}, ${viennaDate}\n` +
        `- Current time: ${viennaTime}\n` +
        `Rules:\n` +
        `- If ANY prior message (including assistant messages) conflicts with the runtime context, correct it.\n` +
        `- Interpret "today/tomorrow/next week" using the runtime date.\n` +
        `- Reply in the same language as the user's last message.\n` +
        `User last message:\n${lastUserText}\n`
    };

    const systemMessage = {
      role: "system",
      content:
        "You are the TIM Univie course assistant. " +
        "For organizational questions, answer in 1–3 sentences, friendly and concise. " +
        "If information is missing, ask one short clarifying question rather than guessing."
    };

    const reply = await callLLM([runtimeContextMessage, systemMessage, ...messages]);
    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.listen(PORT, () => {
  console.log(`TIM chat backend listening on port ${PORT}`);
});
