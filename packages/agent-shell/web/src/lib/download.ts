/**
 * 渲染层下载工具。宿主已经把文件读成 base64，这里只负责解码、落 Blob，
 * 触发浏览器的 <a download> —— 桌面端点“用系统应用打开”没问题，但团队版
 * / 浏览器模式没有本地文件系统入口，下载必须走这条纯浏览器路径。
 */

export interface Base64Download {
  fileName: string;
  base64: string;
  /** 缺省 `application/octet-stream`，浏览器仍按文件名保存。 */
  mime?: string;
}

/** base64 → 字节。分块解码，避免大文件一次性 `charCodeAt` 阻塞太久。 */
export function base64ToBytes(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 把 base64 内容落成浏览器下载。调用方负责文件大小与授权校验。 */
export function saveBase64AsFile(input: Base64Download): void {
  const bytes = base64ToBytes(input.base64);
  const blob = new Blob([bytes], { type: input.mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = input.fileName || 'download';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Safari 需要等一拍再释放 ObjectURL，否则可能取消尚未开始的下载。
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
