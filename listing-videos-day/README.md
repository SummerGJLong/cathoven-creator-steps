# Viral Video Pool

Live creator page: https://srv2054680.hstgr.cloud/listing-videos-day/

This project keeps the original Cathoven listing-video guide and builder while saving submissions and custom types in one shared server database. GitHub stores the application source. Runtime creator records and credentials stay on the Cathoven server.

## Source layout

- `app/public/`: live guide, builder and shared client.
- `server/`: standard-library Python API and consistent SQLite backup tool.
- `legacy/`: old-origin recovery page for the GitHub Pages localStorage prototype.
- `tests/`: backend, shared-client and migration regressions.
- `index.html` and `bridge.js`: activated GitHub Pages entry and recovery bridge after the server passes verification.

## Data safety

The SQLite file lives on a persistent host directory, outside every static web root. It uses rollback journaling and synchronous FULL. Requests are committed before success is shown. Operation IDs and normalized video links prevent duplicate retries; conflicting submitter details are reported instead of replacing the first record. No API deletes or overwrites an accepted submission.

Do not commit `.env`, private keys, credentials, SQLite files, runtime exports, creator submissions, logs or backups. Never replace the shared application with the old browser-only HTML prototype.

The original GitHub Pages origin has the old browser data. Its recovery page retains those storage keys, offers a backup and explicitly transfers saved submissions to the canonical HTTPS service. A new hostname cannot read another origin's localStorage. Do not remove that recovery page before every relevant browser has migrated.

## Runtime

Use the existing Cathoven Caddy ingress and an independent `listing-videos-day` Compose project. Mount the API source read-only, persist its database directory, and publish no backend host port. Caddy injects a separate private service key. The API permits writes only from the canonical origin and the original GitHub Pages origin with the custom request header. Public creator access is retained; the shared list is an append-only public submission board. Shared video types and recovery imports containing types require the separate administrator login at `/listing-videos-day/admin/`. The creator page has no text editor. Strip all visitor administrator headers on public API routes; inject the trusted role only after protected administrator login.

For updates, preserve the database and secrets, publish the complete tested source, deploy the same commit, then verify submission visibility from separate clients and persistence after service recreation. Test the old-origin CORS/recovery path. Keep all existing Monitor, WhatsApp, Creator CRM and tool routes.

## Tests

Run the Python backend tests and the Node shared-client/recovery tests before publishing. They require no added packages. Test with a disposable database; do not put synthetic submissions into the live creator board.

## Backup and recovery

Use the included consistent SQLite backup tool and verify integrity before restoring. Nightly server recovery snapshots are kept outside the web root. An off-server recovery bundle belongs in Summer's designated Drive Backups folder. A Drive snapshot is not a continuous replica unless an explicit update process has been configured.

Old submissions cannot be reconstructed from the repository: each original browser must open the old-origin recovery entry to transfer its saved records. The old keys are retained after successful transfer.

## Administrator access

The protected administrator entry is `https://srv2054680.hstgr.cloud/listing-videos-day/admin/`. Its separate login stays in restricted server storage and is never part of GitHub source. Creators may submit links and use existing formats; only an authenticated administrator can publish shared formats or import a recovery copy containing formats. An original browser copy is retained if an import requires administrator approval. Text and layout updates are published from the source repository/Muse design through the authorized deployment process.
