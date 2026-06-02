/*
 * File: upload.ts
 * Project: qwenproxy
 * File upload handler - forwards files to Qwen's OSS storage
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

interface FileTypeInfo {
  mime: string;
  showType: "image" | "video" | "audio" | "file";
  fileClass: "vision" | "video" | "audio" | "file";
  qwenFileType: "image" | "video" | "audio" | "file";
}

const DEFAULT_FILE_TYPE_INFO: FileTypeInfo = {
  mime: "application/octet-stream",
  showType: "file",
  fileClass: "file",
  qwenFileType: "file",
};

const FILE_TYPE_MAP: Record<string, FileTypeInfo> = {
  png: {
    mime: "image/png",
    showType: "image",
    fileClass: "vision",
    qwenFileType: "image",
  },
  jpg: {
    mime: "image/jpeg",
    showType: "image",
    fileClass: "vision",
    qwenFileType: "image",
  },
  jpeg: {
    mime: "image/jpeg",
    showType: "image",
    fileClass: "vision",
    qwenFileType: "image",
  },
  gif: {
    mime: "image/gif",
    showType: "image",
    fileClass: "vision",
    qwenFileType: "image",
  },
  webp: {
    mime: "image/webp",
    showType: "image",
    fileClass: "vision",
    qwenFileType: "image",
  },
  mp4: {
    mime: "video/mp4",
    showType: "video",
    fileClass: "video",
    qwenFileType: "video",
  },
  mov: {
    mime: "video/quicktime",
    showType: "video",
    fileClass: "video",
    qwenFileType: "video",
  },
  avi: {
    mime: "video/x-msvideo",
    showType: "video",
    fileClass: "video",
    qwenFileType: "video",
  },
  webm: {
    mime: "video/webm",
    showType: "video",
    fileClass: "video",
    qwenFileType: "video",
  },
  mkv: {
    mime: "video/x-matroska",
    showType: "video",
    fileClass: "video",
    qwenFileType: "video",
  },
  mp3: {
    mime: "audio/mpeg",
    showType: "audio",
    fileClass: "audio",
    qwenFileType: "audio",
  },
  wav: {
    mime: "audio/wav",
    showType: "audio",
    fileClass: "audio",
    qwenFileType: "audio",
  },
  ogg: {
    mime: "audio/ogg",
    showType: "audio",
    fileClass: "audio",
    qwenFileType: "audio",
  },
  flac: {
    mime: "audio/flac",
    showType: "audio",
    fileClass: "audio",
    qwenFileType: "audio",
  },
  m4a: {
    mime: "audio/mp4",
    showType: "audio",
    fileClass: "audio",
    qwenFileType: "audio",
  },
  aac: {
    mime: "audio/aac",
    showType: "audio",
    fileClass: "audio",
    qwenFileType: "audio",
  },
  pdf: {
    mime: "application/pdf",
    showType: "file",
    fileClass: "file",
    qwenFileType: "file",
  },
  doc: {
    mime: "application/msword",
    showType: "file",
    fileClass: "file",
    qwenFileType: "file",
  },
  docx: {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    showType: "file",
    fileClass: "file",
    qwenFileType: "file",
  },
  xls: {
    mime: "application/vnd.ms-excel",
    showType: "file",
    fileClass: "file",
    qwenFileType: "file",
  },
  xlsx: {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    showType: "file",
    fileClass: "file",
    qwenFileType: "file",
  },
  ppt: {
    mime: "application/vnd.ms-powerpoint",
    showType: "file",
    fileClass: "file",
    qwenFileType: "file",
  },
  pptx: {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    showType: "file",
    fileClass: "file",
    qwenFileType: "file",
  },
  txt: {
    mime: "text/plain",
    showType: "file",
    fileClass: "file",
    qwenFileType: "file",
  },
  md: {
    mime: "text/markdown",
    showType: "file",
    fileClass: "file",
    qwenFileType: "file",
  },
  csv: {
    mime: "text/csv",
    showType: "file",
    fileClass: "file",
    qwenFileType: "file",
  },
  json: {
    mime: "application/json",
    showType: "file",
    fileClass: "file",
    qwenFileType: "file",
  },
  xml: {
    mime: "application/xml",
    showType: "file",
    fileClass: "file",
    qwenFileType: "file",
  },
  html: {
    mime: "text/html",
    showType: "file",
    fileClass: "file",
    qwenFileType: "file",
  },
  zip: {
    mime: "application/zip",
    showType: "file",
    fileClass: "file",
    qwenFileType: "file",
  },
};

const SUPPORTED_MIME_TYPES = new Set(
  Object.values(FILE_TYPE_MAP).map((typeInfo) => typeInfo.mime),
);

function getFileExtension(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() || "";
}

function detectFileType(filename: string): FileTypeInfo {
  return FILE_TYPE_MAP[getFileExtension(filename)] || DEFAULT_FILE_TYPE_INFO;
}

function getExtensionFromMime(mime: string): string | undefined {
  for (const [ext, typeInfo] of Object.entries(FILE_TYPE_MAP)) {
    if (typeInfo.mime === mime) {
      return ext;
    }
  }
  return undefined;
}

function getMaxUploadSize(fileType: string): number {
  if (fileType.startsWith("video/")) return 100 * 1024 * 1024;
  if (fileType.startsWith("audio/")) return 50 * 1024 * 1024;
  return 20 * 1024 * 1024;
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
  fileBuffer: ArrayBuffer | Buffer,
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

  const buffer = Buffer.isBuffer(fileBuffer)
    ? fileBuffer
    : Buffer.from(fileBuffer);
  const contentType = detectFileType(filename).mime;

  await client.put(file_path, buffer, {
    headers: { "Content-Type": contentType },
  });

  return file_url.split("?")[0];
}

/**
 * Handle image upload endpoint
 * POST /v1/upload
 */
