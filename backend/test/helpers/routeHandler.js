// Extracts the terminal handler for a route directly off an Express Router
// instance (bypassing router.use()-level middleware like requireAuth/
// requirePermission, which live one file up from these routers — see
// routes/generator-care/index.js and routes/customer.js's own router.use).
// Lets a test invoke the REAL, shipped route-handler function with a fake
// req/res, no HTTP server or auth token needed.

function getRouteHandler(router, method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`getRouteHandler: no ${method.toUpperCase()} ${path} route found`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function makeReq({ params, body, query, user } = {}) {
  return { params: params || {}, body: body || {}, query: query || {}, user: user || undefined };
}

function makeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

module.exports = { getRouteHandler, makeReq, makeRes };
