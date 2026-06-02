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
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    mp4: "video/mp4",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    webm: "video/webm",
    mkv: "video/x-matroska",
  };
  const contentType = mimeMap[ext] || "application/octet-stream";

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

    const validImageTypes = [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
    ];
    const validVideoTypes = [
      "video/mp4",
      "video/quicktime",
      "video/x-msvideo",
      "video/webm",
      "video/x-matroska",
    ];
    const allValidTypes = [...validImageTypes, ...validVideoTypes];

    // Detect MIME from filename if browser sends generic type
    let fileType = file.type;
    if (fileType === "application/octet-stream" || !fileType) {
      const ext = file.name.split(".").pop()?.toLowerCase() || "";
      const extMimeMap: Record<string, string> = {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        gif: "image/gif",
        webp: "image/webp",
        mp4: "video/mp4",
        mov: "video/quicktime",
        avi: "video/x-msvideo",
        webm: "video/webm",
        mkv: "video/x-matroska",
      };
      fileType = extMimeMap[ext] || "application/octet-stream";
    }

    if (!allValidTypes.includes(fileType)) {
      return c.json(
        {
          error: `Invalid file type: ${file.type} (${fileType}). Supported: ${allValidTypes.join(", ")}`,
        },
        400,
      );
    }

    const isVideo = fileType.startsWith("video/");
    const maxSize = isVideo ? 100 * 1024 * 1024 : 20 * 1024 * 1024;
    if (file.size > maxSize) {
      return c.json(
        {
          error: `File too large. Max size: ${isVideo ? "100MB (video)" : "20MB (image)"}`,
        },
        400,
      );
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

    const isVideoFile = file.type.startsWith("video/");
    const stsData = await getSTSToken(
      file.name,
      file.size,
      isVideoFile ? "video" : "image",
      headers,
    );
    const fileBuffer = await file.arrayBuffer();
    const fileUrl = await uploadToOSS(fileBuffer, stsData, file.name);

    return c.json({
      url: fileUrl,
      file_id: stsData.file_id,
      filename: file.name,
      type: isVideoFile ? "video" : "image",
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
 * Detect file type from URL or filename
 */
function detectFileType(filename: string): {
  mime: string;
  showType: string;
  fileClass: string;
} {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const videoExts = ["mp4", "mov", "avi", "webm", "mkv"];
  if (videoExts.includes(ext)) {
    const mimeMap: Record<string, string> = {
      mp4: "video/mp4",
      mov: "video/quicktime",
      avi: "video/x-msvideo",
      webm: "video/webm",
      mkv: "video/x-matroska",
    };
    return {
      mime: mimeMap[ext] || "video/mp4",
      showType: "video",
      fileClass: "video",
    };
  }
  return { mime: "image/jpeg", showType: "image", fileClass: "vision" };
}

/**
 * Process OpenAI-style image/video content into Qwen file format
 */
export async function processImagesForQwen(
  content: Array<{
    type: string;
    text?: string;
    image_url?: { url: string };
    video_url?: { url: string };
  }>,
  headers: Record<string, string>,
): Promise<{ text: string; files: QwenFileEntry[] }> {
  const textParts: string[] = [];
  const files: QwenFileEntry[] = [];

  for (const part of content) {
    if (part.type === "text" && part.text) {
      textParts.push(part.text);
    } else if (
      (part.type === "image_url" && part.image_url?.url) ||
      (part.type === "video_url" && part.video_url?.url)
    ) {
      const mediaUrl =
        part.type === "video_url" ? part.video_url!.url : part.image_url!.url;
      const isVideo =
        part.type === "video_url" ||
        mediaUrl.match(/\.(mp4|mov|avi|webm|mkv)(\?|$)/i);
      let fileUrl = "";
      let filename = "";
      let fileSize = 0;
      let fileId = "";

      if (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://")) {
        fileUrl = mediaUrl;
        filename =
          mediaUrl.split("/").pop()?.split("?")[0] ||
          (isVideo ? "video.mp4" : "image.jpg");
        fileId = uuidv4();
      } else if (mediaUrl.startsWith("data:")) {
        try {
          const isBase64Video = mediaUrl.startsWith("data:video/");
          const base64Data = mediaUrl.split(",")[1];
          const buffer = Buffer.from(base64Data, "base64");
          filename = isBase64Video
            ? `video_${Date.now()}.mp4`
            : `image_${Date.now()}.png`;
          fileSize = buffer.length;
          const stsData = await getSTSToken(
            filename,
            fileSize,
            isBase64Video ? "video" : "image",
            headers,
          );
          fileUrl = await uploadToOSS(buffer.buffer, stsData, filename);
          fileId = stsData.file_id;
        } catch (err: any) {
          console.error("[Upload] Failed to upload media:", err.message);
          continue;
        }
      }

      if (fileUrl) {
        const typeInfo = detectFileType(filename);
        files.push({
          type: typeInfo.showType,
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
              content_type: typeInfo.mime,
            },
            update_at: Date.now(),
            lastModified: Date.now(),
            name: filename,
            webkitRelativePath: "",
            size: fileSize,
            type: typeInfo.mime,
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
          file_type: typeInfo.mime,
          showType: typeInfo.showType,
          file_class: typeInfo.fileClass,
          uploadTaskId: uuidv4(),
        });
      }
    }
  }

  return { text: textParts.join("\n"), files };
}
