// gemini_coach.js
import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.join(process.cwd(), "backend", ".env") });
import { GoogleGenerativeAI } from "@google/generative-ai";

const apiKey = process.env.GEMINI_API_KEY;
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;
const openRouterKey = process.env.OPEN_ROUTER_KEY;
const openRouterModel = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseJsonFromText(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function summarizePayload(payload) {
  return {
    investor: payload?.investor || null,
    alignment: {
      score: payload?.alignment?.score ?? null,
      gaps: (payload?.alignment?.gaps || []).slice(0, 4).map((gap) => ({
        dimension: gap?.dimension || gap?.k || "unknown",
        description:
          gap?.description ||
          `User ${gap?.k || "metric"} is ${Number(gap?.diff || 0).toFixed(2)} away from target.`,
        user: gap?.user ?? null,
        target: gap?.target ?? null,
      })),
    },
    portfolioMetrics: payload?.user?.portfolioMetrics || null,
    biasRatios: payload?.user?.biases?.bias_type_ratios || null,
    overtrading: payload?.user?.biases?.behavioral?.overtrading || null,
    lossAversion: payload?.user?.biases?.behavioral?.loss_aversion || null,
    revengeTrading: payload?.user?.biases?.behavioral?.revenge_trading || null,
    userVector: payload?.user?.userVector || null,
    investorVector: payload?.target?.investorVector || null,
  };
}

function normalizeGap(gap) {
  return {
    dimension: gap?.dimension || gap?.k || "unknown",
    description:
      gap?.description ||
      "This area is materially different from the target investor profile.",
    user: gap?.user ?? null,
    target: gap?.target ?? null,
    diff: gap?.diff ?? null,
  };
}

function isOverloadError(err) {
  const msg = String(err?.message || err);
  return msg.includes("503") || msg.toLowerCase().includes("overloaded");
}

function isQuotaError(err) {
  const msg = String(err?.message || err);
  return msg.includes("429") || msg.toLowerCase().includes("quota");
}

async function callOpenRouter(prompt) {
  if (!openRouterKey) return null;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openRouterKey}`,
      "HTTP-Referer": "http://localhost",
      "X-Title": "qhacksproject-coaching",
    },
    body: JSON.stringify({
      model: openRouterModel,
      max_tokens: 1024,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You are a behavioral finance + trading performance coach. Return only JSON.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || "";
  return parseJsonFromText(content);
}

export async function coachLikeInvestor(payload) {
  const promptPayload = summarizePayload(payload);

  // Mock mode for demo reliability
  if (!apiKey && !openRouterKey) {
    const target = payload?.investor?.displayName || payload?.investor?.investorId || "chosen investor";
    return {
      investor: target,
      alignmentScore: payload?.alignment?.score ?? null,
      summary: "Mock coaching output (no LLM API key set).",
      keyGaps: (payload?.alignment?.gaps || []).slice(0, 6).map(normalizeGap),
      actionPlan: [
        {
          objective: "Reduce overtrading to match target trade frequency",
          steps: ["Set 2 trade windows/day", "Max 3 trades/window", "Log every impulse trade"],
          metric: "trades_per_day",
          targetThreshold: "<= 6",
        },
        {
          objective: "Increase consistency (more like target)",
          steps: ["Define 2 setups only", "No deviation without written reason", "Weekly rule review"],
          metric: "setup_adherence_rate",
          targetThreshold: ">= 80%",
        },
      ],
      guardrails: ["No trades for 30 minutes after a loss", "Hard cap trades/day until score improves"],
      next7Days: [{ day: 1, tasks: ["Create rule sheet", "Set trade windows", "Set max trades/day"] }],
    };
  }

  const prompt = [
    "You are a behavioral finance + trading performance coach.",
    "Given a user's behavior + a target investor profile, output a precise plan to move the user toward the target.",
    "",
    "Return ONLY valid JSON with EXACT keys:",
    '{ "investor": string, "alignmentScore": number, "summary": string, "keyGaps": array, "actionPlan": array, "guardrails": array, "next7Days": array }',
    "",
    "Each keyGaps item must include: dimension (string), description (string).",
    "Each actionPlan item must include: objective, steps, metric, targetThreshold.",
    "",
    "Data payload:",
    JSON.stringify(promptPayload),
  ].join("\n");

  // Put your preferred models first. Avoid relying on preview only.
  const modelFallbacks = [
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-flash",
    "gemini-1.5-pro",
    "gemini-3-flash-preview",
  ];

  let lastErr = null;

  if (genAI) {
    for (const modelName of modelFallbacks) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const model = genAI.getGenerativeModel({
            model: modelName,
            generationConfig: {
              responseMimeType: "application/json",
            },
          });
          const response = await model.generateContent(prompt);
          const text = response?.response?.text?.() ?? "";

          const parsed = parseJsonFromText(text);
          if (parsed && parsed.investor && typeof parsed.summary === "string") return parsed;

          // If model responded but not JSON, treat as failure and try next attempt/model
          lastErr = new Error(`Unparseable JSON from model ${modelName}`);
        } catch (err) {
          lastErr = err;

          // If overload or quota, try OpenRouter fallback
          if (isOverloadError(err) || isQuotaError(err)) {
            console.log("Gemini quota/overload for coaching, trying OpenRouter fallback...");
            break;
          }
          
          // If overload, retry with backoff; otherwise break and move to next model
          if (isOverloadError(err)) {
            await sleep(350 * attempt);
            continue;
          }
          break;
        }
      }
      
      // If quota error, break out of model loop and try OpenRouter
      if (isQuotaError(lastErr)) {
        break;
      }
    }
  }

  // Try OpenRouter if Gemini failed with quota/overload or isn't configured
  if (openRouterKey) {
    console.log("Attempting OpenRouter fallback for coaching with model:", openRouterModel);
    try {
      const orResult = await callOpenRouter(prompt);
      if (orResult && orResult.investor && typeof orResult.summary === "string") {
        console.log("OpenRouter coaching success");
        return orResult;
      }
      console.log("OpenRouter returned invalid format for coaching");
    } catch (err) {
      console.error("OpenRouter coaching error:", err.message);
      lastErr = err;
    }
  }

  return {
    investor: payload?.investor?.displayName || payload?.investor?.investorId || "unknown",
    alignmentScore: payload?.alignment?.score ?? null,
    summary: "Local coaching plan generated because live AI coaching was unavailable.",
    keyGaps: (payload?.alignment?.gaps || []).map(normalizeGap),
    actionPlan: [
      {
        objective: "Cut risk after losses",
        steps: ["After any loss, reduce next size by 50%", "Take 20-minute cooldown", "Stop after 3 consecutive losses"],
        metric: "post_loss_risk",
        targetThreshold: "size <= 0.5x baseline",
      },
      {
        objective: "Reduce trade burstiness",
        steps: ["Cap to 3 trades/hour", "Pre-plan two trade windows", "Log every impulse trade"],
        metric: "trades_per_hour",
        targetThreshold: "<= 3",
      },
    ],
    guardrails: ["Verify OPENROUTER_API_KEY / GEMINI_API_KEY", "Retry when quota resets"],
    next7Days: [{ day: 1, tasks: ["Set risk caps", "Define trade windows", "Write post-loss rule card"] }],
    error: String(lastErr?.message || lastErr),
  };
}
