import { extname, join, parse } from 'node:path'

type ResolveAttachmentDestinationOptions = {
  homeDir: string
  fileName: string
  exists: (path: string) => boolean
}

export function resolveAttachmentDestination(options: ResolveAttachmentDestinationOptions): string {
  const directory = join(options.homeDir, 'Downloads', 'telegram-cli')
  const safeName = sanitizeFileName(options.fileName)
  let destination = join(directory, safeName)
  if (!options.exists(destination)) return destination

  const extension = extname(safeName)
  const baseName = parse(safeName).name
  let index = 2
  do {
    destination = join(directory, `${baseName} (${index})${extension}`)
    index += 1
  } while (options.exists(destination))
  return destination
}

function sanitizeFileName(fileName: string): string {
  const leaf = fileName.replaceAll('\\', '/').split('/').at(-1)?.trim() || 'attachment'
  return leaf.replace(/[<>:"|?*\u0000-\u001F]/g, '_') || 'attachment'
}
