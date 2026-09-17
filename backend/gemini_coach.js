// Optional interpretation is constrained to selecting existing, verified educational
// actions. No model-authored prose or numbers enter the response.
export function validateSelection(candidate, actions) {
  if (
    !Array.isArray(candidate?.action_ids) ||
    candidate.action_ids.length < 1 ||
    candidate.action_ids.length > actions.length
  )
    return null;
  if (
    !candidate.action_ids.every(
      (id) => Number.isInteger(id) && id >= 0 && id < actions.length,
    )
  )
    return null;
  if (new Set(candidate.action_ids).size !== candidate.action_ids.length)
    return null;
  return candidate.action_ids.map((id) => actions[id]);
}

export async function curateCoaching(
  analysis,
  env = process.env,
  request = fetch,
) {
  const fallback = { ...analysis.coaching, source: "deterministic" };
  // Gemini only selects verified coaching text; it cannot turn an abstention into a classification.
  if (!analysis.coaching.actions.length) return fallback;
  const payload = {
    scope: analysis.scope,
    prediction: analysis.prediction,
    evidence: analysis.evidence,
    explanations: analysis.explanations,
    counterfactuals: analysis.counterfactuals,
    actions: analysis.coaching.actions.map((text, id) => ({ id, text })),
  };
  try {
    const response = await request(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.GEMINI_MODEL)}:generateContent`,
      {
        method: "POST",
        signal: AbortSignal.timeout(12_000),
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: 'You curate educational behavioral reflections from verified analytics. Select the most relevant provided action IDs in priority order. Respect the supplied classification status and abstention reasons; never imply a withheld class was identified. Return only JSON {"action_ids":[integer,...]}. Do not create advice, numbers, predictions, or prose. These are synthetic benchmark patterns, not psychological diagnoses or investment recommendations.',
              },
            ],
          },
          contents: [{ parts: [{ text: JSON.stringify(payload) }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 256,
            responseMimeType: "application/json",
          },
        }),
      },
    );
    if (!response.ok) return fallback;
    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("");
    const actions = validateSelection(
      JSON.parse(text),
      analysis.coaching.actions,
    );
    return actions
      ? { ...fallback, source: "gemini-curated", actions }
      : fallback;
  } catch {
    return fallback;
  }
}
