-- Persistence for the /chat surface. One thread = one bi_conversation;
-- each turn = one bi_message. RLS scoped per shop, identical to every
-- other tenant-isolated table.
--
-- Conversations are created lazily on the first user message — empty
-- rows don't accumulate. Title is derived from the first user message
-- by the application (truncated); leaving it NULL is fine.
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.bi_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  title text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bi_conversations_shop_id_updated_idx
  ON public.bi_conversations (shop_id, updated_at DESC);

DO $$ BEGIN
  CREATE TYPE public.bi_message_role AS ENUM ('user', 'assistant');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.bi_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.bi_conversations (id) ON DELETE CASCADE,
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  role public.bi_message_role NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bi_messages_conversation_id_idx
  ON public.bi_messages (conversation_id, created_at);

CREATE INDEX IF NOT EXISTS bi_messages_shop_id_idx
  ON public.bi_messages (shop_id);

ALTER TABLE public.bi_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bi_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bi_conversations_tenant_isolation ON public.bi_conversations;
CREATE POLICY bi_conversations_tenant_isolation ON public.bi_conversations
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS bi_messages_tenant_isolation ON public.bi_messages;
CREATE POLICY bi_messages_tenant_isolation ON public.bi_messages
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );
