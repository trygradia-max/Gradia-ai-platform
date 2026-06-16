-- L3 (GRADIA_AGENT_MERGE_BRIEF §B1): structured segment fields so the Gradia
-- Agent can target by VEHICLE and LAST VISIT, not just a fuzzy car_info keyword.
-- Adds make/model/year to leads + customers and last_visit_at to customers,
-- then best-effort backfills from existing data so segments work on day one.

alter table public.leads
  add column if not exists vehicle_make text,
  add column if not exists vehicle_model text,
  add column if not exists vehicle_year int;

alter table public.customers
  add column if not exists vehicle_make text,
  add column if not exists vehicle_model text,
  add column if not exists vehicle_year int,
  add column if not exists last_visit_at timestamptz;

-- Shop-scoped segment filter indexes.
create index if not exists leads_shop_vehicle_make_idx
  on public.leads (shop_id, vehicle_make);
create index if not exists customers_shop_vehicle_make_idx
  on public.customers (shop_id, vehicle_make);
create index if not exists customers_shop_last_visit_idx
  on public.customers (shop_id, last_visit_at);

-- Backfill YEAR from car_info (first 19xx/20xx run).
update public.leads
set vehicle_year = (substring(car_info from '((?:19|20)[0-9]{2})'))::int
where vehicle_year is null
  and car_info ~ '(19|20)[0-9]{2}';

-- Backfill MAKE from car_info against a curated list. Word-boundary regex
-- (~*  with \y) so "ram" doesn't match "ceramic", etc.
update public.leads l
set vehicle_make = m.make
from (values
  ('tesla','Tesla'), ('toyota','Toyota'), ('honda','Honda'), ('ford','Ford'),
  ('chevrolet','Chevrolet'), ('chevy','Chevrolet'), ('bmw','BMW'),
  ('mercedes','Mercedes-Benz'), ('benz','Mercedes-Benz'), ('audi','Audi'),
  ('lexus','Lexus'), ('nissan','Nissan'), ('jeep','Jeep'), ('dodge','Dodge'),
  ('ram','Ram'), ('gmc','GMC'), ('subaru','Subaru'), ('hyundai','Hyundai'),
  ('kia','Kia'), ('porsche','Porsche'), ('mazda','Mazda'),
  ('volkswagen','Volkswagen'), ('vw','Volkswagen'), ('cadillac','Cadillac'),
  ('acura','Acura'), ('infiniti','Infiniti'), ('volvo','Volvo'),
  ('land rover','Land Rover'), ('range rover','Land Rover'),
  ('jaguar','Jaguar'), ('chrysler','Chrysler'), ('buick','Buick'),
  ('lincoln','Lincoln'), ('genesis','Genesis'), ('mini','Mini'),
  ('rivian','Rivian'), ('lucid','Lucid'), ('ferrari','Ferrari'),
  ('lamborghini','Lamborghini'), ('maserati','Maserati'), ('bentley','Bentley')
) as m(pat, make)
where l.vehicle_make is null
  and l.car_info ~* ('\y' || m.pat || '\y');

-- Carry vehicle from each customer's most recent linked lead to the customer
-- record (the box segments "my clients" on customers).
update public.customers c
set vehicle_make = l.vehicle_make,
    vehicle_model = l.vehicle_model,
    vehicle_year = l.vehicle_year
from (
  select distinct on (customer_id)
    customer_id, vehicle_make, vehicle_model, vehicle_year
  from public.leads
  where customer_id is not null
  order by customer_id, created_at desc
) l
where c.id = l.customer_id
  and c.vehicle_make is null
  and l.vehicle_make is not null;

-- Backfill last_visit_at from the most recent past appointment.
update public.customers c
set last_visit_at = a.last_at
from (
  select customer_id, max(scheduled_at) as last_at
  from public.appointments
  where customer_id is not null and scheduled_at <= now()
  group by customer_id
) a
where c.id = a.customer_id
  and c.last_visit_at is null;
