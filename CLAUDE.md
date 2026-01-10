# Mosaic Drive - Claude Context

## Project Overview
Desktop app for S3-compatible cloud storage (MinIO, AWS S3, etc.) built with Tauri v2, React, and TypeScript.

**Live service:** https://mosaic.site
**Repo:** https://github.com/mosaic-site-apps/mosaic-drive

## Tech Stack
- **Frontend:** React 18, TypeScript, Tailwind CSS, Vite
- **Backend:** Rust (Tauri v2), aws-sdk-s3, rusqlite
- **Storage:** S3-compatible (MinIO in production)

## Architecture

### Frontend (`src/`)
- `App.tsx` - Main app with auth state, auto-connect, update checking
- `components/AuthScreen.tsx` - Login screen with hardcoded endpoint (configurable for forks)
- `components/FileBrowser.tsx` - Main file browser with column view, drag/drop, context menus

### Backend (`src-tauri/src/`)
- `lib.rs` - Tauri app setup, plugin registration
- `commands.rs` - All Tauri commands (connect, list_objects, upload, download, etc.)
- `s3_client.rs` - AWS S3 SDK wrapper
- `cache.rs` - SQLite metadata cache for instant folder listings

### Key Features
- **SQLite Cache:** Instant folder listings (~200μs) with background refresh
- **Auto-updater:** Checks GitHub Releases on startup, shows banner when update available
- **Keychain:** Credentials stored in system keychain via `keyring` crate
- **Trash:** Soft delete moves files to `.Trash/` prefix

## Commands

```bash
# Development
npm run tauri dev

# Build (unsigned, for testing)
npm run tauri build

# Build (signed, for release)
TAURI_SIGNING_PRIVATE_KEY=$(cat ~/.tauri/mosaic-drive.key) npm run tauri build
```

## Releasing Updates

### Automated (Recommended)
1. Update version in `src-tauri/tauri.conf.json`
2. Commit and tag:
   ```bash
   git add -A && git commit -m "Release v0.2.0"
   git tag v0.2.0
   git push && git push --tags
   ```
3. GitHub Actions builds and creates a draft release
4. Review and publish the release

### Manual
1. Build with signing key
2. Upload to GitHub Releases: `.dmg`, `.app.tar.gz`, `.app.tar.gz.sig`, `latest.json`

## Signing Keys
- Private key: `~/.tauri/mosaic-drive.key` (NEVER commit)
- Public key: Configured in `tauri.conf.json`
- GitHub secret: `TAURI_SIGNING_PRIVATE_KEY` (base64 encoded key contents)

## Important Files
| File | Purpose |
|------|---------|
| `src-tauri/tauri.conf.json` | App config, version, updater settings |
| `src-tauri/migrations/001_initial.sql` | SQLite cache schema |
| `src/components/AuthScreen.tsx:16` | S3 endpoint (change for forks) |

## Cache System
- TTL: 5 minutes (`CACHE_TTL_SECONDS` in cache.rs)
- DB location: `~/Library/Application Support/com.jody.mosaic-drive/mosaic_cache.db`
- Pattern: Return cached data immediately, refresh in background if stale

## Conventions
- Bucket name = username (accessKey)
- All file operations invalidate parent folder cache
- Trash uses `.Trash/` prefix within bucket
