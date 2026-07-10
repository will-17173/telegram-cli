import jpeg from 'jpeg-js'

const MAX_ENCODED_JPEG_BYTES = 64 * 1024
const MAX_RESOLUTION_IN_MP = 1
const MAX_MEMORY_USAGE_IN_MB = 16
import type { PreviewCell } from '../listen-message.js'

export type { PreviewCell } from '../listen-message.js'

export interface DecodedImagePreview {
  width: number
  rows: PreviewCell[][]
}

function pixelColor(data: Uint8Array, width: number, x: number, y: number): string {
  const offset = (y * width + x) * 4
  return `#${data[offset].toString(16).padStart(2, '0')}${data[offset + 1].toString(16).padStart(2, '0')}${data[offset + 2].toString(16).padStart(2, '0')}`
}

export function decodeImagePreview(base64: string, maxWidth: number): DecodedImagePreview | null {
  if (base64.length === 0 || maxWidth < 1) {
    return null
  }

  try {
    const encoded = Buffer.from(base64, 'base64')
    if (encoded.length > MAX_ENCODED_JPEG_BYTES) {
      return null
    }

    const decoded = jpeg.decode(encoded, {
      useTArray: true,
      maxResolutionInMP: MAX_RESOLUTION_IN_MP,
      maxMemoryUsageInMB: MAX_MEMORY_USAGE_IN_MB,
    })
    const width = Math.min(decoded.width, Math.floor(maxWidth))
    const height = Math.max(1, Math.round(decoded.height * (width / decoded.width)))
    const rows: PreviewCell[][] = []

    for (let y = 0; y < height; y += 2) {
      const upperSourceY = Math.min(decoded.height - 1, Math.floor(y * decoded.height / height))
      const lowerY = Math.min(y + 1, height - 1)
      const lowerSourceY = Math.min(decoded.height - 1, Math.floor(lowerY * decoded.height / height))
      const row: PreviewCell[] = []

      for (let x = 0; x < width; x += 1) {
        const sourceX = Math.min(decoded.width - 1, Math.floor(x * decoded.width / width))
        row.push({
          glyph: '▀',
          foreground: pixelColor(decoded.data, decoded.width, sourceX, upperSourceY),
          background: pixelColor(decoded.data, decoded.width, sourceX, lowerSourceY),
        })
      }

      rows.push(row)
    }

    return { width, rows }
  } catch {
    return null
  }
}
