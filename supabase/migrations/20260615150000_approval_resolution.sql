-- L6 (GRADIA_AGENT_MERGE_BRIEF P4): earned-autonomy telemetry. Record HOW each
-- pending_action was resolved so we can compute the approval-without-edit rate
-- per action type and recommend graduating trusted actions to autonomous.
--   approved_unedited · approved_edited · rejected · auto
alter table public.pending_actions
  add column if not exists resolution text;

create index if not exists pending_actions_resolution_idx
  on public.pending_actions (shop_id, action_type, resolution);
