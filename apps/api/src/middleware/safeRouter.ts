import { Router, RequestHandler } from 'express';

function wrap(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/**
 * Express 4 does NOT automatically catch a rejected promise thrown inside an `async (req, res) => {}`
 * route handler — an unhandled rejection from a database error (or anything else) crashes the entire
 * Node process, taking every other in-flight request down with it. This showed up during Phase-1
 * testing: a single malformed query on the fault-detail route killed the whole API.
 *
 * createRouter() returns a drop-in Router whose get/post/put/patch/delete automatically forward a
 * rejected handler promise to `next(err)` (into server.ts's error-handling middleware, which returns a
 * clean 500 instead of crashing) — so every route file just does
 * `export const xRouter = createRouter()` instead of `Router()` and gets this for free, without having
 * to wrap every single handler by hand.
 */
export function createRouter() {
  const router = Router();
  (['get', 'post', 'put', 'patch', 'delete'] as const).forEach((method) => {
    const original = router[method].bind(router);
    (router as any)[method] = (path: string, ...handlers: RequestHandler[]) => original(path, ...handlers.map(wrap));
  });
  return router;
}
