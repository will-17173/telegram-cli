import { DesktopAuthError, type DesktopAuthManager } from './auth-manager.js'

export type AuthApiContext = { authManager: DesktopAuthManager }

export async function handleAuthApiRequest(request: Request, context: AuthApiContext): Promise<Response> {
  try {
    const pathname = new URL(request.url).pathname
    if (pathname === '/api/auth/sessions') {
      if (request.method === 'GET') return success(context.authManager.current())
      if (request.method !== 'POST') return notFound()
      const body = await readBody(request)
      if (Object.keys(body).some((key) => key !== 'account')) throw invalidRequest('Unknown authentication property.')
      if ('account' in body && (typeof body.account !== 'string' || body.account.trim().length === 0)) {
        throw invalidRequest('account must be a non-empty string.')
      }
      return success(context.authManager.start({ account: body.account as string | undefined }))
    }

    const match = /^\/api\/auth\/sessions\/([^/]+)$/.exec(pathname)
    if (match == null) return notFound()
    let id: string
    try {
      id = decodeURIComponent(match[1]!)
    } catch {
      throw invalidRequest('Invalid authentication session ID.')
    }

    if (request.method === 'GET') return success(context.authManager.get(id))
    if (request.method === 'DELETE') return success(context.authManager.cancel(id))
    if (request.method !== 'POST') return notFound()
    const body = await readBody(request)
    if (Object.keys(body).some((key) => key !== 'value') || typeof body.value !== 'string') {
      throw invalidRequest('Request body must contain only a string value.')
    }
    return success(context.authManager.submit(id, body.value))
  } catch (error) {
    if (error instanceof DesktopAuthError) return failure(error.status, error.code, error.message)
    return failure(500, 'internal_error', 'Internal authentication API error.')
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw invalidRequest('Content-Type must include application/json.')
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw invalidRequest('Request body must be valid JSON.')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidRequest('Request body must be a JSON object.')
  }
  return body as Record<string, unknown>
}

function success(data: unknown): Response {
  return jsonResponse(200, { ok: true, data })
}

function failure(status: number, code: string, message: string): Response {
  return jsonResponse(status, { ok: false, error: { code, message } })
}

function notFound(): Response {
  return failure(404, 'not_found', 'API route not found.')
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

function invalidRequest(message: string): DesktopAuthError {
  return new DesktopAuthError('invalid_request', message)
}
