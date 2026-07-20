// Express 4 does not catch rejected promises from async route handlers — an uncaught
// rejection becomes an unhandled rejection at the process level, which crashes the whole
// server (bad for a demo where one bad request would take down every judge's session).
// Wrap every async handler with this so errors reach the error-handling middleware instead.
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
