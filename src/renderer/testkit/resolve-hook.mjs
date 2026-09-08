export async function resolve(spec, ctx, next) {
  if (spec === 'three') {
    return { url: new URL('./three-stub.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(spec, ctx);
}
