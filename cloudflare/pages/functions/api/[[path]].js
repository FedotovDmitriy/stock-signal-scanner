const WORKERS = {
  dev: "https://stock-signal-scanner-dev.fnemoy.workers.dev",
  prod: "https://stock-signal-scanner-production.fnemoy.workers.dev",
};

export async function onRequest(context) {
  const { request, params } = context;
  if (request.method === "OPTIONS") return corsResponse(null, 204);

  const sourceUrl = new URL(request.url);
  const envName = String(request.headers.get("X-Monitor-Env") || sourceUrl.searchParams.get("env") || "dev").toLowerCase();
  const workerBase = WORKERS[envName] || WORKERS.dev;
  const path = Array.isArray(params.path) ? params.path.join("/") : String(params.path || "");
  const targetUrl = new URL(`/api/${path}`, workerBase);
  for (const [key, value] of sourceUrl.searchParams.entries()) {
    if (key !== "env") targetUrl.searchParams.append(key, value);
  }

  const headers = new Headers();
  for (const name of ["Content-Type", "Authorization", "X-Scanner-Token", "X-Admin-Token"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const init = { method: request.method, headers };
  if (!["GET", "HEAD"].includes(request.method)) init.body = await request.arrayBuffer();

  try {
    const response = await fetch(targetUrl, init);
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Cache-Control", "no-store");
    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (error) {
    return corsResponse(JSON.stringify({
      ok: false,
      error: `Pages proxy could not reach ${workerBase}: ${error.message || String(error)}`,
    }), 502, { "Content-Type": "application/json; charset=utf-8" });
  }
}

function corsResponse(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      ...headers,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Scanner-Token, X-Admin-Token, X-Monitor-Env",
      "Access-Control-Max-Age": "86400",
    },
  });
}
