export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('/telegram/client-factory.js')) {
    return {
      shortCircuit: true,
      url: new URL('./group-write-client-factory.mjs', import.meta.url).href,
    }
  }
  return nextResolve(specifier, context)
}
