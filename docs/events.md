# Events

> The contract is [`asyncapi.yaml`](asyncapi.yaml) (AsyncAPI 3.0): topic, message
> schemas, delivery guarantees and the planned events. This page is a summary;
> `test/unit/events-contract.test.js` checks the code against the contract.

Published to `identity.events` through the transactional outbox (architecture
§5): the event is written in the same transaction as the change and published
by the relay, so delivery is at-least-once. The message key is the user ID.
Events carry IDs only, never personal data.

Envelope fields: `id`, `type`, `version`, `occurredAt`, `tenantId` (`null` for
user events), `correlationId`, `producer` (`service-identity`), `data`.

| Type | Version | `data` | Meaning |
|---|---|---|---|
| `identity.user.updated` | 1 | `{ userId }` | An admin changed the user's email or names; read the user again if you cache profile data |
| `identity.user.deleted` | 1 | `{ userId, reason }` | The user was anonymized; `reason` is `deleted-by-admin` or `account-removed` (gone at Keycloak). Remove or anonymize any personal data you copied; keep references to the ID |
