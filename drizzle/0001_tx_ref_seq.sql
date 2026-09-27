-- Custom migration: sequence backing human-readable transaction references
-- (format: TX-YYYYMMDD-NNNNNN). A DB sequence guarantees atomic, gap-tolerant
-- uniqueness even under concurrent transactions, with no retry loop needed.
CREATE SEQUENCE IF NOT EXISTS tx_ref_seq START WITH 1 INCREMENT BY 1;
