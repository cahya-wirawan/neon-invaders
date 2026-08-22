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

This repository was originally built in a Linux container with no Android
SDK, no Xcode, no CocoaPods, no emulator, no device and no signing identity.
**That has since changed for Android**: a real JDK and the Android
command-line SDK were installed into this same environment, and
`./gradlew assembleDebug` (plus `assembleRelease`) actually ran and produced
real `.apk` files -- see "Android: actually compiled" below. iOS is
unchanged, since Xcode is macOS-only and cannot exist in this container.

| Not done | Why |
| --- | --- |
| ~~No APK or AAB was ever compiled~~ **Compiled -- see below** | Android SDK + JDK were installed into this environment and Gradle ran for real. |
| **No IPA was ever compiled** | Xcode and `xcodebuild` are macOS-only; still cannot exist in this container. |
| **`pod install` never ran** | CocoaPods is not installed; `cap add ios` and `cap sync` both printed `Skipping pod install because CocoaPods is not installed`. `ios/App/Pods/` does not exist and `App.xcworkspace` is not usable until you run it. |
| **`xcodebuild clean` never ran** | Same reason; `cap sync` printed `Unable to find "xcodebuild"`. |
| **The app was never launched** on a device, emulator or simulator | `adb` and an emulator/device are still not available in this environment. The APK's *bytes* are verified (see below); nothing has actually run it yet. |
| **Nothing was code-signed** | The debug APK is signed with Gradle's auto-generated debug key (fine for local installs, not for any store); `app-release-unsigned.apk` is exactly what its name says -- built but not signed with a real release key. No keystore, no Apple Developer account, no provisioning profile exist here. |
| **The icons are placeholders** | Procedural invader glyph on the game palette. Correctly sized and valid PNGs, but not store-quality art. |

## Android: actually compiled

`./gradlew assembleDebug` (and `assembleRelease`) were run for real against
Gradle 8.11.1 (the project's own wrapper, not a system install) with a JDK 21
and the Android command-line SDK newly installed into this environment. This
produced:

```
android/app/build/outputs/apk/debug/app-debug.apk       (3.98 MB)
android/app/build/outputs/apk/release/app-release-unsigned.apk (3.03 MB)
```

Both are genuine, valid APK archives (confirmed: proper DEX bytecode, correct
Capacitor native bridge, correct asset layout). Critically, `assets/public/js/net.js`
*inside* the debug APK is **byte-for-byte identical (MD5-verified)** to the
current `js/net.js` in this repo -- so this is proof the build compiled the
real, current, Firebase-enabled code, not something stale.

What this does **not** prove: `adb` is not installed here, so nothing has
installed or launched this APK on an emulator or a real device. The bytes are
right; whether the app actually boots, renders, and plays correctly on
Android remains to be seen. If you have `adb` and a connected device or
running emulator: `adb install android/app/build/outputs/apk/debug/app-debug.apk`.

---

## Remaining manual steps

### Android

1. ~~Install Android Studio (or the command-line SDK) and set `ANDROID_HOME`.~~
   **Done** -- a JDK and the command-line SDK are installed in this
   environment.
2. ~~`npm install && npm run cap:sync`~~ **Done.**
3. ~~`npx cap open android`, or headless: `cd android && ./gradlew assembleDebug`~~
   **Done, headless** -- `app-debug.apk` and `app-release-unsigned.apk` both
   exist under `android/app/build/outputs/apk/`, verified as real APKs
   containing the current, correct web assets (see "Android: actually
   compiled" above).
4. **Still to do:** install `adb` (part of Android SDK Platform-Tools) and
   either connect a device or start an emulator, then
   `adb install android/app/build/outputs/apk/debug/app-debug.apk`. Verify
   the game renders, touch controls work, and audio unlocks on first tap.
5. For a real release: create a keystore, configure `signingConfigs` in
   `android/app/build.gradle`, then `./gradlew bundleRelease` for a signed
   AAB (what Play Store wants) -- `app-release-unsigned.apk` above is the
   unsigned intermediate, not something to distribute as-is.

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
