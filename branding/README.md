# Branding

`app-icon.svg` is the source for every app icon. To regenerate after editing it:

1. Render it to a 1024x1024 PNG with a transparent background.
2. `npm run tauri icon <that png> -- -o src-tauri/icons`, then delete the generated `android/`, `ios/` and `64x64.png` (unused).
3. Copy `src-tauri/icons/icon.ico` to `public/favicon.ico` and `app-icon.svg` to `public/logo.svg` (the in-app logo).
