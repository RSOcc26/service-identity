import { KafkaJS } from '@confluentinc/kafka-javascript';

// Kafka producer for the outbox relay: idempotent, acks from all replicas
export const createKafkaPublisher = ({ brokers, clientId, saslMechanism, username, password }) => {
  const kafka = new KafkaJS.Kafka({
    kafkaJS: {
      clientId,
      brokers,
      logLevel: KafkaJS.logLevel.ERROR,
      ...(saslMechanism && { sasl: { mechanism: saslMechanism, username, password } }),
    },
  });
  const producer = kafka.producer({ kafkaJS: { idempotent: true, acks: -1 } });
  let connected = null;
  return {
    async send(topic, messages) {
      connected ??= producer.connect().catch((err) => { connected = null; throw err; });
      await connected;
      await producer.send({ topic, messages });
    },
    async close() {
      if (connected) await producer.disconnect().catch(() => {});
    },
  };
};

const LOCK_KEY = 'service-identity.outbox-relay';

// Publishes pending outbox rows and marks them published. One relay runs at a
// time across replicas (advisory lock), in ID order (UUIDv7, insertion time),
// so events of one user keep their order. No transaction is held while
// sending: a crash between sending and marking means a resend
// (at-least-once; consumers are idempotent), never a loss.
export const relayOutbox = async ({ db, publisher, batchSize = 100 }) => {
  const lock = await db.connect();
  try {
    const { rows: [{ locked }] } = await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [LOCK_KEY]);
    if (!locked) return 0;
    try {
      const { rows } = await lock.query(
        'SELECT id, topic, key, payload FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT $1',
        [batchSize],
      );
      if (rows.length === 0) return 0;
      for (const [topic, messages] of Map.groupBy(rows, (r) => r.topic)) {
        await publisher.send(topic, messages.map((m) => ({ key: m.key, value: JSON.stringify(m.payload) })));
      }
      await lock.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1)', [rows.map((r) => r.id)]);
      return rows.length;
    } finally {
      await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]);
    }
  } finally {
    lock.release();
  }
};
