# backend/sql

Numbered SQL files here are run by hand in the Supabase SQL editor — there's
no migration runner.

**After you run `NNN_*.sql` in Supabase, also run:**

```sql
insert into public.schema_migrations (id) values ('NNN_*.sql') on conflict do nothing;
```

That's the whole habit. It keeps `public.schema_migrations` an honest record
of what's actually live, so `npm run check-migrations` (backend/scripts/check-migrations.js)
can catch drift before a deploy instead of after.
