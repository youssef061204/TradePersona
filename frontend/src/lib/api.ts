import type { Analysis, Evaluation, Quality } from "./types";

function getApiBaseUrl() {
  const rawApiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
  if (rawApiBaseUrl) {
    return rawApiBaseUrl.replace(/\/+$/, "");
  }

  if (
    typeof window !== "undefined" &&
    ["localhost", "127.0.0.1"].includes(window.location.hostname)
  ) {
    return "http://localhost:3001";
  }

  throw new Error(
    "NEXT_PUBLIC_API_BASE_URL is not configured for this deployment.",
  );
}

export function apiUrl(path: string) {
  const apiBaseUrl = getApiBaseUrl();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${apiBaseUrl}${normalizedPath}`;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public quality?: Quality,
  ) {
    super(message);
  }
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), { ...init, cache: "no-store" });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      typeof body?.error === "string" ? body.error : body?.error?.message;
    throw new ApiError(
      detail || body?.message || `Request failed (${response.status}).`,
      response.status,
      body?.quality ?? body?.error?.quality,
    );
  }
  if (!body)
    throw new ApiError(
      "The server returned an empty response.",
      response.status,
    );
  return body as T;
}
export const getAnalysis = (id: string, signal?: AbortSignal) =>
  request<{ sessionId: string; analysis: Analysis }>(
    `/api/analysis/${encodeURIComponent(id)}`,
    { signal },
  );
export const getEvaluation = (signal?: AbortSignal) =>
  request<Evaluation>("/api/evaluation", { signal });
export const uploadTrades = (file: File, signal?: AbortSignal) => {
  const body = new FormData();
  body.append("file", file);
  return request<{ sessionId: string; analysis: Analysis }>(
    "/api/uploads/usertrades",
    { method: "POST", body, signal },
  );
};
export const SESSION_KEY = "tradepersona.session.v1";
