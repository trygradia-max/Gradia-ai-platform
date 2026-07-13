-- C4 job photos (GRADIA_CRM_FOUNDATION_SPEC §C4): before/after walk-around
-- shots on jobs. PRIVATE bucket, same posture as recovery-imports — paths
-- live in appointments.photos_before/photos_after (C1 columns); the app
-- reads via short-lived signed URLs under the service role.
--
-- Applied by the founder. Code tolerates this being unapplied: uploads
-- surface a clear error, everything else is unaffected.

INSERT INTO storage.buckets (id, name, public)
VALUES ('job-photos', 'job-photos', false)
ON CONFLICT (id) DO NOTHING;
