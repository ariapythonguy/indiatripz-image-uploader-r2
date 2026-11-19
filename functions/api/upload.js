function getVerifiedSecret(request, env) {
  const expected = (env.UPLOAD_SECRET || "").trim();
  const authHeader = (request.headers.get("Authorization") || "").trim();
  const received = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (expected && received !== expected) {
    return null;
  }
  return received || expected;
}

// GET /api/upload -> returns sheet list, or package rows when ?sheetKey=... is passed
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

    const incomingUrl = new URL(request.url);
    const sheetKey = incomingUrl.searchParams.get("sheetKey");

    const scriptUrl = new URL(webhookUrl);
    scriptUrl.searchParams.set("secret", secret);
    if (sheetKey) {
      scriptUrl.searchParams.set("sheetKey", sheetKey);
    }

    const res = await fetch(scriptUrl.toString(), { redirect: "follow" });
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

// POST /api/upload -> uploads 4 images to R2 and writes [URL1..URL4] to J:M on the selected row
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
    const files = formData.getAll("files").filter((f) => f && typeof f !== "string");
    const sheetKey = (formData.get("sheetKey") || "").trim();
    const row = Number(formData.get("row"));
    const pkgId = (formData.get("pkgId") || "").trim();

    if (files.length !== 4) {
      return new Response(JSON.stringify({ error: `Please select exactly 4 images (received ${files.length})` }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!sheetKey || !row || row < 2) {
      return new Response(JSON.stringify({ error: "Please select a target sheet and package row" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const baseUrl = (env.PUBLIC_R2_URL || "").trim().replace(/\/$/, "");
    const batchStamp = Date.now();

    // 1. Upload all 4 images to R2 in parallel (preserving order 1..4)
    const publicUrls = await Promise.all(
      files.map(async (file, index) => {
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const key = `${batchStamp}-${index + 1}-${safeName}`;

        await env.MY_BUCKET.put(key, await file.arrayBuffer(), {
          httpMetadata: { contentType: file.type || "application/octet-stream" },
        });

        return `${baseUrl}/${key}`;
      })
    );

    // 2. Write [URL 1, URL 2, URL 3, URL 4] to Columns J, K, L, M of the selected row
    const sheetRes = await fetch(env.SHEETS_WEBHOOK_URL.trim(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      redirect: "follow",
      body: JSON.stringify({
        sheetKey,
        row,
        pkgId,
        urls: publicUrls,
        secret,
      }),
    });

    const sheetText = await sheetRes.text();
    let sheetResult;
    try {
      sheetResult = JSON.parse(sheetText);
    } catch {
      throw new Error(`Uploaded to R2, but Apps Script returned non-JSON (HTTP ${sheetRes.status})`);
    }

    if (sheetResult.error) {
      throw new Error(`Uploaded to R2, but Sheet update failed: ${sheetResult.error}`);
    }

    return new Response(
      JSON.stringify({
        urls: publicUrls,
        sheet: sheetKey,
        row,
        pkgId,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
