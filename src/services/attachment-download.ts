import { extname, join, parse } from 'node:path'

type ResolveAttachmentDestinationOptions = {
  homeDir: string
  fileName: string
  exists: (path: string) => boolean
  reserved?: ReadonlySet<string>
}

export function resolveAttachmentDestination(options: ResolveAttachmentDestinationOptions): string {
  const directory = join(options.homeDir, 'Downloads', 'telegram-cli')
  const safeName = sanitizeAttachmentFileName(options.fileName)
  let destination = join(directory, safeName)
  if (!collides(destination, options)) return destination

  const extension = extname(safeName)
  const baseName = parse(safeName).name
  let index = 2
  do {
    destination = join(directory, `${baseName} (${index})${extension}`)
    index += 1
  } while (collides(destination, options))
  return destination
}

function collides(path: string, options: ResolveAttachmentDestinationOptions): boolean {
  return options.exists(path) || options.reserved?.has(path) === true
}

export function sanitizeAttachmentFileName(fileName: string): string {
  const leaf = fileName.replaceAll('\\', '/').split('/').at(-1)?.trim() || 'attachment'
  return leaf.replace(/[<>:"|?*\u0000-\u001F]/g, '_') || 'attachment'
}

export function attachmentDownloadProgress(downloaded: number, total: number): number | null {
  return Number.isFinite(total) && total > 0
    ? Math.round(downloaded / total * 100)
    : null
}
