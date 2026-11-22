import { randomUUID } from 'node:crypto';

// This service's own topic (KAFKA_TOPIC), identity.events by default
export const TOPIC = process.env.KAFKA_TOPIC || 'identity.events';

// Writes an event in the caller's transaction (architecture §5 envelope).
// Events carry IDs only, never personal data.
export const enqueueEvent = (client, { type, key, data, correlationId, tenantId = null }) => client.query(
  'INSERT INTO outbox (topic, key, payload) VALUES ($1, $2, $3)',
  [TOPIC, key, {
    id: randomUUID(),
    type,
    version: 1,
    occurredAt: new Date().toISOString(),
    tenantId,
    correlationId: correlationId ?? null,
    producer: 'service-identity',
    data,
  }],
);

// Queues work against the identity provider in the caller's transaction
export const enqueueIdpTask = (client, { action, externalSubject }) => client.query(
  'INSERT INTO idp_tasks (action, external_subject) VALUES ($1, $2)',
  [action, externalSubject],
);
