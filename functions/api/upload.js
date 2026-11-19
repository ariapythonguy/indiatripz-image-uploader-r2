function isAuthorized(request, env) {
  const expected = (env.UPLOAD_SECRET || "").trim();
  if (!expected) return true;

  const authHeader = (request.headers.get("Authorization") || "").trim();
  const received = authHeader.replace(/^Bearer\s+/i, "");
  return received === expected;
}

// GET /api/upload -> returns the list of 28 sheet labels from Apps Script
export async function onRequestGet(context) {
  const { request, env } = context;

  if (!isAuthorized(request, env)) {
    return new Response(JSON.stringify({ error: "Invalid passcode" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    if (!env.SHEETS_WEBHOOK_URL) {
      throw new Error("SHEETS_WEBHOOK_URL is not configured in Cloudflare");
    }

    const url = new URL(env.SHEETS_WEBHOOK_URL.trim());
    url.searchParams.set("secret", (env.UPLOAD_SECRET || "").trim());

    const res = await fetch(url.toString());
    const text = await res.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Apps Script returned non-JSON (HTTP ${res.status})`);
    }

    return new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// POST /api/upload -> uploads to R2 and logs to the chosen Google Sheet
export async function onRequestPost(context) {
  const { request, env } = context;

  if (!isAuthorized(request, env)) {
    return new Response(JSON.stringify({ error: "Invalid passcode" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const sheetKey = formData.get("sheetKey");

    if (!file || typeof file === "string") {
      return new Response(JSON.stringify({ error: "No image file provided" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!sheetKey) {
      return new Response(JSON.stringify({ error: "Please select a target Google Sheet" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 1. Upload to R2
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const key = `${Date.now()}-${safeName}`;

    await env.MY_BUCKET.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type || "application/octet-stream" },
    });

    const baseUrl = (env.PUBLIC_R2_URL || "").trim().replace(/\/$/, "");
    const publicUrl = `${baseUrl}/${key}`;

    // 2. Log URL to the selected Google Sheet
    const sheetRes = await fetch(env.SHEETS_WEBHOOK_URL.trim(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        url: publicUrl,
        sheetKey,
        secret: (env.UPLOAD_SECRET || "").trim(),
      }),
    });

    const sheetText = await sheetRes.text();
    let sheetResult;
    try {
      sheetResult = JSON.parse(sheetText);
    } catch {
      throw new Error(`Uploaded to R2 (${publicUrl}), but Apps Script returned non-JSON (HTTP ${sheetRes.status})`);
    }

    if (sheetResult.error) {
      throw new Error(`Uploaded to R2, but Sheet failed: ${sheetResult.error}`);
    }

    return new Response(JSON.stringify({ url: publicUrl, filename: file.name, sheet: sheetKey }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
