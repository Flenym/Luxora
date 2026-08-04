# Luxora backup/restore drill evidence

**Release:** Beta-0.1  
**Owner and developer:** Flenym  
**Scope:** local/offline single-node SQLite + local blobs/uploads preview only

## Record

| Field | Value |
| --- | --- |
| Drill ID | `<unique identifier>` |
| UTC start / finish | `<timestamps>` |
| Operator / reviewer | `<names>` |
| Commit and image digest | `<immutable identifiers>` |
| Host/toolchain | `<OS, sqlite3 version, script digest>` |
| Sanitized dataset profile | `<counts and sizes; no user content>` |
| Backup directory / storage class | `<access-controlled target; no credentials>` |
| Backup duration / bytes | `<measured>` |
| Restore duration | `<measured>` |
| `SHA256SUMS` digest | `<sha256 from RESTORE_VERIFICATION.txt>` |
| Applied migrations | `<attach metadata/migrations.tsv>` |
| Manifest verification | `PASS / FAIL` |
| `PRAGMA integrity_check` | `PASS / FAIL` |
| `PRAGMA foreign_key_check` | `PASS / FAIL` |
| Blob/upload reconciliation | `PASS / FAIL` |
| Synthetic API journey | `<auth, chat, message, receipt, replay result>` |
| Permission review | `<0600 files / 0700 directories result>` |
| Exceptions / residual risk | `<issues, owner, expiry>` |
| Final decision | `<preview recovery accepted/rejected>` |

## Attachments

- Redacted command transcript.
- `SHA256SUMS`, `metadata/backup.env`, and `metadata/migrations.tsv`.
- Restore `RESTORE_VERIFICATION.txt`.
- Synthetic journey output and any failure logs.
- Follow-up issue links with owner and due date.

## Mandatory truth statement

This drill is evidence only for the stopped, single-node local preview. It does
not establish an online backup, encrypted backup, retention/deletion lifecycle,
signed provenance, off-host durability, production object-store recovery,
point-in-time recovery, high availability, or measured production RPO/RTO.
Those remain blocking gates.
