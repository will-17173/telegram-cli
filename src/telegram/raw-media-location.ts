import { FileLocation, Long } from '@mtcute/node'
import { strippedPhotoToJpg } from '@mtcute/node/utils.js'

type RawRecord = Record<string, unknown>

export function fileLocationFromRawMessage(raw: unknown): FileLocation | null {
  const root = parseRaw(raw)
  const media = recordValue(root?.media)
  if (media == null) return null

  const photo = recordValue(media.photo)
  if (photo != null) return photoFileLocation(photo)

  const document = recordValue(media.document)
  if (document != null) return documentFileLocation(document)

  return null
}

export function strippedPhotoPreviewBase64FromRawMessage(raw: unknown): string | undefined {
  const root = parseRaw(raw)
  const photo = recordValue(recordValue(root?.media)?.photo)
  const sizes = Array.isArray(photo?.sizes) ? photo.sizes : []
  const stripped = sizes.find((item) => recordValue(item)?._ === 'photoStrippedSize')
  const bytes = bytesLikeToUint8Array(recordValue(stripped)?.bytes)
  if (bytes == null) return undefined
  try {
    return Buffer.from(strippedPhotoToJpg(bytes)).toString('base64')
  } catch {
    return undefined
  }
}

function photoFileLocation(photo: RawRecord): FileLocation | null {
  const id = longValue(photo.id)
  const accessHash = longValue(photo.accessHash)
  const fileReference = bytesLikeToUint8Array(photo.fileReference)
  if (id == null || accessHash == null || fileReference == null) return null

  return new FileLocation({
    _: 'inputPhotoFileLocation',
    id,
    accessHash,
    fileReference,
    thumbSize: largestPhotoSizeType(photo) ?? '',
  }, largestPhotoSize(photo), numberValue(photo.dcId))
}

function documentFileLocation(document: RawRecord): FileLocation | null {
  const id = longValue(document.id)
  const accessHash = longValue(document.accessHash)
  const fileReference = bytesLikeToUint8Array(document.fileReference)
  if (id == null || accessHash == null || fileReference == null) return null

  return new FileLocation({
    _: 'inputDocumentFileLocation',
    id,
    accessHash,
    fileReference,
    thumbSize: '',
  }, numberValue(document.size), numberValue(document.dcId))
}

function largestPhotoSizeType(photo: RawRecord): string | null {
  const sizes = Array.isArray(photo.sizes) ? photo.sizes : []
  let selected: { type: string; size: number } | null = null
  for (const item of sizes) {
    const size = recordValue(item)
    const type = stringValue(size?.type)
    const bytes = numberValue(size?.size)
    if (type == null || bytes == null) continue
    if (selected == null || bytes > selected.size) selected = { type, size: bytes }
  }
  return selected?.type ?? null
}

function largestPhotoSize(photo: RawRecord): number | undefined {
  const sizes = Array.isArray(photo.sizes) ? photo.sizes : []
  let selected: number | undefined
  for (const item of sizes) {
    const bytes = numberValue(recordValue(item)?.size)
    if (bytes == null) continue
    if (selected == null || bytes > selected) selected = bytes
  }
  return selected
}

function parseRaw(raw: unknown): RawRecord | null {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      return recordValue(parsed)
    } catch {
      return null
    }
  }
  return recordValue(raw)
}

function recordValue(value: unknown): RawRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as RawRecord : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function longValue(value: unknown): Long | null {
  const record = recordValue(value)
  if (record == null) return null
  const low = numberValue(record.low)
  const high = numberValue(record.high)
  if (low == null || high == null) return null
  const unsigned = typeof record.unsigned === 'boolean' ? record.unsigned : undefined
  return Long.fromBits(low, high, unsigned)
}

function bytesLikeToUint8Array(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  const bytes = Array.isArray(value)
    ? value
    : recordValue(value) == null ? null : Object.keys(value as RawRecord)
      .filter((key) => /^\d+$/.test(key))
      .sort((left, right) => Number(left) - Number(right))
      .map((key) => (value as RawRecord)[key])
  if (bytes == null || bytes.length === 0) return null
  if (!bytes.every((item): item is number => typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 255)) return null
  return Uint8Array.from(bytes)
}
