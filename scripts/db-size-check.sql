-- ===========================================================================
-- AEROS PAY — DATABASE SIZE CHECK
-- ===========================================================================
--
-- WHAT THIS IS FOR
--   Paste this whole file into the Neon SQL Editor (or run it with psql) and
--   press run. It reports, in one go: how big the database is, which tables
--   and indexes are using that space, how many rows each table holds, and how
--   much of what is stored is temporary data that cleans itself up.
--
-- IT IS COMPLETELY READ-ONLY.
--   There is no INSERT, UPDATE, DELETE, CREATE or DROP anywhere in this file.
--   Running it changes nothing and cannot lose data. Run it as often as you
--   like.
--
-- WHY IT IS SAFE ON NEON
--   It uses only the standard Postgres administration functions
--   (pg_database_size, pg_total_relation_size, pg_relation_size,
--   pg_indexes_size) and the ordinary catalogs. It needs no extension and no
--   superuser, which is what a Neon project role is not.
--
-- HOW TO READ IT
--   Section 1 is the single number that matters for the free-tier limit.
--   Section 2 tells you WHAT is using it — start at the top row.
--   Section 3 splits data from index, because a table that is mostly index is
--     fixed by dropping an index, not by deleting rows.
--   Section 4 is exact row counts (slower than section 2's estimates, but
--     exact), so you can see growth rather than guess it.
--   Section 5 is the temporary data: how much of the above will go away on its
--     own, and what will not.
--
-- If section 1 is a small number of megabytes, nothing here needs action.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. TOTAL DATABASE SIZE
-- ---------------------------------------------------------------------------
SELECT
  current_database()                                        AS database,
  pg_size_pretty(pg_database_size(current_database()))      AS total_size,
  pg_database_size(current_database())                      AS total_bytes;


-- ---------------------------------------------------------------------------
-- 2. EVERY TABLE, LARGEST FIRST
--
--    total_size = data + indexes + TOAST (out-of-line long text).
--    estimated_rows is the planner's estimate, which is instant; section 4
--    has the exact counts if you need them.
-- ---------------------------------------------------------------------------
SELECT
  c.relname                                                  AS table_name,
  pg_size_pretty(pg_total_relation_size(c.oid))              AS total_size,
  pg_size_pretty(pg_relation_size(c.oid))                    AS data_size,
  pg_size_pretty(pg_indexes_size(c.oid))                     AS index_size,
  coalesce(s.n_live_tup, 0)                                  AS estimated_rows,
  pg_total_relation_size(c.oid)                              AS total_bytes
FROM pg_class c
JOIN pg_namespace n           ON n.oid = c.relnamespace
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE c.relkind = 'r'
  AND n.nspname = 'public'
ORDER BY pg_total_relation_size(c.oid) DESC;


-- ---------------------------------------------------------------------------
-- 3. EVERY INDEX, LARGEST FIRST
--
--    Indexes are how this app keeps its pages fast, so a large index is not
--    automatically a problem. It is worth looking at when one index is a large
--    share of the database on its own.
-- ---------------------------------------------------------------------------
SELECT
  t.relname                                   AS table_name,
  i.relname                                   AS index_name,
  pg_size_pretty(pg_relation_size(i.oid))     AS index_size,
  pg_relation_size(i.oid)                     AS index_bytes,
  x.indisunique                               AS is_unique
FROM pg_class i
JOIN pg_index x     ON x.indexrelid = i.oid
JOIN pg_class t     ON t.oid = x.indrelid
JOIN pg_namespace n ON n.oid = i.relnamespace
WHERE i.relkind = 'i'
  AND n.nspname = 'public'
ORDER BY pg_relation_size(i.oid) DESC;


-- ---------------------------------------------------------------------------
-- 4. EXACT ROW COUNTS
--
--    One count per table. Slower than section 2 because it really counts, but
--    it is the number to write down if you are tracking growth week to week.
-- ---------------------------------------------------------------------------
SELECT 'users'                             AS table_name, count(*) AS exact_rows FROM users
UNION ALL SELECT 'companies',                        count(*) FROM companies
UNION ALL SELECT 'transactions',                     count(*) FROM transactions
UNION ALL SELECT 'invoices',                         count(*) FROM invoices
UNION ALL SELECT 'notifications',                    count(*) FROM notifications
UNION ALL SELECT 'audit_logs',                       count(*) FROM audit_logs
UNION ALL SELECT 'updates',                          count(*) FROM updates
UNION ALL SELECT 'support_threads',                  count(*) FROM support_threads
UNION ALL SELECT 'support_messages',                 count(*) FROM support_messages
UNION ALL SELECT 'registration_codes',               count(*) FROM registration_codes
UNION ALL SELECT 'ip_complaints',                    count(*) FROM ip_complaints
UNION ALL SELECT 'issuance_requests',                count(*) FROM issuance_requests
UNION ALL SELECT 'issuance_votes',                   count(*) FROM issuance_votes
UNION ALL SELECT 'issuance_eligible_voters',         count(*) FROM issuance_eligible_voters
UNION ALL SELECT 'company_sale_listings',            count(*) FROM company_sale_listings
UNION ALL SELECT 'company_sale_offers',              count(*) FROM company_sale_offers
UNION ALL SELECT 'company_sale_records',             count(*) FROM company_sale_records
UNION ALL SELECT 'company_sale_dismissals',          count(*) FROM company_sale_dismissals
UNION ALL SELECT 'loans',                            count(*) FROM loans
UNION ALL SELECT 'loan_instalments',                 count(*) FROM loan_instalments
UNION ALL SELECT 'loan_payments',                    count(*) FROM loan_payments
UNION ALL SELECT 'loan_actions',                     count(*) FROM loan_actions
UNION ALL SELECT 'tax_matrix',                       count(*) FROM tax_matrix
UNION ALL SELECT 'idempotency_keys',                 count(*) FROM idempotency_keys
UNION ALL SELECT 'marketplace_offers',               count(*) FROM marketplace_offers
UNION ALL SELECT 'marketplace_orders',               count(*) FROM marketplace_orders
UNION ALL SELECT 'marketplace_order_ratings',        count(*) FROM marketplace_order_ratings
UNION ALL SELECT 'marketplace_wanted_requests',      count(*) FROM marketplace_wanted_requests
UNION ALL SELECT 'marketplace_wanted_responses',     count(*) FROM marketplace_wanted_responses
UNION ALL SELECT 'marketplace_contracts',            count(*) FROM marketplace_contracts
UNION ALL SELECT 'marketplace_contract_applications',count(*) FROM marketplace_contract_applications
UNION ALL SELECT 'promotion_campaigns',              count(*) FROM promotion_campaigns
UNION ALL SELECT 'reconciliation_status',            count(*) FROM reconciliation_status
UNION ALL SELECT 'retention_settings',               count(*) FROM retention_settings
UNION ALL SELECT 'government',                       count(*) FROM government
ORDER BY exact_rows DESC;


