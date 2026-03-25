const rawApiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();

const normalizedApiBaseUrl = rawApiBaseUrl
  ? rawApiBaseUrl.replace(/\/+$/, "")
  : "http://localhost:3001";

export function apiUrl(path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedApiBaseUrl}${normalizedPath}`;
}

