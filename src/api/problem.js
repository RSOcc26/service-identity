import { randomUUID } from 'node:crypto';

// A client- or gateway-supplied X-Request-Id is reused only if it is short and
// safe to log (same rule as the gateway), so logs of both can be correlated
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;
export const genRequestId = (req) => {
  const supplied = req.headers['x-request-id'];
  return typeof supplied === 'string' && SAFE_ID.test(supplied) ? supplied : randomUUID();
};

// RFC 9457 problem document with the correlation ID, like the gateway's
export const sendProblem = (reply, status, title, detail) => reply
  .code(status)
  .type('application/problem+json')
  .send({ type: 'about:blank', title, status, ...(detail && { detail }), correlationId: reply.request.id });
