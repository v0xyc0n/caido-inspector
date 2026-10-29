# Changelog

## 1.2.0

### Improvements

- Requests saved with earlier versions are not carried over
- "Clear All" asks for confirmation first
- The README is now shown on the plugin page in the Caido store

### Bugfixes

- **Major fix:** the request/response view no longer gets stuck on one request after switching pages – Inspector is finally fully usable
- Saved requests are no longer lost when Caido is open in several windows or browser tabs
- Deleting a collection no longer reports success when it failed

## 1.1.0

### Features

- Collections: group saved requests and move them by drag and drop or via the row menu
- Row menu and editor context menu: Show in HTTP History, Send to Replay, Add to Findings, copy URL or raw request/response
- Shortcut Cmd/Ctrl+Shift+I saves the selected requests in HTTP History or Sitemap

### Improvements

- Saved requests are kept per project
- Double-click a saved request to jump to it in HTTP History

### Bugfixes

- Caido no longer freezes when switching projects

## 1.0.0

### Features

- Save requests via right-click → "Send to Inspector" and review them on the Inspector page
