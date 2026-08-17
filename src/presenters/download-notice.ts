const ANSI_GREEN = '\u001b[32m'
const ANSI_RED = '\u001b[31m'
const ANSI_RESET_FOREGROUND = '\u001b[39m'

type DownloadNoticeOptions = {
  colors?: boolean
}

export function formatDownloadNotice(
  message: string,
  options: DownloadNoticeOptions = {},
): string {
  const colors = options.colors
    ?? (process.stderr.isTTY === true && process.env.NO_COLOR == null)
  if (!colors) return message

  if (message.startsWith('downloaded:')) {
    return `${ANSI_GREEN}${message}${ANSI_RESET_FOREGROUND}`
  }
  if (message.startsWith('download failed:')) {
    return `${ANSI_RED}${message}${ANSI_RESET_FOREGROUND}`
  }
  return message
}
