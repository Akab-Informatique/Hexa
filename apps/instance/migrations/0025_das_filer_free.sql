-- "Qui déclare" is no longer a fixed list: besides the built-in keys (us, them, them_ccq_us) a custom label can be typed
-- ("Autre") and then shows up as an option for every client.
alter table client_tracking drop constraint if exists client_tracking_das_filer_check;
