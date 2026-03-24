const { GoogleGenerativeAI } = require("@google/generative-ai");
const dotenv = require("dotenv");
const path = require("path");
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const apiKey = process.env.GEMINI_API_KEY;
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;
const openRouterKey = process.env.OPENROUTER_API_KEY || process.env.OPEN_ROUTER_KEY;
const openRouterModel = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";

function heuristicAnalysis(metrics) {
  const beh = metrics?.behavioral || {};
  const over = beh.overtrading || {};
  const loss = beh.loss_aversion || {};
  const rev = beh.revenge_trading || {};
  const biases = metrics?.bias_type_ratios || {};

  const lines = [];
  const suggestions = [];

  // Dominant bias from ratios if present
  const topBias = Object.entries(biases).sort((a, b) => b[1] - a[1])[0];
  if (topBias) {
    lines.push(`Dominant bias: ${topBias[0]} (${topBias[1].toFixed(1)}%).`);
  }

  if (over.avg_trades_per_hour && over.avg_trades_per_hour > 3) {
    lines.push(`Trade frequency is high at ${over.avg_trades_per_hour.toFixed(1)} trades/hour (peak ${over.max_trades_in_one_hour || "?"}).`);
    suggestions.push("Cap trades to <=3 per hour and set two trade windows per day.");
  }

  if (loss.disposition_ratio && loss.disposition_ratio > 1.2) {
    lines.push(`Disposition ratio ${loss.disposition_ratio.toFixed(2)} shows losses larger than wins.`);
    suggestions.push("Set hard stop at 1x avg loss and take partials when 1x risk is reached.");
  }

  if (rev.tilt_indicator_pct && rev.tilt_indicator_pct > 35) {
    lines.push(`Tilt indicator ${rev.tilt_indicator_pct.toFixed(1)}% signals size escalation after losses.`);
    suggestions.push("After any loss, cut next position size by 50% and enforce a 20-minute cooldown.");
  } else if (rev.martingale_stats && Object.keys(rev.martingale_stats).length > 0) {
    const m6 = rev.martingale_stats["6"];
    const m0 = rev.martingale_stats["0"];
    if (m6 && m0 && m6 > m0 * 1.2) {
      lines.push(`Position size after 6-loss streak is ${(m6 / m0 * 100).toFixed(0)}% of baseline.`);
      suggestions.push("Stop trading for the session after 3 consecutive losses to avoid martingale escalation.");
    }
  }

  if (!lines.length) {
    lines.push("No severe red flags detected from provided metrics.");
    suggestions.push("Keep logging trades and monitor trade frequency and loss ratios weekly.");
  }

  return {
    summary: lines.join(" "),
    suggestions,
  };
}

