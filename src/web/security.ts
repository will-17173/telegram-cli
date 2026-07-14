const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost'])

export function validateLocalRequest(request: Request, port: number): { ok: true } | { ok: false; status: number; code: string; message: string } {
  const host = request.headers.get('host') ?? ''
  if (!isAllowedHost(host, port)) {
    return { ok: false, status: 403, code: 'forbidden_origin', message: 'Web API accepts local Host headers only.' }
  }
  const origin = request.headers.get('origin')
  if (origin != null && origin !== `http://${host}`) {
    return { ok: false, status: 403, code: 'forbidden_origin', message: 'Web API accepts same-origin requests only.' }
  }
  return { ok: true }
}

export function isAllowedHost(host: string, port: number): boolean {
  return LOCAL_HOSTS.has(hostName(host, port))
}

function hostName(host: string, port: number): string {
  for (const localHost of LOCAL_HOSTS) {
    if (host === `${localHost}:${port}`) return localHost
  }
  return ''
}
