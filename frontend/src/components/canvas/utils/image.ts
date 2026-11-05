// 图片处理函数

// 下载前必须拿到完整的图片 Blob。短暂的本地后端抖动会自动重试，
// 且空响应/错误页不会被当成图片写入磁盘。
export async function fetchImageBlob(url: string, attempts = 3): Promise<Blob> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { cache: attempt === 0 ? "default" : "reload" });
      if (!response.ok) {
        throw new Error(`图片请求失败 (${response.status})`);
      }
      const blob = await response.blob();
      if (blob.size === 0) {
        throw new Error("图片内容为空");
      }
      if (blob.type && !blob.type.startsWith("image/")) {
        throw new Error(`返回内容不是图片 (${blob.type})`);
      }
      return blob;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => window.setTimeout(resolve, 180 * (attempt + 1)));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("图片加载失败");
}

// 系统剪贴板对图片格式的支持并不统一，Chromium/macOS 下 PNG 最稳定。
// JPEG、WebP、SVG 等先在浏览器内无损解码，再绘制为 PNG；透明背景会被保留。
export async function convertImageBlobToPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;

  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("图片解码失败"));
      image.src = objectUrl;
    });
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) throw new Error("图片尺寸无效");

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法转换图片");
    context.drawImage(image, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (png) => (png ? resolve(png) : reject(new Error("PNG 转换失败"))),
        "image/png",
      );
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
