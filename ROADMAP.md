# Mosaic Drive Roadmap

## v0.1.0 (Current) - Released
- [x] Persistent login (stays logged in)
- [x] List view & Column view toggle
- [x] Simplified app menu (About, Hide, Quit)
- [x] Drag & drop uploads with visual feedback
- [x] Concurrent uploads (3 max)
- [x] Upload queue with pause/resume/skip
- [x] Auto-increment duplicate filenames
- [x] Trash system (move to trash, empty trash)
- [x] Hidden .keep files
- [x] Custom Mosaic icon
- [x] Apple Silicon build (aarch64)
- [x] Single file download with save dialog (choose location)
- [x] Folder download as ZIP with save dialog
- [x] Right-click context menu (Download, Trash, New Folder)

## v0.2.0 (Next)
- [x] Multi-select files (Shift+Click for range, Cmd+Click for toggle)
- [x] Bulk delete selected files
- [x] Bulk download selected files (with folder picker)
- [x] Search functionality (filter/find files)
- [ ] Re-enable auto-updater
- [ ] Set up update manifest on S3

## v0.3.0
- [ ] Universal binary (Intel + Apple Silicon)
- [ ] File preview in column view:
  - Images (native img tag with blob URL)
  - PDFs (react-pdf or @react-pdf-viewer/core)
  - Videos/Audio (native HTML5)
  - Documents (react-doc-viewer for docx, xlsx, etc.)
- [ ] File/folder renaming
- [ ] Context menu (right-click) actions

## v0.5.0 - AI Assistant
- [ ] "Chat" button in sidebar (above Trash) with AI sparkle icon
- [ ] Chat interface replaces file area when clicked
- [ ] LLM-powered file search ("find my tax documents from 2024")
- [ ] Natural language queries to locate files
- [ ] "Coming Soon" placeholder until ready

## Future / Nice to Have
- [ ] Drag-out to Finder (download on drag)
- [ ] File tagging
- [ ] Favorites/bookmarks
- [ ] Recent files view

## Technical Notes

### Signing Key Location
- Private: `~/.tauri/mosaic-drive.key` (KEEP SECRET)
- Public: `~/.tauri/mosaic-drive.key.pub`

### Update Endpoint (for v0.2.0)
- URL: `https://s3.mosaic.site/mosaic-drive-releases/update.json`
- Updater code is commented out in:
  - `src-tauri/src/lib.rs`
  - `src/App.tsx`
  - `src-tauri/tauri.conf.json` (config removed)

### Build Commands
```bash
# Development
npm run tauri dev

# Production build (Apple Silicon)
npm run tauri build

# Universal build (Intel + Apple Silicon)
rustup target add x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

### Server
- SSH: `ssh -p2250 jody@mosaic.site`
- S3 Endpoint: `https://s3.mosaic.site`
