/*
 * File: upload.ts
 * Project: qwenproxy
 * Image upload handler - forwards images to Qwen's OSS storage
 */

import { Context } from "hono";
import { getBasicHeaders } from "../services/playwright.ts";
import { v4 as uuidv4 } from "uuid";

interface STSResponse {
  success: boolean;
  request_id: string;
  data: {
    access_key_id: string;
    access_key_secret: string;
    security_token: string;
    file_url: string;
    file_path: string;
    file_id: string;
    bucketname: string;
    region: string;
    endpoint: string;
  };
}

/**
 * Get STS token from Qwen for file upload
 */
async function getSTSToken(
  filename: string,
  filesize: number,
  filetype: string,
  headers: Record<string, string>,
): Promise<STSResponse["data"]> {
  const response = await fetch(
    "https://chat.qwen.ai/api/v2/files/getstsToken",
    {
      method: "POST",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        Cookie: headers.cookie,
        Origin: "https://chat.qwen.ai",
        Referer: "https://chat.qwen.ai/",
        "User-Agent": headers["user-agent"],
        "X-Request-Id": uuidv4(),
        "bx-ua": headers["bx-ua"],
        "bx-umidtoken": headers["bx-umidtoken"],
        "bx-v": headers["bx-v"],
      },
      body: JSON.stringify({ filename, filesize: String(filesize), filetype }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `STS token request failed: ${response.status} ${errorText.substring(0, 200)}`,
    );
  }

  const data = await response.json();
  if (!data.success || !data.data) {
    throw new Error(
      `STS token invalid: ${JSON.stringify(data).substring(0, 200)}`,
    );
  }

  return data.data;
}

/**
 * Upload file to Alibaba Cloud OSS using STS credentials
 */
async function uploadToOSS(
  fileBuffer: ArrayBuffer,
  stsData: STSResponse["data"],
  filename: string,
): Promise<string> {
  const {
    access_key_id,
    access_key_secret,
    security_token,
    file_url,
    file_path,
    bucketname,
    region,
    endpoint,
  } = stsData;

  const OSS = (await import("ali-oss")).default;
  const client = new OSS({
    region,
    accessKeyId: access_key_id,
    accessKeySecret: access_key_secret,
    stsToken: security_token,
    bucket: bucketname,
    endpoint: `https://${endpoint}`,
    secure: true,
    refreshSTSToken: async () => ({
      accessKeyId: access_key_id,
      accessKeySecret: access_key_secret,
      stsToken: security_token,
    }),
    refreshSTSTokenInterval: 300000,
  });

  const buffer = Buffer.from(fileBuffer);
  const contentType = filename.endsWith(".png") ? "image/png" : "image/jpeg";

  await client.put(file_path, buffer, {
    headers: { "Content-Type": contentType },
  });

  return file_url.split("?")[0];
}

/**
 * Handle image upload endpoint
 * POST /v1/upload
 */
export async function uploadImage(c: Context) {
  try {
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return c.json({ error: "No file provided" }, 400);
    }

    const validTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (!validTypes.includes(file.type)) {
      return c.json({ error: `Invalid file type: ${file.type}` }, 400);
    }

    if (file.size > 20 * 1024 * 1024) {
      return c.json({ error: "File too large. Max size: 20MB" }, 400);
    }

    // Wait for Playwright headers (max 60s)
    let headers: Record<string, string> | null = null;
    for (let i = 0; i < 60; i++) {
      try {
        const { cookie, userAgent, bxV, bxUa, bxUmidtoken } =
          await getBasicHeaders();
        if (cookie && cookie.length > 50 && bxUa) {
          headers = {
            cookie,
            "user-agent": userAgent,
            "bx-ua": bxUa,
            "bx-umidtoken": bxUmidtoken,
            "bx-v": bxV,
          };
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!headers) {
      return c.json(
        { error: "Authentication not ready. Send a chat message first." },
        503,
      );
    }

    const stsData = await getSTSToken(file.name, file.size, "image", headers);
    const fileBuffer = await file.arrayBuffer();
    const fileUrl = await uploadToOSS(fileBuffer, stsData, file.name);

    return c.json({
      url: fileUrl,
      file_id: stsData.file_id,
      filename: file.name,
    });
  } catch (error: any) {
    console.error("[Upload] Error:", error.message);
    return c.json({ error: error.message }, 500);
  }
}

/**
 * Qwen file format for images
 */
export interface QwenFileEntry {
  type: string;
  file: {
    created_at: number;
    data: Record<string, unknown>;
    filename: string;
    hash: string | null;
    id: string;
    user_id: string;
    meta: { name: string; size: number; content_type: string };
    update_at: number;
    lastModified: number;
    name: string;
    webkitRelativePath: string;
    size: number;
    type: string;
  };
  id: string;
  url: string;
  name: string;
  collection_name: string;
  progress: number;
  status: string;
  greenNet: string;
  size: number;
  error: string;
  itemId: string;
  file_type: string;
  showType: string;
  file_class: string;
  uploadTaskId: string;
}

/**
 * Process OpenAI-style image content into Qwen file format
 */
export async function processImagesForQwen(
  content: Array<{ type: string; text?: string; image_url?: { url: string } }>,
  headers: Record<string, string>,
): Promise<{ text: string; files: QwenFileEntry[] }> {
  const textParts: string[] = [];
  const files: QwenFileEntry[] = [];

  for (const part of content) {
    if (part.type === "text" && part.text) {
      textParts.push(part.text);
    } else if (part.type === "image_url" && part.image_url?.url) {
      const imageUrl = part.image_url.url;
      let fileUrl = "";
      let filename = "";
      let fileSize = 0;
      let fileId = "";

      if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
        fileUrl = imageUrl;
        filename = imageUrl.split("/").pop()?.split("?")[0] || "image.jpg";
        fileId = uuidv4();
      } else if (imageUrl.startsWith("data:image/")) {
        try {
          const base64Data = imageUrl.split(",")[1];
          const buffer = Buffer.from(base64Data, "base64");
          filename = `image_${Date.now()}.png`;
          fileSize = buffer.length;
          const stsData = await getSTSToken(
            filename,
            fileSize,
            "image",
            headers,
          );
          fileUrl = await uploadToOSS(buffer.buffer, stsData, filename);
          fileId = stsData.file_id;
        } catch (err: any) {
          console.error("[Upload] Failed to upload image:", err.message);
          continue;
        }
      }

      if (fileUrl) {
        const isPng = filename.endsWith(".png");
        files.push({
          type: "image",
          file: {
            created_at: Date.now(),
            data: {},
            filename,
            hash: null,
            id: fileId,
            user_id: "proxy-user",
            meta: {
              name: filename,
              size: fileSize,
              content_type: isPng ? "image/png" : "image/jpeg",
            },
            update_at: Date.now(),
            lastModified: Date.now(),
            name: filename,
            webkitRelativePath: "",
            size: fileSize,
            type: isPng ? "image/png" : "image/jpeg",
          },
          id: fileId,
          url: fileUrl,
          name: filename,
          collection_name: "",
          progress: 100,
          status: "uploaded",
          greenNet: "success",
          size: fileSize,
          error: "",
          itemId: uuidv4(),
          file_type: isPng ? "image/png" : "image/jpeg",
          showType: "image",
          file_class: "vision",
          uploadTaskId: uuidv4(),
        });
      }
    }
  }

  return { text: textParts.join("\n"), files };
}
