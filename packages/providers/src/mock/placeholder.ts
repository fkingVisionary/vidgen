const escapeXml = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

/** A clearly labelled placeholder frame standing in for generated imagery. */
export function placeholderSvg(opts: { label: string; detail: string; width: number; height: number }): Uint8Array {
  const { width, height } = opts;
  const detail = opts.detail.length > 140 ? `${opts.detail.slice(0, 137)}…` : opts.detail;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#1f2328"/>
  <rect x="8" y="8" width="${width - 16}" height="${height - 16}" fill="none" stroke="#f0b429" stroke-width="4" stroke-dasharray="24 12"/>
  <text x="50%" y="45%" fill="#f0b429" font-family="monospace" font-size="${Math.round(height / 8)}" text-anchor="middle">${escapeXml(opts.label)}</text>
  <text x="50%" y="60%" fill="#d0d7de" font-family="monospace" font-size="${Math.round(height / 30)}" text-anchor="middle">${escapeXml(detail)}</text>
</svg>`;
  return new TextEncoder().encode(svg);
}

export function aspectDimensions(aspect: string): { width: number; height: number } {
  switch (aspect) {
    case '9:16':
      return { width: 1080, height: 1920 };
    case '1:1':
      return { width: 1080, height: 1080 };
    case '4:3':
      return { width: 1440, height: 1080 };
    case '21:9':
      return { width: 2520, height: 1080 };
    default:
      return { width: 1920, height: 1080 };
  }
}