-- ---------------------------------------------------------------------------
-- 5. TEMPORARY vs PERMANENT
--
--    "cleans_itself" rows are removed (or blanked) by the nightly cleanup, so
--    they are a high-water mark, not permanent growth. "permanent" rows are
--    the ledger and the records that reference it: the app never deletes them,
--    by design, and they are what determines long-term size.
-- ---------------------------------------------------------------------------
SELECT 'notifications'                        AS what, count(*) AS rows, 'cleans itself'  AS lifetime FROM notifications
UNION ALL SELECT 'support messages',                 count(*), 'cleans itself'  FROM support_messages
UNION ALL SELECT 'government updates',               count(*), 'cleans itself'  FROM updates
UNION ALL SELECT 'idempotency keys',                 count(*), 'cleans itself (24h)' FROM idempotency_keys
UNION ALL SELECT 'expired/cancelled orders',         count(*), 'cleans itself'
  FROM marketplace_orders WHERE status IN ('EXPIRED','CANCELLED')
UNION ALL SELECT 'expired/cancelled wanted requests',count(*), 'cleans itself'
  FROM marketplace_wanted_requests WHERE status IN ('EXPIRED','CANCELLED')
UNION ALL SELECT 'applications on closed contracts', count(*), 'cleans itself'
  FROM marketplace_contract_applications a
  JOIN marketplace_contracts c ON c.id = a.contract_id
  WHERE c.status IN ('EXPIRED','CANCELLED')
UNION ALL SELECT 'never-charged dead promotions',    count(*), 'cleans itself'
  FROM promotion_campaigns WHERE status IN ('REJECTED','CANCELLED') AND total_charged = 0
UNION ALL SELECT 'rating comments still stored',     count(*), 'comment cleans itself, star is permanent'
  FROM marketplace_order_ratings WHERE comment IS NOT NULL
UNION ALL SELECT 'paused listings',                  count(*), 'status closed out; row is permanent'
  FROM marketplace_offers WHERE status = 'PAUSED'
UNION ALL SELECT 'transactions (the ledger)',        count(*), 'PERMANENT'      FROM transactions
UNION ALL SELECT 'invoices',                         count(*), 'PERMANENT'      FROM invoices
UNION ALL SELECT 'paid/completed orders',            count(*), 'PERMANENT'
  FROM marketplace_orders WHERE status IN ('PAID','COMPLETED')
UNION ALL SELECT 'contracts',                        count(*), 'PERMANENT'      FROM marketplace_contracts
UNION ALL SELECT 'loans + instalments + payments',
  (SELECT count(*) FROM loans) + (SELECT count(*) FROM loan_instalments) + (SELECT count(*) FROM loan_payments),
  'PERMANENT'
UNION ALL SELECT 'audit log',                        count(*), 'PERMANENT until archived by hand' FROM audit_logs
UNION ALL SELECT 'users',                            count(*), 'PERMANENT'      FROM users
UNION ALL SELECT 'companies',                        count(*), 'PERMANENT'      FROM companies
ORDER BY rows DESC;


-- ---------------------------------------------------------------------------
-- 6. DEAD ROWS AWAITING VACUUM
--
--    Postgres does not release space the instant a row is deleted; autovacuum
--    reclaims it shortly afterwards. A big n_dead_tup right after a cleanup is
--    normal and resolves itself. It only matters if it stays big for days.
-- ---------------------------------------------------------------------------
SELECT
  relname                          AS table_name,
  n_live_tup                       AS live_rows,
  n_dead_tup                       AS dead_rows,
  last_autovacuum,
  last_autoanalyze
FROM pg_stat_user_tables
WHERE n_dead_tup > 0
ORDER BY n_dead_tup DESC;
