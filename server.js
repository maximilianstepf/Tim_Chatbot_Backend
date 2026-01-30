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

const SYLLABI_INDEX_URL = process.env.SYLLABI_INDEX_URL;
const SYLLABI_CACHE_TTL_MS = Number(process.env.SYLLABI_CACHE_TTL_MS || 15 * 60 * 1000); // 15 min

const syllabusCache = {
  index: { value: null, fetchedAt: 0 },
  byUrl: new Map() // url -> { value, fetchedAt }
};

async function fetchText(url) {
  const resp = await fetch(url, { method: "GET" });
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  return await resp.text();
}

async function getSyllabiIndex() {
  if (!SYLLABI_INDEX_URL) throw new Error("Missing SYLLABI_INDEX_URL env var");
  const now = Date.now();
  if (syllabusCache.index.value && (now - syllabusCache.index.fetchedAt) < SYLLABI_CACHE_TTL_MS) {
    return syllabusCache.index.value;
  }
  const raw = await fetchText(SYLLABI_INDEX_URL);
  const parsed = JSON.parse(raw);
  syllabusCache.index = { value: parsed, fetchedAt: now };
  return parsed;
}

async function getSyllabusText(url) {
  const now = Date.now();
  const cached = syllabusCache.byUrl.get(url);
  if (cached && (now - cached.fetchedAt) < SYLLABI_CACHE_TTL_MS) {
    return cached.value;
  }
  const text = await fetchText(url);
  syllabusCache.byUrl.set(url, { value: text, fetchedAt: now });
  return text;
}

function findCourseFromUserText(indexObj, userText) {
  const t = (userText || "").toLowerCase();
  for (const [courseName, meta] of Object.entries(indexObj)) {
    const aliases = [courseName, ...(meta.aliases || [])]
      .map(s => String(s).toLowerCase())
      .filter(Boolean);

    if (aliases.some(a => t.includes(a))) return courseName;
  }
  return null;
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

app.get("/debug/syllabi-index", async (_req, res) => {
  try {
    const idx = await getSyllabiIndex();
    res.json({ ok: true, courses: Object.keys(idx) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
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

    // Load syllabi index and try to detect course from the user's message
let syllabusContextMessage = null;

try {
  const indexObj = await getSyllabiIndex();
  const detectedCourse = findCourseFromUserText(indexObj, lastUserText);

  // Heuristic: questions that usually require a specific course syllabus
  const needsCourse =
    /prüfung|exam|deadline|anmeldung|registration|note|grading|bewertung|attendance|anwesenheit|raum|room|termin|date|uhrzeit|time/i.test(lastUserText);

  const courseList = Object.keys(indexObj);

  if (!detectedCourse && needsCourse && courseList.length > 1) {
    // Ask ONE clarifying question and stop (no model call needed)
    return res.json({
      reply: `Für welchen TIM-Kurs meinst du das? (${courseList.join(" / ")})`
    });
  }

  if (detectedCourse) {
    const url = indexObj[detectedCourse]?.syllabus_url;
    if (url) {
      const syllabusText = await getSyllabusText(url);
      syllabusContextMessage = {
        role: "system",
        content:
          `Authoritative syllabus (use this first). Course: ${detectedCourse}\n` +
          `Rules:\n` +
          `- For organizational questions, answer ONLY if the answer is in this syllabus text.\n` +
          `- If not in syllabus, say so and ask one clarifying question or suggest checking official Uni Wien pages.\n\n` +
          syllabusText
      };
    }
  }
} catch (e) {
  console.error("Syllabus loading failed:", e);
  // If syllabus fetch fails, continue without syllabus rather than breaking the bot.
}


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
    "You are the official student assistant for the Chair of Technology and Innovation Management (TIM).\n\n" +

    "Institutional context:\n" +
    "- Chair: Technology and Innovation Management (TIM)\n" +
    "- Institute: Institut für Rechnungswesen, Innovation und Strategie\n" +
    "- Faculty: Faculty of Business, Economics and Statistics\n" +
    "- University: University of Vienna\n" +
    "- TIM offers multiple courses as part of one specialization within Business Administration, International Business, and related curricula.\n\n" +

    "Scope and authority:\n" +
    "- You support students taking ANY TIM course.\n" +
    "- You answer organizational and content-related questions reliably and confidently.\n" +
    "- Organizational information must be grounded in the official syllabus first.\n" +
    "- If information is not in the syllabus, it may be confirmed via official University of Vienna websites.\n" +
    "- Never invent dates, rules, or requirements.\n\n" +

    "Course disambiguation rule:\n" +
    "- If a question depends on a specific TIM course and the course is not clearly specified, ask ONE short clarifying question naming the relevant course options.\n" +
    "- Do not guess which course the student means.\n\n" +

    "Answer policy:\n" +
    "- If a question can be answered with available information, answer it immediately.\n" +
    "- Do NOT ask follow-up questions unless essential information is missing.\n" +
    "- For organizational questions, respond in 1–2 short sentences.\n" +
    "- For content-related questions, respond concisely but completely.\n" +
    "- Avoid greetings, small talk, or closing questions.\n" +
    "- Avoid hedging language (e.g., 'voraussichtlich', 'meistens') unless uncertainty is real and unavoidable.\n\n" +

    "Language and clarity:\n" +
    "- Always reply in the language of the user's last message.\n" +
    "- Use clear, student-friendly wording.\n" +
    "- State facts directly and precisely.\n\n" +

    "Fallback behavior:\n" +
    "- If information is not available or cannot be verified, say so explicitly and indicate where the student should check next (e.g., syllabus, official website, course coordinator).\n" +
    "- Do not speculate.\n\n" +

    "Stop after the answer."
};


    const outbound = syllabusContextMessage
  ? [runtimeContextMessage, systemMessage, syllabusContextMessage, ...messages]
  : [runtimeContextMessage, systemMessage, ...messages];

const reply = await callLLM(outbound);

    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.listen(PORT, () => {
  console.log(`TIM chat backend listening on port ${PORT}`);
});
