import { getDesktopCommands } from './command-catalog.js'
import { DesktopTaskError, type DesktopTaskRunner } from './command-tasks.js'
import type { DesktopCommandInput, DesktopListenInput } from './workspace-types.js'

export async function handleWorkspaceApiRequest(request: Request, context: { taskRunner: DesktopTaskRunner }): Promise<Response> {
  const { pathname } = new URL(request.url)
  const { taskRunner } = context
  try {
    if (pathname === '/api/workspace/commands' && request.method === 'GET') return success(getDesktopCommands())
    if (pathname === '/api/workspace/tasks') {
      if (request.method === 'GET') return success(taskRunner.list().map((task) => ({ ...task, stdout: '', stderr: '', result: null })))
      if (request.method === 'POST') {
        const body = await jsonBody(request)
        return success(taskRunner.start(body as DesktopCommandInput))
      }
    }
    const sendMatch = /^\/api\/workspace\/tasks\/([^/]+)\/send$/.exec(pathname)
    if (sendMatch != null && request.method === 'POST') {
      const id = decodeURIComponent(sendMatch[1])
      return success(await taskRunner.sendInput(id, await jsonBody(request) as DesktopListenInput))
    }
    const match = /^\/api\/workspace\/tasks\/([^/]+)$/.exec(pathname)
    if (match != null && (request.method === 'GET' || request.method === 'DELETE')) {
      const id = decodeURIComponent(match[1])
      const task = request.method === 'GET' ? taskRunner.get(id) : taskRunner.cancel(id)
      if (task == null) return failure(404, 'not_found', 'Desktop task not found.')
      return success(task)
    }
    return failure(404, 'not_found', 'API route not found.')
  } catch (error) {
    if (error instanceof DesktopTaskError) return failure(error.status, error.code, error.message)
    if (error instanceof URIError) return failure(400, 'invalid_request', 'Task ID must be valid URL encoding.')
    return failure(500, 'execution_failed', 'Desktop operation could not be started.')
  }
}

async function jsonBody(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new DesktopTaskError(400, 'invalid_request', 'Content-Type must include application/json.')
  }
  try { return await request.json() } catch { throw new DesktopTaskError(400, 'invalid_request', 'Request body must be valid JSON.') }
}

function success(data: unknown): Response {
  return json(200, { ok: true, data })
}

function failure(status: number, code: string, message: string): Response {
  return json(status, { ok: false, error: { code, message } })
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
