# Android password autofill

The bundled Capacitor UI runs at `https://localhost`. HTML `autocomplete`
attributes identify the fields, but do not associate that origin with passwords
saved for `https://trackyourtime.dev`. Keep the origin stable: changing it would
separate existing WebView storage from the upgraded app.

The login screen therefore exposes **Use a saved password** on Android when the
selected API is exactly `https://api.trackyourtime.dev`. The local
`PasswordManager` Capacitor plugin requests a password through AndroidX
Credential Manager using the signed Android app identity. The provider controls
the selection/consent UI. The selected email and password populate the existing
form; the user still presses Log in. No credential is persisted by this bridge.
Cancellation leaves the form alone. Leaving the page or switching servers
cancels a pending request; switching servers after filling clears those values.
Self-hosted servers continue to use manual or browser sign-in.

The actual Capacitor WebView is marked important for Android autofill. The
email field uses `type=email`, `inputmode=email`, and `autocomplete=username`;
the password field uses `type=password` and `autocomplete=current-password`.
Submit reads the form's DOM values to support providers which do not dispatch
React change events. Inline keyboard suggestions remain provider-dependent;
the native picker avoids depending on WebView's localhost matching.

## Association and release requirements

`AndroidManifest.xml` references `@string/asset_statements`, which includes
`https://trackyourtime.dev/.well-known/assetlinks.json`. That file must contain
both the website self-reference and the Android package/certificate target with
`delegate_permission/common.get_login_creds`.

The checked-in certificate fingerprint is the previously published production
association. Check it against **Play Console → App integrity → App signing key
certificate → SHA-256** for Play installs. Play signs delivered APKs with its
app-signing key; an upload-key fingerprint does not establish that association.
For directly distributed APKs, check the signing certificate with
`apksigner verify --print-certs path/to/app.apk`. Do not publish debug-key trust
on the production website.

Deploy the updated website file and release the rebuilt Android app. A web-only
deployment cannot add the native plugin or manifest metadata to installed apps.
The JSON endpoint must return HTTP 200, `application/json`, without redirects.
Provider association caches can delay recognition after deployment.

For an Android-only update, dispatch `mobile-release.yml` on `main` with
`platform=android` and the existing Play track. This increments `versionCode`
without publishing an iOS build or creating an all-platform release tag.

Validate on the installed, release-signed build with a configured password
provider and a saved `trackyourtime.dev` login. Check picker selection fills both
fields, cancellation leaves them alone, login succeeds, and switching to a
self-hosted server never carries over a selected website password. Automated
tests use fake credentials; debug builds cannot prove production association.

Android bridge logging is disabled even for debug builds because plugin results
contain passwords. Do not log plugin responses, capture credential-filled
screens, or include real passwords in test fixtures.

References: [Android passwords](https://developer.android.com/identity/passwords),
[Digital Asset Links credential sharing](https://developers.google.com/identity/credential-sharing/set-up),
[Capacitor autofill](https://capacitorjs.com/docs/guides/autofill-credentials).
