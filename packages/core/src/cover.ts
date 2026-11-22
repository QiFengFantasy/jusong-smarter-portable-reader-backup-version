/**
 * 封面：EPUB 解析出的原始图片 → 导入前缩放编码。
 *
 * 存储约定：用户库 `books/<bookId>/cover.jpg` + book.json `coverFile`/`coverMime`。
 * 原始封面可能很大（数 MB），入库前缩放到适合书架卡片的尺寸并统一编码为 JPEG，
 * 避免用户库体积膨胀与前端解码开销。
 *
 * 该模块在 WebView（有 DOM/Canvas）里调用；解码失败/不支持的类型/异常一律返回 null，
 * 由界面回落占位封面，不阻塞导入。
 */

/** EPUB 内解析到的封面原始图片。 */
export interface ParsedCover {
  bytes: Uint8Array;
  /** 原始 MIME（image/jpeg、image/png 等）。 */
  mime: string;
}

/** 缩放编码后的封面（导入 IPC 用 base64）。 */
export interface PreparedCover {
  mime: string;
  base64: string;
}

/** 封面目标宽度上限（px）；高度按原比例。书架卡片显示约 100×136 CSS px。 */
export const COVER_TARGET_MAX_WIDTH = 480;
/** JPEG 质量。 */
export const COVER_JPEG_QUALITY = 0.85;
/** 入库大小上限（字节）；超过则认为不可用，回落占位。 */
export const COVER_MAX_DECODED_BYTES = 2 * 1024 * 1024;

/** 超过入库上限时逐级降质量（从 COVER_JPEG_QUALITY 开始）。 */
const COVER_QUALITY_STEPS: readonly number[] = [COVER_JPEG_QUALITY, 0.7, 0.55, 0.4];

/** 分块 btoa，避免大图一次性展开超长参数列表 / 调用栈溢出。 */
const BASE64_CHUNK_SIZE = 0x8000;

function canUseCanvas(): boolean {
  return typeof document !== "undefined" && typeof createImageBitmap === "function";
}

/**
 * Uint8Array → Blob。先复制到独立 ArrayBuffer：
 * 1) 原始 bytes 可能是更大的 buffer 上的视图，直接传给 Blob 会带上无关字节；
 * 2) 不同 TS lib 下 Uint8Array 与 BlobPart 的型别不完全兼容，这里做类型断言，
 *    而不是关闭类型检查。
 */
function bytesToBlob(bytes: Uint8Array, mime: string): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy as unknown as BlobPart], { type: mime });
}

function canvasToJpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise(resolve => {
    try {
      canvas.toBlob(blob => resolve(blob), "image/jpeg", quality);
    } catch {
      resolve(null);
    }
  });
}

function toBase64Chunked(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * 缩放并编码封面：createImageBitmap 解码 → 白底 canvas 等比缩到宽 ≤ 480 →
 * toBlob("image/jpeg", 0.85)，超过 2MB 时逐级降质量 → base64。
 * 解码失败、SVG、尺寸异常或超出上限时返回 null（显示占位封面）。
 */
export async function prepareCoverImage(cover: ParsedCover): Promise<PreparedCover | null> {
  if (!cover.bytes || cover.bytes.byteLength === 0) return null;
  // SVG 在各 WebView 的 createImageBitmap 支持不一致，且通常只是矢量占位，统一不处理。
  if (cover.mime.trim().toLowerCase() === "image/svg+xml") return null;
  if (!canUseCanvas()) return null;

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(bytesToBlob(cover.bytes, cover.mime));
    const sourceWidth = bitmap.width;
    const sourceHeight = bitmap.height;
    if (
      !Number.isFinite(sourceWidth) ||
      !Number.isFinite(sourceHeight) ||
      sourceWidth <= 0 ||
      sourceHeight <= 0
    ) {
      return null;
    }

    // 只缩小不放大：小图保持原尺寸，宽图按 480 等比缩放。
    const scale = Math.min(1, COVER_TARGET_MAX_WIDTH / sourceWidth);
    const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
    const targetHeight = Math.max(1, Math.round(sourceHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext("2d");
    if (!context) return null;

    // 白底：透明 PNG 直接转 JPEG 会得到黑底/脏边。
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, targetWidth, targetHeight);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

    let jpeg: Blob | null = null;
    for (const quality of COVER_QUALITY_STEPS) {
      jpeg = await canvasToJpegBlob(canvas, quality);
      if (!jpeg) return null;
      if (jpeg.size > 0 && jpeg.size <= COVER_MAX_DECODED_BYTES) break;
    }
    if (!jpeg || jpeg.size === 0 || jpeg.size > COVER_MAX_DECODED_BYTES) return null;

    const encoded = new Uint8Array(await jpeg.arrayBuffer());
    return { mime: "image/jpeg", base64: toBase64Chunked(encoded) };
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}
