BEGIN;
-- ASCII email policy: trim ASCII surrounding whitespace; lowercase ASCII.
-- Internationalized addresses require explicit support; do not guess aliases.
CREATE FUNCTION public.canonical_contact_destination(channel text,value text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path='' AS $$
DECLARE v text := btrim(value,E' \t\r\n');
BEGIN
 IF channel='email' THEN
  IF v !~ '^[!-~]+$' THEN RETURN NULL; END IF;
  v=lower(v COLLATE "C");
  IF v ~ '^[^[:space:]@,;]+@[^[:space:]@,;]+\.[^[:space:]@,;]+$' THEN RETURN v; END IF;
 ELSIF channel='sms' AND v ~ '^\+[0-9 ().-]+$' THEN
  v=regexp_replace(v,'[ ().-]','','g');
  IF v ~ '^\+[1-9][0-9]{6,14}$' THEN RETURN v; END IF;
 END IF;
 RETURN NULL;
END $$;
ALTER TABLE public.customer_channel_permissions ADD CONSTRAINT permission_canonical_destination
 CHECK(public.canonical_contact_destination(channel,destination) IS NOT NULL AND destination=public.canonical_contact_destination(channel,destination));
-- Validate existing rows before installing write-time normalization: never backfill.
ALTER TABLE public.customers ADD CONSTRAINT customers_canonical_phone
 CHECK(phone IS NULL OR (public.canonical_contact_destination('sms',phone) IS NOT NULL AND phone=public.canonical_contact_destination('sms',phone)));
ALTER TABLE public.customers ADD CONSTRAINT customers_canonical_email
 CHECK(email IS NULL OR (public.canonical_contact_destination('email',email) IS NOT NULL AND email=public.canonical_contact_destination('email',email)));
CREATE FUNCTION public.normalize_customer_destinations() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE phone_value text; email_value text;
BEGIN
 phone_value=public.canonical_contact_destination('sms',NEW.phone);
 email_value=public.canonical_contact_destination('email',NEW.email);
 IF (NEW.phone IS NOT NULL AND phone_value IS NULL) OR (NEW.email IS NOT NULL AND email_value IS NULL) THEN
  RAISE EXCEPTION 'Invalid or ambiguous customer destination' USING ERRCODE='23514';
 END IF;
 NEW.phone=phone_value;NEW.email=email_value;
 RETURN NEW;
END $$;
CREATE TRIGGER customers_normalize_destinations BEFORE INSERT OR UPDATE OF phone,email ON public.customers FOR EACH ROW EXECUTE FUNCTION public.normalize_customer_destinations();
ALTER TABLE public.customers ADD COLUMN phone_canonical text GENERATED ALWAYS AS (public.canonical_contact_destination('sms',phone)) STORED;
ALTER TABLE public.customers ADD COLUMN email_canonical text GENERATED ALWAYS AS (public.canonical_contact_destination('email',email)) STORED;
CREATE UNIQUE INDEX customers_shop_phone_canonical_unique ON public.customers(shop_id,phone_canonical) WHERE phone_canonical IS NOT NULL;
CREATE UNIQUE INDEX customers_shop_email_canonical_unique ON public.customers(shop_id,email_canonical) WHERE email_canonical IS NOT NULL;
-- Existing noncanonical data causes refusal, never normalization/backfill.
CREATE UNIQUE INDEX vehicles_shop_customer_id_unique ON public.vehicles(shop_id,customer_id,id);
ALTER TABLE public.quotes ADD CONSTRAINT quotes_vehicle_customer_consistency
 FOREIGN KEY(shop_id,customer_id,vehicle_id) REFERENCES public.vehicles(shop_id,customer_id,id)
 ON DELETE SET NULL(vehicle_id) DEFERRABLE INITIALLY DEFERRED;
COMMIT;