export async function uploadFile(c: Context) {
  try {
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return c.json({ error: "No file provided" }, 400);
    }

    // Detect MIME from filename if browser sends generic type
    let fileType = file.type;
    if (fileType === "application/octet-stream" || !fileType) {
      fileType = detectFileType(file.name).mime;
    }

    // Validate file type is supported by Qwen
    if (!SUPPORTED_MIME_TYPES.has(fileType)) {
      return c.json(
        {
          error: `Unsupported file type: ${file.type || "unknown"}. Supported: images, videos, audio, documents (PDF, DOC, XLS, PPT, TXT, MD, CSV, JSON, XML, HTML, ZIP)`,
        },
        400,
      );
    }

    // Determine media category for size limits
    const isVideo = fileType.startsWith("video/");
    const isAudio = fileType.startsWith("audio/");
    const isImage = fileType.startsWith("image/");
    const maxSize = getMaxUploadSize(fileType);
    if (file.size > maxSize) {
      const sizeLabel = isVideo
        ? "100MB (video)"
        : isAudio
          ? "50MB (audio)"
          : "20MB (image/doc)";
      return c.json({ error: `File too large. Max size: ${sizeLabel}` }, 400);
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

    // Determine Qwen filetype for STS token
    const qwenFileType = detectFileType(file.name).qwenFileType;

    const stsData = await getSTSToken(
      file.name,
      file.size,
      qwenFileType,
      headers,
    );
    const fileBuffer = await file.arrayBuffer();
    const fileUrl = await uploadToOSS(fileBuffer, stsData, file.name);

    return c.json({
      url: fileUrl,
      file_id: stsData.file_id,
      filename: file.name,
      type: qwenFileType,
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
 * Process OpenAI-style image/video content into Qwen file format
 */
export async function processImagesForQwen(
  content: Array<{
    type: string;
    text?: string;
    image_url?: { url: string };
    video_url?: { url: string };
    audio_url?: { url: string };
    file_url?: { url: string };
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
      (part.type === "video_url" && part.video_url?.url) ||
      (part.type === "audio_url" && part.audio_url?.url) ||
      (part.type === "file_url" && part.file_url?.url)
    ) {
      const mediaUrl =
        part.type === "video_url"
          ? part.video_url!.url
          : part.type === "audio_url"
            ? part.audio_url!.url
            : part.type === "file_url"
              ? part.file_url!.url
              : part.image_url!.url;
      let fileUrl = "";
      let filename = "";
      let fileSize = 0;
      let fileId = "";

      if (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://")) {
        fileUrl = mediaUrl;
        filename = mediaUrl.split("/").pop()?.split("?")[0] || "file.bin";
        fileId = uuidv4();
      } else if (mediaUrl.startsWith("data:")) {
        try {
          // Detect type from data URI
          const dataMime = mediaUrl.match(/^data:([^;]+)/)?.[1] || "";
          const isVideoData = dataMime.startsWith("video/");
          const isAudioData = dataMime.startsWith("audio/");
          const detectedExt =
            getExtensionFromMime(dataMime) ||
            (isVideoData ? "mp4" : isAudioData ? "mp3" : "png");
          const base64Data = mediaUrl.split(",")[1];
          const buffer = Buffer.from(base64Data, "base64");
          filename = `${isVideoData ? "video" : isAudioData ? "audio" : "file"}_${Date.now()}.${detectedExt}`;
          fileSize = buffer.length;
          const typeInfo = detectFileType(filename);
          const stsData = await getSTSToken(
            filename,
            fileSize,
            typeInfo.qwenFileType,
            headers,
          );
          fileUrl = await uploadToOSS(buffer, stsData, filename);
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
