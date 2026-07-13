/**
 * Copyright (c) 2025 johngbl
 * QwenBridge - OpenAI-compatible proxy for Qwen
 */

import { Context } from "hono";
import { Readable } from "stream";
import {
  getBasicHeaders,
  isAuthMockEnabled,
} from "../services/auth-playwright.ts";
import { v4 as uuidv4 } from "uuid";
import { ValidationError, ServiceUnavailable } from "../core/errors.js";
import { sendOpenAIError } from "../api/error-helpers.js";
import { buildQwenRequestHeaders } from "../services/qwen-headers.ts";
import { config } from "../core/config.ts";

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

function getFilenameFromUrl(url: string, mime?: string): string {
  let filename = "";

  try {
    filename = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
  } catch {
    filename = url.split("/").pop()?.split("?")[0] || "";
  }

  if (!filename) {
    filename = "file";
  }

  if (!filename.includes(".")) {
    const ext = mime ? getExtensionFromMime(mime) : undefined;
    if (ext) {
      filename = `${filename}.${ext}`;
    }
  }

  return filename || "file.bin";
}

async function downloadRemoteMedia(url: string): Promise<{
  buffer: Buffer;
  filename: string;
  mime: string;
}> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": config.auth.userAgent,
      Accept: "image/*,*/*;q=0.8",
    },
  });
  if (!response.ok) {
    throw new Error(`Remote media download failed: ${response.status}`);
  }

  const headerMime =
    response.headers.get("content-type")?.split(";")[0].trim() || "";
  const filename = getFilenameFromUrl(url, headerMime || undefined);
  const detectedMime =
    headerMime && SUPPORTED_MIME_TYPES.has(headerMime)
      ? headerMime
      : detectFileType(filename).mime;

  if (!SUPPORTED_MIME_TYPES.has(detectedMime)) {
    throw new Error(
      `Unsupported remote media type: ${headerMime || detectedMime || "unknown"}`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const maxSize = getMaxUploadSize(detectedMime);
  if (buffer.length > maxSize) {
    throw new Error(`Remote media too large: ${buffer.length}`);
  }

  return {
    buffer,
    filename,
    mime: detectedMime,
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
      headers: buildQwenRequestHeaders({
        cookie: headers.cookie,
        userAgent: headers["user-agent"],
        bxUa: headers["bx-ua"],
        bxUmidtoken: headers["bx-umidtoken"],
        bxV: headers["bx-v"],
      }),
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

/** Minimal OSS client surface used by upload helpers (easy to mock in tests). */
export interface OssUploadClient {
  putStream: (
    name: string,
    stream: Readable,
    options?: {
      contentLength?: number;
      headers?: Record<string, string>;
    },
  ) => Promise<unknown>;
  multipartUpload: (
    name: string,
    file: Buffer | string,
    options?: {
      partSize?: number;
      headers?: Record<string, string>;
    },
  ) => Promise<unknown>;
}

/**
 * Stream-friendly OSS body upload:
 * - small/medium: putStream (avoids ali-oss put() extra buffering path)
 * - large: multipartUpload (better reliability for big media)
 */
export async function uploadBufferToOssClient(
  client: OssUploadClient,
  filePath: string,
  buffer: Buffer,
  contentType: string,
  multipartThresholdBytes: number = config.oss.multipartThresholdBytes,
): Promise<"putStream" | "multipart"> {
  const headers = { "Content-Type": contentType };

  if (buffer.length >= multipartThresholdBytes) {
    const partSize = Math.min(
      5 * 1024 * 1024,
      Math.max(256 * 1024, Math.floor(buffer.length / 4)),
    );
    await client.multipartUpload(filePath, buffer, {
      partSize,
      headers,
    });
    return "multipart";
  }

  await client.putStream(filePath, Readable.from(buffer), {
    contentLength: buffer.length,
    headers,
  });
  return "putStream";
}

/**
 * Upload file to Alibaba Cloud OSS using STS credentials
 */
async function uploadToOSS(
  fileBuffer: ArrayBuffer | Buffer,
  stsData: STSResponse["data"],
  filename: string,
): Promise<string> {
  if (isAuthMockEnabled()) {
    return stsData.file_url.split("?")[0];
  }
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
  }) as unknown as OssUploadClient;

  const buffer = Buffer.isBuffer(fileBuffer)
    ? fileBuffer
    : Buffer.from(fileBuffer);
  const contentType = detectFileType(filename).mime;

  await uploadBufferToOssClient(client, file_path, buffer, contentType);

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
      return sendOpenAIError(c, new ValidationError("No file provided"));
    }

    // Detect MIME from filename if the client sends a generic type
    let fileType = file.type;
    if (fileType === "application/octet-stream" || !fileType) {
      fileType = detectFileType(file.name).mime;
    }

    // Validate file type is supported by Qwen
    if (!SUPPORTED_MIME_TYPES.has(fileType)) {
      return sendOpenAIError(
        c,
        new ValidationError(
          `Unsupported file type: ${file.type || "unknown"}. Supported: images, videos, audio, documents (PDF, DOC, XLS, PPT, TXT, MD, CSV, JSON, XML, HTML, ZIP)`,
        ),
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
      return sendOpenAIError(
        c,
        new ValidationError(`File too large. Max size: ${sizeLabel}`),
      );
    }

    let headers: Record<string, string>;
    try {
      const { cookie, userAgent, bxV, bxUa, bxUmidtoken } =
        await getBasicHeaders();
      headers = {
        cookie,
        "user-agent": userAgent,
        "bx-v": bxV,
      };
      if (bxUa) headers["bx-ua"] = bxUa;
      if (bxUmidtoken) headers["bx-umidtoken"] = bxUmidtoken;
    } catch (error) {
      return sendOpenAIError(
        c,
        new ServiceUnavailable(
          `Authentication unavailable: ${error instanceof Error ? error.message : String(error)}`,
        ),
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
  } catch (error) {
    console.error(
      "[Upload] Error:",
      error instanceof Error ? error.message : String(error),
    );
    return sendOpenAIError(c, error);
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
        try {
          const remoteMedia = await downloadRemoteMedia(mediaUrl);
          filename = remoteMedia.filename;
          fileSize = remoteMedia.buffer.length;
          const typeInfo = detectFileType(filename);
          const stsData = await getSTSToken(
            filename,
            fileSize,
            typeInfo.qwenFileType,
            headers,
          );
          fileUrl = await uploadToOSS(remoteMedia.buffer, stsData, filename);
          fileId = stsData.file_id;
        } catch (err: any) {
          console.warn(
            `[Upload] Failed to re-upload remote media, falling back to source URL: ${err.message}`,
          );
          fileUrl = mediaUrl;
          filename = getFilenameFromUrl(mediaUrl);
          fileId = uuidv4();
        }
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
          console.error("❌ [Upload] Failed to upload media:", err.message);
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
