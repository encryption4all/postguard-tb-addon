# Thunderbird Add-ons store listing

Reviewer-facing and end-user-facing copy for submitting PostGuard to
[addons.thunderbird.net](https://addons.thunderbird.net/). Everything in this
file is ready to paste into the submission form; update it here first, then
copy across.

Tracks [#44](https://github.com/encryption4all/postguard-tb-addon/issues/44),
which in turn blocks [#37](https://github.com/encryption4all/postguard-tb-addon/issues/37)
(first publish).

## Extension name

PostGuard

## Short summary (250 chars max)

End-to-end email encryption for Thunderbird. Encrypt to any email address
without keys or certificates. Recipients unlock with Yivi, a free app that
proves their identity attributes (email, phone, etc.) without creating an
account.

## Full description

PostGuard adds end-to-end email encryption to Thunderbird using
identity-based encryption (IBE). You type the recipient's email, click
the PostGuard button, and send. There are no keys to exchange, no
certificates to install, and no accounts for the recipient to create.

### How it works

When you hit send with PostGuard enabled, the message and its attachments
are encrypted to the recipient's email address. Only someone who can prove
control of that address (or other attributes you choose) can decrypt.

To decrypt, the recipient opens the encrypted message, clicks "Decrypt",
and reveals the matching attribute using the free [Yivi](https://yivi.app)
app on their phone. Yivi returns a cryptographic proof. PostGuard uses it
to derive the decryption key locally. The message is then replaced in-place
with its plaintext.

You can encrypt to an email address, but also to a phone number, or to a
combination (e.g. "email AND employer"). Attributes are issued by
independent verifiers. For email,
[sidn-pbdf.email](https://sidn.nl/) is operated by the Dutch SIDN
foundation.

### What you need

- Thunderbird 128 or later
- The free [Yivi app](https://yivi.app) (iOS, Android, or desktop)
- Your email address disclosed once in Yivi (takes ~30 seconds on first use)

### Why "identity-based encryption"?

Classic end-to-end encryption (PGP, S/MIME) requires the recipient to
have published a public key before you can send. PostGuard lets you
send to anyone who has an email address. They only need to set up
Yivi after they receive the first encrypted message. This makes it
practical for non-technical recipients and one-off correspondence.

### More

- Project homepage: [postguard.eu](https://postguard.eu)
- Documentation: [docs.postguard.eu](https://docs.postguard.eu)
- Source code: [github.com/encryption4all/postguard-tb-addon](https://github.com/encryption4all/postguard-tb-addon)
- PostGuard is developed by [iHub, Radboud University](https://ihub.ru.nl/) and partners.

## Privacy disclosure

PostGuard performs end-to-end encryption on your device. The plaintext
of your messages never leaves your computer in readable form. To do
its work it contacts three kinds of external services, nothing else.

### 1. PostGuard PKG server (`postguard-main.cs.ru.nl` and `*.postguard.eu`)

The Private Key Generator (PKG) is the trusted authority that issues
user secret keys for identity-based encryption.

When you decrypt a message, PostGuard asks the PKG to issue a
secret key for your identity (e.g. your email). The PKG only does
this after Yivi has proven that you control that identity.
When you encrypt a message, PostGuard fetches the PKG's public
master key. No personal data is sent.

The PKG sees your IP address (transport-level), the Yivi session
token for the attribute you disclosed, and the identity for which
the key was requested. It does not see the message, its contents,
or its attachments.

### 2. Yivi servers (`*.yivi.app`)

Yivi is the identity wallet used to prove attributes. During a
session PostGuard opens a QR code that Yivi scans on your phone.
The QR codes point at Yivi's servers for session coordination.

Yivi minimises disclosure: you choose which attributes to reveal per
session, and each disclosure is cryptographically bound to that
session only. Yivi itself never sees the message content.

### 3. PostGuard website (`postguard.eu`)

Used only for static assets referenced in the decrypt banner (logo,
icons) and for opening the PostGuard homepage from the extension UI.
No user data is sent.

### Local storage

`browser.storage.local` caches the JWT that represents your
most recent Yivi disclosure, plus the public master key fetched
from the PKG. The JWT is held locally to spare you from scanning
a new QR code for every message within its validity window. JWTs
are cleared when they expire (see "alarms" permission below) and
can be cleared manually at any time by removing the extension's
storage.

The per-compose-window "encryption enabled" toggle is also persisted
in `storage.local` so that Thunderbird's MV3 background suspension
does not silently drop your choice.

### No telemetry

PostGuard sends no analytics, crash reports, or telemetry of any
kind. The only outgoing traffic is what is described above.

### Consent model

Each decryption requires an explicit Yivi disclosure scanned on your
phone. There is no "remember this choice" that can bypass the Yivi
step for a different message or a different sender. Encryption only
happens when you explicitly enable PostGuard in the compose window
and press send.

## Permission justification

The extension declares the following permissions in `manifest.json`:

| Permission | Why it is needed |
| --- | --- |
| `compose` | Intercept the "Send" action to encrypt outgoing messages when the user has enabled PostGuard for that compose window. |
| `messagesRead` | Read the body and attachments of an incoming encrypted message so they can be decrypted locally. |
| `messagesModify` | Allow the decrypted message to replace the encrypted original in the user's mailbox. |
| `messagesMove` | Place the decrypted message back into the folder where the encrypted original was stored (Inbox, a subfolder, etc.). |
| `messagesDelete` | Delete the encrypted original after a successful decrypt so the user does not see two copies of the same email. |
| `messagesImport` | Import the decrypted message as a new local message so Thunderbird can render it with threading intact. |
| `accountsRead` | Identify which email address the user is sending as, so PostGuard knows which identity the recipient needs to prove on the return path. |
| `accountsFolders` | Locate the correct destination folder when importing a decrypted message. |
| `storage` | Cache the Yivi-issued JWT and the PKG's public master key in `browser.storage.local`, and persist per-compose "encryption enabled" state across MV3 background suspensions. |
| `scripting` | Register the content script that renders the "Decrypt" / "Encrypted" banner on top of encrypted messages in the reading pane. |
| `alarms` | MV3 keepalive for the background service, and periodic cleanup of expired JWTs from local storage. |
| `notifications` | Show user-facing error notifications when decryption fails (e.g. wrong recipient, malformed ciphertext) so the failure does not disappear silently. |

### Host permissions

| Host | Why |
| --- | --- |
| `https://postguard.eu/*` and `https://*.postguard.eu/*` | Contact the PKG server for key retrieval and fetch the public master key. Also used for static assets in the decrypt banner. |
| `https://*.yivi.app/*` | Session coordination with the Yivi identity wallet during disclosure. |

No broader host permissions are requested.

## Source code link

- Public repository: https://github.com/encryption4all/postguard-tb-addon
- License: see the repository's `LICENSE` file.
- Releases are tag-triggered and the `.xpi` is attached to the GitHub release (build instructions in `README.md`).

## Screenshots / promotional images (to capture)

These are not yet prepared. The store submission cannot go in without them.
Listed here as a production checklist.

- [ ] Compose window, PostGuard toggle: composing a new message, cursor near the PostGuard compose action; caption "One click to encrypt".
- [ ] Compose window, policy editor: the optional attributes panel showing e.g. `email` + `employer`; caption "Pick exactly who can decrypt".
- [ ] Yivi popup, QR code: encryption popup with the Yivi QR; caption "Prove your identity with your phone, no accounts needed".
- [ ] Reading pane, decrypt banner: an encrypted email with the blue "Decrypt" banner at the top; caption "Decrypt in place".
- [ ] Reading pane, decrypted with badges: a decrypted message with the sender attribute badges (`email: alice@ru.nl`, `name: Alice`); caption "See exactly who the sender proved to be".
- [ ] Promotional icon (1400x560): PostGuard logo on the brand-blue background.

Screenshots should be captured against Thunderbird 128 with the
`.env.example` PKG so the screenshots do not reference a production
account.

## Reviewer notes (Thunderbird store reviewer)

These notes go in the "Notes for reviewer" field on submission.

> PostGuard is an identity-based end-to-end encryption extension. The
> add-on is ESM + esbuild, source bundled into the `.xpi`.
>
> Build reproduction: from a clean checkout of the corresponding
> tag (e.g. `v0.9.3`):
>
> ```
> npm install
> cp .env.example .env
> npm run build
> cd dist && zip -r ../postguard-tb-addon-<version>.xpi .
> ```
>
> Node 20+ is required. The `.env` file controls which PKG and
> website the add-on contacts; `.env.example` points at the public
> staging PKG and is safe for reviewers to use.
>
> WASM: the `@e4a/pg-wasm` binary is pulled in transitively
> through `@e4a/pg-js` and bundled by esbuild. It is not
> hand-copied into the repo. The corresponding source lives at
> `github.com/encryption4all/postguard` (pg-wasm crate). See
> [#43](https://github.com/encryption4all/postguard-tb-addon/issues/43)
> for the tracking issue on per-release WASM reproducibility.
>
> Remote code: the extension does not load remote code. All
> scripts are packaged in the `.xpi`. WASM is packaged, not fetched
> at runtime.
>
> Network: only the hosts listed in the Privacy disclosure
> above are contacted, and only in response to explicit user
> actions (hitting "Send" on an encrypted compose, or clicking
> "Decrypt" on an incoming message).

## Changelog note

When bumping for a store submission, include a one-paragraph release
note under the version heading in this file (or in
`CHANGELOG.md` if that exists at release time) describing what is
visible to end users in the submitted version. The store reviewers
often ask what changed between submitted versions.
