# aeros-archive-audit

Permanent historical archive for Aeros Pay Government administrative audit trail logs.

## Architecture & Safety Rules

- **Managed by**: Aeros Pay V4.1 Automated 24-Hour Archival Engine
- **Mapped Datasets**: `historical_audit_logs`
- **Directory Layout**:
  - `schema/archive-schema-v4.1.json`: JSON schema for batch manifests
  - `index/catalog.json`: Root repository metadata
  - `index/<datasetKey>/<YYYY-MM>.json`: Monthly batch lookup index
  - `batches/<datasetKey>/<YYYY>/<MM>/<DD>/<batchNumber>.jsonl`: Deterministic newline-delimited JSON records
  - `manifests/<datasetKey>/<YYYY>/<MM>/<batchNumber>.manifest.json`: Cryptographic SHA-256 manifest & accounting snapshot
- **Security**: Never store passwords, session tokens, or API keys in this repository. All records are sanitized by `sanitizeRecordForArchive()` prior to upload.
- **Shard Rotation**: Soft warning at 400 MB; automatic shard rotation to `aeros-archive-audit-002` at 750 MB.
