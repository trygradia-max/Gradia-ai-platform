-- Extra field for messy-data work: vehicle color (owners describe cars by
-- color as much as make/model — "the silver Tesla"). Parsed from car_info on
-- capture (vehicle.ts) and fillable in CRM cleanup.
alter table public.leads
  add column if not exists vehicle_color text;
alter table public.customers
  add column if not exists vehicle_color text;
