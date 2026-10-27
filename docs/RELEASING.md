# Releasing

Pushing a `v*` tag builds a universal macOS app and attaches it to a **draft**
release. Review the draft, then publish it.

```sh
# bump the version in src-tauri/tauri.conf.json and package.json first
git tag v0.1.0
git push origin v0.1.0
```

The workflow also runs from the Actions tab via "Run workflow" if you need to
rebuild a tag.

## Signing and notarisation

Without this, macOS 26 will not let anyone open the app by double-clicking —
Apple removed the old Control-click → Open escape hatch, so users have to go to
System Settings → Privacy & Security and click "Open Anyway". With it, the app
opens normally.

The release workflow signs and notarises when the secrets below exist, and
silently produces an unsigned build when they do not. Nothing in the repo
changes either way.

### 1. Developer ID Application certificate

This is the certificate for distributing outside the App Store. It is **not**
the "Apple Development" certificate Xcode creates by default.

1. Xcode → Settings → Accounts → select your team → Manage Certificates.
2. The **+** button at the bottom left → **Developer ID Application**.
3. Keychain Access → My Certificates → find
   `Developer ID Application: Your Name (TEAMID)`.
4. Right-click it → Export → save as `.p12` and set a password.

Then get the two values the workflow needs:

```sh
# The exact identity string, including the team id in brackets.
security find-identity -v -p codesigning

# The certificate itself, base64 encoded, copied to the clipboard.
base64 -i /path/to/cert.p12 | pbcopy
```

### 2. App Store Connect API key

Used for notarisation. An API key is preferable to an Apple ID and
app-specific password: it does not expire when you change your password and
carries no second factor.

1. <https://appstoreconnect.apple.com> → Users and Access → Integrations →
   App Store Connect API → **Team Keys**.
2. Generate a key with the **Developer** role. (Creating keys needs an Account
   Holder or Admin.)
3. Download the `.p8`. **Apple lets you download it exactly once.**
4. Note the **Issuer ID** (a UUID at the top of the page) and the **Key ID**
   (10 characters, next to the key).

### 3. Repository secrets

Settings → Secrets and variables → Actions → New repository secret.

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | base64 of the `.p12` from step 1 |
| `APPLE_CERTIFICATE_PASSWORD` | the password you set when exporting it |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_API_ISSUER` | Issuer ID (UUID) |
| `APPLE_API_KEY` | Key ID (10 characters) |
| `APPLE_API_KEY_P8` | the whole contents of the `.p8` file, including the BEGIN/END lines |

`gh` can set them without them touching the clipboard or your shell history:

```sh
base64 -i cert.p12 | gh secret set APPLE_CERTIFICATE
gh secret set APPLE_API_KEY_P8 < AuthKey_XXXXXXXXXX.p8
gh secret set APPLE_SIGNING_IDENTITY   # prompts for the value
```

The Tauri CLI does the rest: it imports the certificate into a temporary
keychain, signs with the hardened runtime, submits to `notarytool`, waits, and
staples the ticket to the app.

### 4. Check it worked

The workflow's last step prints the result. A good build ends with:

```
source=Notarized Developer ID
Signed and notarised: this will open with a double-click.
```

If it says Gatekeeper rejected the app, the release is still usable but
awkward to install. The most common causes are `APPLE_SIGNING_IDENTITY` not
matching the certificate's name exactly, or an API key without the Developer
role.

You can verify a downloaded build yourself:

```sh
spctl -a -vvv -t install /Applications/Stage.app
```

## Using an Apple ID instead

If you would rather not create an API key, swap the three `APPLE_API_*`
secrets for `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password from
<https://account.apple.com>, not your real one) and `APPLE_TEAM_ID`, and pass
them through in the same `env:` block in `.github/workflows/release.yml`.
