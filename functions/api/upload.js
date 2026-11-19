function getVerifiedSecret(request, env) {
  const expected = (env.UPLOAD_SECRET || "").trim();
  const authHeader = (request.headers.get("Authorization") || "").trim();
  const received = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (expected && received !== expected) {
    return null;
  }
  return received || expected;
}

// GET /api/upload -> returns the list of 21 sheet labels from Apps Script
export async function onRequestGet(context) {
  const { request, env } = context;

  const secret = getVerifiedSecret(request, env);
  if (secret === null) {
    return new Response(JSON.stringify({ error: "Invalid passcode" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const webhookUrl = (env.SHEETS_WEBHOOK_URL || "").trim();
    if (!webhookUrl) {
      throw new Error("SHEETS_WEBHOOK_URL is not configured in Cloudflare");
    }

    const url = new URL(webhookUrl);
    url.searchParams.set("secret", secret);

    const res = await fetch(url.toString(), { redirect: "follow" });
    const text = await res.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Apps Script returned non-JSON (HTTP ${res.status})`);
    }

    if (data.error) {
      throw new Error(data.error);
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

  const secret = getVerifiedSecret(request, env);
  if (secret === null) {
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
      redirect: "follow",
      body: JSON.stringify({
        filename: file.name,
        url: publicUrl,
        sheetKey,
        secret,
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
