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
    "NEXT_PUBLIC_API_BASE_URL is not configured for this deployment."
  );
}

export function apiUrl(path: string) {
  const apiBaseUrl = getApiBaseUrl();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${apiBaseUrl}${normalizedPath}`;
}