function parseJsonFromText(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
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
      "X-Title": "qhacksproject",
    },
    body: JSON.stringify({
      model: openRouterModel,
      max_tokens: 1024,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You are a trading behavior analyst. Return only JSON.",
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
  return parseJsonFromText(content) || { summary: content, suggestions: [] };
}

async function analyzeBias(metrics) {
  if (!metrics || typeof metrics !== "object") {
    return {
      summary: "Invalid metrics input.",
      suggestions: [],
    };
  }

  if (!apiKey && !openRouterKey) {
    return {
      summary: "Mock analysis output (no LLM API key set).",
      suggestions: ["Set GEMINI_API_KEY or OPENROUTER_API_KEY for live analysis."],
    };
  }

  const prompt = [
    "You are an expert behavioral finance analyst specializing in trading psychology and bias detection.",
    "",
    "TASK: Provide a comprehensive analysis of trading behavior patterns based on quantitative metrics and ML-derived bias classifications.",
    "",
    "INPUT DATA STRUCTURE:",
    "- bias_type_ratios: Machine learning classification showing % likelihood of each bias archetype:",
    "  * overtrader: Excessive trade frequency, inability to sit on hands",
    "  * loss_aversion: Holds losers too long, cuts winners too early (disposition effect)",
    "  * revenge_trader: Increases position size and risk after losses to 'get back' losses",
    "  * calm_trader: Disciplined, emotionally stable trading pattern",
    "",
    "- behavioral.overtrading:",
    "  * avg_trades_per_hour: Average frequency (healthy range: 0.5-2.0)",
    "  * max_trades_in_one_hour: Peak clustering (red flag if > 8)",
    "",
    "- behavioral.loss_aversion:",
    "  * avg_abs_loss: Average size of losing trades",
    "  * avg_win: Average size of winning trades",
    "  * disposition_ratio: avg_loss / avg_win (red flag if > 1.5, indicates holding losers too long)",
    "",
    "- behavioral.revenge_trading:",
    "  * martingale_stats: Position size indexed by consecutive loss streak (e.g., {1: 210, 2: 245} means 17% size increase after 1 loss)",
    "  * tilt_indicator_pct: Risk escalation score after losses (red flag if > 40%)",
    "",
    "ANALYSIS REQUIREMENTS:",
    "1. DOMINANT BIAS: Identify the highest % from bias_type_ratios and explain WHY the metrics support this classification",
    "2. LOSS AVERSION DEEP DIVE: If disposition_ratio > 1.2, explain the psychological trap (fear of realizing losses, hope-based holding)",
    "3. REVENGE TRADING PATTERN: If tilt_indicator > 35% or martingale shows escalation > 15%, describe the emotional cascade and risk of blowup",
    "4. OVERTRADING IMPACT: If avg_trades_per_hour > 3 or max > 8, quantify the opportunity cost (slippage, commissions, decision fatigue)",
    "5. ROOT CAUSE: Connect the numbers to underlying emotions (FOMO, revenge, pride, fear of missing out on recovery)",
    "",
    "CRITICAL RED FLAGS TO CALL OUT:",
    "- disposition_ratio > 1.5 = severe loss aversion",
    "- tilt_indicator > 50% = high revenge trading risk",
    "- max_trades_in_one_hour > 10 = compulsive overtrading",
    "- martingale escalation > 30% = dangerous martingale behavior",
    "",
    "OUTPUT FORMAT (strict JSON only):",
    '{"summary": "3-5 sentences analyzing the dominant bias, explaining key behavioral metrics (cite specific numbers), and describing the psychological pattern and trading outcome risk", "suggestions": ["4-5 concrete, tactical actions with specific thresholds (e.g., \'Cap trades at 3/hour\', \'Set hard stop at 2x avg loss\', \'30-min cooldown after any loss\')"] }',
    "",
    "METRICS DATA:",
    `${JSON.stringify(metrics, null, 2)}`,
  ].join("\n");

  try {
    const modelFallbacks = [
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
      "gemini-1.5-flash",
      "gemini-1.5-pro",
      "gemini-3-flash-preview",
    ];

    let lastErr = null;
    let lastText = "";

    if (genAI) {
      for (const modelName of modelFallbacks) {
        try {
          const model = genAI.getGenerativeModel({
            model: modelName,
            generationConfig: {
              responseMimeType: "application/json",
            },
          });
          const response = await model.generateContent(prompt);
          const text = response?.response?.text?.() ?? "";
          lastText = text;
          const parsed = parseJsonFromText(text);

          if (parsed && typeof parsed.summary === "string" && Array.isArray(parsed.suggestions)) {
            return parsed;
          }

          lastErr = new Error(`Unparseable JSON from model ${modelName}`);
        } catch (err) {
          lastErr = err;
          if (isQuotaError(err)) {
            console.log("Gemini quota exceeded, trying OpenRouter fallback...");
            break;
          }
        }
      }
    }

    // Try OpenRouter if Gemini failed with quota error or isn't configured
    if (openRouterKey) {
      console.log("Attempting OpenRouter fallback with model:", openRouterModel);
      try {
        const orResult = await callOpenRouter(prompt);
        if (orResult && typeof orResult.summary === "string") {
          console.log("OpenRouter success");
          return orResult;
        }
        console.log("OpenRouter returned invalid format");
      } catch (err) {
        console.error("OpenRouter error:", err.message);
        lastErr = err;
      }
    }

    // If we got any text from Gemini before quota error, use it
    if (lastText) {
      return {
        summary: lastText.slice(0, 600),
        suggestions: [],
        error: String(lastErr?.message || lastErr),
      };
    }

    
    const heuristic = heuristicAnalysis(metrics);
    heuristic.error = String(lastErr?.message || lastErr || "LLM unavailable");
    return heuristic;
  } catch (err) {
    console.error("Error calling Gemini:", err);
    return {
      summary: "Error calling Gemini.",
      suggestions: ["Check GEMINI_API_KEY / OPENROUTER_API_KEY and network connection."],
      error: String(err?.message || err),
    };
  }
}

module.exports = { analyzeBias };
