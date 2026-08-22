# NEON INVADERS on Android and iOS

The mobile apps are [Capacitor](https://capacitorjs.com) shells around the
**exact same** `index.html` + `css/` + `js/` that run in a desktop browser.
There is no second implementation of the game: no Kotlin, no Swift, no React
Native, no Flutter. `scripts/copy-web.js` copies the web files into `www/`
verbatim and Capacitor packages that directory as the app's WebView content.

---

## What was actually done in this repo

- `capacitor.config.json` (appId `com.neoninvaders.app`, `webDir: www`)
- `npx cap add android` -> a complete Gradle project in `android/`
- `npx cap add ios` -> a complete Xcode project in `ios/`
- `npx cap sync` -> web assets copied into both platform trees
- `scripts/make-icons.js` -> placeholder launcher icons + splash screens for
  both platforms, generated with zero dependencies (hand-rolled PNG encoder
  over `node:zlib`)

## What was **NOT** done -- read this before believing the app works

This repository was built in a Linux container with **no Android SDK, no
Xcode, no CocoaPods, no emulator, no device and no signing identity.**
Therefore:

| Not done | Why |
| --- | --- |
| **No APK or AAB was ever compiled** | No Android SDK / `ANDROID_HOME`; Gradle was never invoked. |
| **No IPA was ever compiled** | Xcode and `xcodebuild` are macOS-only. |
| **`pod install` never ran** | CocoaPods is not installed; `cap add ios` and `cap sync` both printed `Skipping pod install because CocoaPods is not installed`. `ios/App/Pods/` does not exist and `App.xcworkspace` is not usable until you run it. |
| **`xcodebuild clean` never ran** | Same reason; `cap sync` printed `Unable to find "xcodebuild"`. |
| **The app was never launched** on a device, emulator or simulator | None available. |
| **Nothing was code-signed** | No keystore, no Apple Developer account, no provisioning profile. |
| **The icons are placeholders** | Procedural invader glyph on the game palette. Correctly sized and valid PNGs, but not store-quality art. |

Everything above is verified only as *scaffolding that exists and contains the
right files*, by file/directory existence and byte-comparison against `www/` --
**not** by compilation. Treat "the Android app works" as unproven until
someone runs step 1 below on a real machine.

---

## Remaining manual steps

### Android

1. Install Android Studio (or the command-line SDK) and set `ANDROID_HOME`.
2. `npm install && npm run cap:sync`
3. `npx cap open android`, or headless: `cd android && ./gradlew assembleDebug`
4. Verify the game renders, touch controls work, and audio unlocks on first tap.
5. For release: create a keystore, configure `signingConfigs` in
   `android/app/build.gradle`, then `./gradlew bundleRelease`.

### iOS

1. On macOS with Xcode installed: `sudo gem install cocoapods`
2. `npm install && npm run cap:sync` (this time `pod install` will actually run)
3. `npx cap open ios` -> opens `ios/App/App.xcworkspace`
4. Set a Team / bundle identifier under Signing & Capabilities.
5. Build to a simulator first, then a device.

### Both

- Replace the placeholder icons with real art (`scripts/make-icons.js` writes
  to the standard paths; or use `@capacitor/assets`).
- Re-run `npm run cap:sync` after **every** change to `index.html`, `css/` or
  `js/` -- editing `www/` directly is pointless, it is regenerated and
  gitignored.

---

## Talking to the backend from a device

`js/net.js` defaults its server field to `http://localhost:3000`, which on a
phone means *the phone itself*. You must point it at your machine:

| Target | Server URL to type into the panel |
| --- | --- |
| Android emulator | `http://10.0.2.2:3000` |
| iOS simulator | `http://localhost:3000` (shares the host loopback) |
| Real device | `http://<your-LAN-IP>:3000` |

### The cleartext gotcha

`capacitor.config.json` sets `androidScheme: "https"` (the Capacitor default),
so the Android WebView origin is `https://localhost`. A **plain `http://`
backend is mixed content and will be blocked.** For local development pick one:

- point the app at an HTTPS backend (correct answer for production), **or**
- temporarily set `"androidScheme": "http"` in `capacitor.config.json` and
  re-run `npx cap sync` (dev only -- do not ship this), **or**
- add an Android `network_security_config.xml` permitting cleartext to your
  dev host only.

On iOS, a cleartext `http://` backend additionally needs an ATS exception in
`ios/App/App/Info.plist`. Neither workaround is applied in this repo; both are
deliberately left to whoever sets up a real environment.

> **Deferred (Gauntlet review, MOB-01).** This is why `js/net.js`'s default
> server URL cannot work out of the box inside either mobile shell. It is
> recorded as a known limitation rather than fixed — the bridge is opt-in and
> the player types the real server URL into the panel anyway. See the
> "Known limitations" table in [`server/README.md`](../server/README.md#known-limitations-gauntlet-review-not-fixed-this-round)
> for the full deferred list.

The server's CORS allowlist already covers `capacitor://localhost`,
`https://localhost`, `http://localhost`, and `null` (`file://`), so no CORS
change is needed.

---

## Layout

```
capacitor.config.json         appId, appName, webDir
scripts/copy-web.js           index.html + css/ + js/  ->  www/   (verbatim)
scripts/make-icons.js         dependency-free placeholder PNG generator
www/                          GENERATED, gitignored -- never edit
android/                      committed Gradle project
ios/                          committed Xcode project
```

`android/app/src/main/assets/public/` and `ios/App/App/public/` are the copies
Capacitor makes of `www/`; both are gitignored by Capacitor's own
`.gitignore` files and are regenerated by `npx cap sync`.
