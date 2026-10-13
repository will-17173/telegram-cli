export const DESKTOP_PAGES = ['messages', 'operations', 'accounts', 'guard'] as const
export type DesktopPage = typeof DESKTOP_PAGES[number]

export function initialDesktopPage(search: string): DesktopPage {
  const page = new URLSearchParams(search).get('page')
  return DESKTOP_PAGES.includes(page as DesktopPage) ? page as DesktopPage : 'messages'
}

export function desktopPageUrl(url: string, page: DesktopPage, command?: string): string {
  const next = new URL(url)
  next.searchParams.set('page', page)
  if (page === 'operations' && command) next.searchParams.set('command', command)
  else next.searchParams.delete('command')
  return next.toString()
}
