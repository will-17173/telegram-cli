export async function resolve(specifier, context, nextResolve) {
  if (/\/telegram\/client-factory\.(?:js|ts)$/.test(specifier)) {
    return {
      shortCircuit: true,
      url: new URL('./group-write-client-factory.mjs', import.meta.url).href,
    }
  }
  return nextResolve(specifier, context)
}
