# Trademarks and brand assets

The source code of Taylis is licensed under the [Apache License 2.0](LICENSE). The Apache License does **not** grant
any rights to the project's name or logo (see its section 6, "Trademarks").

## What is not covered by the Apache License

- The name **"Taylis"** as the name of a product, app or service.
- The **squirrel icon / logo** and every image derived from it: the app icons, favicons, launcher and notification
  icons and the DMG background. The files are listed in [NOTICE](NOTICE) (for example `apps/shared/brand/`,
  `apps/desktop/public/`, `apps/desktop/src-tauri/icons/`, the iOS `AppIcon.appiconset` and the Android
  `ic_launcher_*` / `ic_notification` resources).

These remain © Toru Kano, all rights reserved.

## What you may do

- Use, study, modify and self-host the code under the Apache License.
- Redistribute the **unmodified** official apps and builds (for example the official releases) under their
  original name and icon.
- Refer to the project by name to describe your own work truthfully, e.g. "based on Taylis" or "compatible with
  Taylis servers".

## What forks must do

If you distribute a modified version (a fork, a rebuilt app, a hosted service built from changed code):

- Give it **another name** and **another icon**, and do not present it as the official Taylis or imply
  endorsement.
- Replace the brand assets listed in [NOTICE](NOTICE). `apps/shared/brand/gen_icons.sh` regenerates every platform
  icon from a single `appicon.png`, so swapping that one file and re-running the script is enough.
- Change the app identifiers so your build cannot be mistaken for, or update over, the official apps
  (bundle IDs, the Android `applicationId`, the Tauri `identifier`, the updater endpoint): see
  [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md), "フォークでのビルド (Forks)".

Questions about the name or logo: kanotown@gmail.com.
