// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

// For now allow all origins while testing.
// Later we can restrict this to your TYPO3 domain.
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const PROVIDER = process.env.PROVIDER || "openrouter";

// ----- Function that calls the LLM (OpenRouter for now, OpenAI later) -----

async function callLLM(messages) {
  if (PROVIDER === "openai") {
    // This branch is for later when you have an OpenAI key
    const apiKey = process.env.OPENAI_API_KEY;
    const model = "gpt-4.1-mini"; // example target model

    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.3,
        }),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      console.error("OpenAI error:", response.status, text);
      throw new Error("OpenAI API error");
    }

    const data = await response.json();
    return data.choices[0].message.content;
  } else {
    // Default: OpenRouter (current testing provider)
    const apiKey = process.env.OPENROUTER_API_KEY;
    const model = "openai/gpt-4.1-mini"; // use a model name available in your OpenRouter account

    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.3,
        }),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      console.error("OpenRouter error:", response.status, text);
      throw new Error("OpenRouter API error");
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }
}

// ----- Routes -----

// Health check – very useful later on Render
app.get("/health", (_req, res) => {
  res.send("ok");
});

// Main chat endpoint
app.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body;

    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: "messages must be an array" });
    }

    // System prompt for TIM Univie assistant
    const systemMessage = {
      role: "system",
      content:
        "You are the TIM Univie course assistant. " +
        "Answer organizational questions in 1–3 sentences, friendly and concise. " +
        "Use German or English depending on the user.",
    };

    const reply = await callLLM([systemMessage, ...messages]);
    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`TIM chat backend listening on port ${PORT}`);
});
