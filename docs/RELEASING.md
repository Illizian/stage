# Releasing

Releases are cut by [Release Please](https://github.com/googleapis/release-please).
On every push to `main` it keeps a release PR open that bumps the version in
`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and
`src-tauri/Cargo.lock`, and adds the commits since the last release to
`CHANGELOG.md`. The next version comes from the
[conventional commit](https://www.conventionalcommits.org) prefixes: `fix:`
bumps the patch, `feat:` the minor, and while the version is below 1.0 a
breaking change also bumps only the minor.

Merging that PR tags the release, creates a **draft** GitHub release with the
changelog as its notes, and builds a universal macOS app into it. Review the
draft, then publish it.

To force a particular version, put `Release-As: 1.0.0` in the body of a commit
on `main`.

Pushing a `v*` tag by hand still builds into a draft release, and the Release
workflow also runs from the Actions tab via "Run workflow" if you need to
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

### 2. Notarisation credentials

Pick **either** route. The workflow detects which secrets you set and uses
whichever is present, preferring the API key when both are.

#### Option A — Apple ID and app-specific password (no permission needed)

1. <https://account.apple.com> → Sign-In and Security → App-Specific Passwords
   → generate one. It looks like `abcd-efgh-ijkl-mnop`.
2. Your Team ID is the 10 characters in brackets at the end of the signing
   identity from step 1, and is also on
   <https://developer.apple.com/account> under Membership details.

That is all. Nothing to request, nothing to approve.

#### Option B — App Store Connect API key

Tidier long term: it does not expire when you change your Apple ID password,
and carries no second factor. But it has to be switched on for the team first.

1. <https://appstoreconnect.apple.com> → Users and Access → Integrations →
   App Store Connect API.
2. If you see only a **Request Access** button and no key tabs, the API has
   never been enabled for this team. Click it — as Account Holder it is a
   terms acknowledgement that grants access immediately, and the **Team Keys**
   and **Individual Keys** tabs then appear. As an Admin it sends a request to
   the Account Holder instead.
3. On **Team Keys**, generate a key with the **Developer** role.
4. Download the `.p8`. **Apple lets you download it exactly once.**
5. Note the **Issuer ID** and the **Key ID**. The Issuer ID is a UUID shown
   above the table of keys, not in a column of it, with a Copy button beside
   it; there is one per team, shared by every team key. The Key ID is the
   10 characters in the key's own row.

Check the three values before spending a CI run on them:

```sh
xcrun notarytool history \
  --key AuthKey_XXXXXXXXXX.p8 \
  --key-id <KEY_ID> \
  --issuer <ISSUER_UUID>
```

An empty history is a pass — it means Apple accepted the credentials. Errors
name the part that is wrong.

### 3. Repository secrets

Settings → Secrets and variables → Actions → New repository secret.

Always needed, from step 1:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | base64 of the `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the password you set when exporting it |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` |

Then whichever notarisation route you chose:

| Option A | Value |
| --- | --- |
| `APPLE_ID` | your Apple ID email |
| `APPLE_PASSWORD` | the app-specific password |
| `APPLE_TEAM_ID` | your 10-character Team ID |

| Option B | Value |
| --- | --- |
| `APPLE_API_ISSUER` | Issuer ID (UUID) |
| `APPLE_API_KEY` | Key ID (10 characters) |
| `APPLE_API_KEY_P8` | the whole `.p8` file, including the BEGIN/END lines |

`gh` can set them without them touching the clipboard or your shell history:

```sh
# Always. Note the `tr`: base64 wraps its output by default on macOS and the
# decoder rejects line breaks.
base64 -i cert.p12 | tr -d '\n' | gh secret set APPLE_CERTIFICATE
gh secret set APPLE_CERTIFICATE_PASSWORD
security find-identity -v -p codesigning     # copy the Developer ID line
gh secret set APPLE_SIGNING_IDENTITY

# Option A
gh secret set APPLE_ID
gh secret set APPLE_PASSWORD
gh secret set APPLE_TEAM_ID

# Option B
gh secret set APPLE_API_ISSUER
gh secret set APPLE_API_KEY
gh secret set APPLE_API_KEY_P8 < AuthKey_XXXXXXXXXX.p8
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

The step before it says which notarisation route it used, or warns that it
had no credentials.

If Gatekeeper rejected the app, the release still works but is awkward to
install. Common causes, in rough order of likelihood:

- `APPLE_SIGNING_IDENTITY` does not match the certificate name exactly;
  copy it verbatim from `security find-identity -v -p codesigning`.
- The certificate is an "Apple Development" one rather than
  "Developer ID Application". Only the latter works outside the App Store.
- `APPLE_CERTIFICATE` has line breaks in it — pipe through `tr -d '\n'`.
- Option A: the app-specific password was pasted with the dashes removed, or
  `APPLE_TEAM_ID` is missing and the Apple ID belongs to several teams.
- Option B: the key lacks the Developer role.

You can verify a downloaded build yourself:

```sh
spctl -a -vvv -t install /Applications/Stage.app
```
