import { createServer } from "node:http";

// ─── پیکربندی ─────────────────────────────────────────────
const TARGET_BASE = ("https://cloud.safari.qzz.io:4096").replace(/\/$/, "");
const PORT = process.env.PORT || 3000;

// هدرهایی که نباید فوروارد شوند
const STRIP_HEADERS = new Set([
  "host", "connection", "keep-alive",
  "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
  "forwarded", "x-forwarded-host",
  "x-forwarded-proto", "x-forwarded-port",
]);

// ─── منطق اصلی relay (دقیقاً همان کد اصلی تو) ────────────
async function handleRelay(request) {
  if (!TARGET_BASE) {
    return new Response("Misconfigured: TARGET_DOMAIN is not set", { status: 500 });
  }

  try {
    const url = new URL(request.url);
    const targetUrl = TARGET_BASE + url.pathname + url.search;

    const headers = new Headers();
    let clientIp = null;

    for (const [key, value] of request.headers) {
      const k = key.toLowerCase();
      if (STRIP_HEADERS.has(k)) continue;
      if (k.startsWith("x-nf-")) continue;
      if (k.startsWith("x-netlify-")) continue;
      if (k === "x-real-ip") { clientIp = value; continue; }
      if (k === "x-forwarded-for") { if (!clientIp) clientIp = value; continue; }
      headers.set(k, value);
    }

    if (clientIp) headers.set("x-forwarded-for", clientIp);

    const method = request.method;
    const hasBody = method !== "GET" && method !== "HEAD";

    const fetchOptions = { method, headers, redirect: "manual" };
    if (hasBody) fetchOptions.body = request.body;

    const upstream = await fetch(targetUrl, fetchOptions);

    const responseHeaders = new Headers();
    for (const [key, value] of upstream.headers) {
      if (key.toLowerCase() === "transfer-encoding") continue;
      responseHeaders.set(key, value);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    return new Response("Bad Gateway: Relay Failed", { status: 502 });
  }
}

// ─── لایه‌ی Node.js HTTP Server ───────────────────────────
// این لایه پل بین Node.js و Web Standard API است.
// Request ورودی را تبدیل می‌کند، relay را اجرا می‌کند،
// و Response را دوباره به فرمت Node.js برمی‌گرداند.

const server = createServer(async (req, res) => {
  try {
    const host = req.headers["host"] || "localhost";
    const fullUrl = `http://${host}${req.url}`;

    // تبدیل body درخواست Node.js به ReadableStream
    const bodyStream = new ReadableStream({
      start(controller) {
        req.on("data", (chunk) => controller.enqueue(chunk));
        req.on("end", () => controller.close());
        req.on("error", (err) => controller.error(err));
      },
    });

    const webRequest = new Request(fullUrl, {
      method: req.method,
      headers: req.headers,
      body: req.method !== "GET" && req.method !== "HEAD" ? bodyStream : undefined,
      duplex: "half",
    });

    const webResponse = await handleRelay(webRequest);

    // ارسال پاسخ به کلاینت
    res.statusCode = webResponse.status;
    for (const [key, value] of webResponse.headers) {
      res.setHeader(key, value);
    }

    if (webResponse.body) {
      const reader = webResponse.body.getReader();
      const pump = async () => {
        const { done, value } = await reader.read();
        if (done) { res.end(); return; }
        res.write(value);
        await pump();
      };
      await pump();
    } else {
      res.end();
    }
  } catch (err) {
    res.statusCode = 500;
    res.end("Internal Server Error");
  }
});

server.listen(PORT, () => {
  console.log(`Relay server running on port ${PORT}`);
  console.log(`Forwarding to: ${TARGET_BASE}`);
});
