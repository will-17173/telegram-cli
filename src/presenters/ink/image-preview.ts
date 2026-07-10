import jpeg from 'jpeg-js'

export interface PreviewCell {
  glyph: '▀'
  foreground: string
  background: string
}

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
    const decoded = jpeg.decode(Buffer.from(base64, 'base64'), { useTArray: true })
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
