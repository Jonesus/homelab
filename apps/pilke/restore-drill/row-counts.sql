-- Exact row counts for every table in `public`, one line per table, sorted so two
-- runs diff cleanly. Run on production and on the restored copy, then `diff`.
--
-- Exact, not `pg_stat_user_tables.n_live_tup`: that is an estimate, and on a
-- freshly restored database it is zero until autovacuum has analysed everything.
select table_name || ' ' ||
       (xpath('/row/c/text()',
              query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name),
                           false, true, '')))[1]::text
from information_schema.tables
where table_schema = 'public'
  and table_type = 'BASE TABLE'
order by table_name;

-- The schema's own fingerprint: the last migration applied. Equal on both sides
-- means the restored copy is at the same release as production.
select 'django_migrations.max_id ' || max(id) from django_migrations;
select 'postgis ' || postgis_lib_version();
