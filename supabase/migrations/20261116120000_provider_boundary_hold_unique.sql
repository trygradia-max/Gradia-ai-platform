BEGIN;
-- Provider boundary V1 follow-up (PR #148 review): the content-free hold marker must be
-- exactly-once per (shop, channel, stage, provider message reference) under concurrency.
--
-- recordBoundaryHold used to SELECT for an existing marker and then INSERT. Aurinko email has
-- no durable provider-event replay claim, so two simultaneous deliveries of the same message
-- could both see no row and both insert. The marker is one `interactions` row (role 'system',
-- metadata.source = 'provider_boundary', metadata.kind = 'hold') keyed by
-- metadata.boundary_hold_key = '<stage>:<provider message id>'. This adds the durable
-- boundary the check-then-insert lacked: a PARTIAL UNIQUE INDEX over exactly those rows, so
-- the second concurrent writer fails with 23505 and the application treats that as
-- "already recorded".
--
-- Scope, deliberately narrow:
--   * Only marker rows are constrained. Customer-role evidence, Gradia replies and every other
--     system note are outside the predicate and unaffected, even if they carry the same text.
--   * Tenant-safe: shop_id leads the key, so one shop can never collide with, pre-claim or
--     observe another shop's marker. channel is in the key (same ref on sms vs email is two
--     markers); stage is inside boundary_hold_key.
--   * No new table, column, grant, policy or function. RLS (interactions_tenant_isolation),
--     the ON DELETE CASCADE from shops/customers, and service-role writers are unchanged.
--   * Existing duplicates: markers shipped only on this unmerged branch, so none are expected
--     outside review databases. If any exist, the oldest row per key is kept and the later
--     content-free duplicates are removed so the index can be built. Raw customer evidence is
--     never selected by the DELETE (role = 'system' + provider_boundary + hold only).
--
-- Not covered here: an Aurinko provider-event replay claim. That is a separate lifecycle.

DELETE FROM public.interactions i
 USING (
   SELECT id,
          row_number() OVER (
            PARTITION BY shop_id, channel, (metadata->>'boundary_hold_key')
            ORDER BY created_at, id
          ) AS rn
     FROM public.interactions
    WHERE role = 'system'
      AND metadata->>'source' = 'provider_boundary'
      AND metadata->>'kind' = 'hold'
      AND metadata->>'boundary_hold_key' IS NOT NULL
 ) d
 WHERE i.id = d.id AND d.rn > 1;

CREATE UNIQUE INDEX interactions_provider_boundary_hold_unique
  ON public.interactions (shop_id, channel, (metadata->>'boundary_hold_key'))
  WHERE role = 'system'
    AND metadata->>'source' = 'provider_boundary'
    AND metadata->>'kind' = 'hold'
    AND metadata->>'boundary_hold_key' IS NOT NULL;
COMMIT;
