# Hope Diana Jimenez / 360°hopescope

Your portfolio and client delivery area now run as **one website**. The new **Your Moments** tab has client login and an admin workspace. There is no separate gallery domain to connect.

## Preview the design

Open `Hope-Diana-Preview.html` in a browser. Enter through the lens and choose **Your Moments**.

- **Client preview:** use legal name `Sample Client` and code `HS-DEMO-2026` to view sample portfolio photographs.
- **Admin preview:** choose **Admin login**, then **Explore admin preview**.

This standalone preview does not create real accounts, store uploads, or download client originals. It is clearly labeled as a style preview. The working server is included below.

## Publishing on Netlify — start here

Read **NETLIFY-SETUP.md** before publishing. The project now includes Netlify Functions and a Supabase schema for private cloud storage and persistent gallery data. Set the admin password in Netlify's `ADMIN_PASSWORD` secret; the Python setup command below is only for the alternative local/self-hosted server.

For Netlify, use `npm run build`, publish `dist`, and deploy the included `netlify/functions`. The build deliberately excludes local client data. A raw HTML drag-and-drop upload will not provide all login/upload features. Connect your own Supabase project and production secrets, redeploy, then perform the live checklist in the setup guide. The 100 GB allowance still needs matching real storage capacity on the connected plan.

## Start the alternative local website on your Mac

You need Python **3.11 or newer**. Unzip the project and open Terminal in the `hope-diana-portfolio` folder. You can type `cd `, drag the folder into Terminal, and press Return.

Run these commands one at a time:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python server.py setup
python server.py
```

The setup command asks you to choose and confirm your admin password, with at least 12 characters. There is no default password. Password typing is hidden in Terminal.

Open **http://127.0.0.1:8000**, enter the portfolio, choose **Your Moments → Admin login**, and sign in.

Keep Terminal running while using the site. Press Ctrl+C to stop it. To start again, activate the same `.venv` and run `python server.py`.

On Windows, create the environment with `py -m venv .venv`, activate `.venv\Scripts\activate`, and then use the same `python` commands.

Double-clicking `index.html` can display the static portfolio, but real login, uploads, and downloads require the Python server. A plain static file server cannot provide those functions.

## Create a client's gallery

1. Open **Your Moments → Admin login** and select **New gallery**.
2. Enter the gallery title, the client's legal name as provided at booking, an optional email address, a note, and the access expiry period.
3. Create the gallery. A random code such as `HS-XXXX-XXXX-XXXX` is generated automatically.
4. **Copy and save the code before leaving or refreshing the admin page.** Codes are hashed in the database and cannot be displayed again later.
5. Upload or drag in the finished JPEG, PNG, or WebP photographs.
6. Give your client the portfolio address, their name as entered, and the code. **Prepare client email** opens an email draft for you to review and send. No automatic email is sent.

Clients open the same portfolio, choose **Your Moments**, and enter their legal name plus the code. They can enlarge previews, download individual originals, select photographs for a ZIP, or download the whole gallery.

Names ignore capitalization and extra spaces, and normalize equivalent Unicode spellings. Other differences, such as missing names or changed punctuation, must match what you entered. The name is an account identifier supplied by you; this is not a legal-identity verification service and does not collect ID documents.

A gallery link alone does not unlock any photographs. Client access is checked on the gallery, preview, original, and ZIP routes. The old bearer-link routes are not provided by this integrated server.

### Manage access

- **Pause client access** blocks viewing and future downloads until enabled again.
- **Generate a replacement code** invalidates the old code and existing client sessions. Copy the new code immediately and provide it to the client.
- **Extend access** sets availability to 30 days from today.
- **Delete gallery & photographs** permanently removes the files after confirmation.
- **Remove** under an individual photograph deletes that photo from the gallery.

Clients and admins have separate sign-out controls and sessions. Already downloaded photographs cannot be recalled by pausing or expiring access.

## Storage: 100 GB configurable allowance

The default limit has increased from **5 GB to 100 GB of original photos**. Set `STORAGE_LIMIT_GB` to change it further:

```bash
STORAGE_LIMIT_GB=200 python server.py
```

This changes the application allowance; it does **not** purchase or allocate a cloud disk. Your hosting plan or local disk must have enough real free space. Previews, the database, temporary ZIP downloads, and backups need additional space beyond the original-photo allowance. Uploads are rejected when the configured allowance is full.

- Up to **50 MB per photograph** and **40 megapixels**.
- JPEG, PNG, and WebP; no RAW, TIFF, HEIC, PDFs, or video.
- Originals retain their uploaded bytes and embedded metadata. Only safe download filenames are normalized.
- Smaller, oriented JPEG previews are stored separately without copied EXIF metadata.
- ZIPs are prepared on disk and normally deleted when the download response finishes. Leftovers from interrupted downloads are cleaned on a later startup after 24 hours.

Your public portfolio images are in `assets/`. Private client originals and previews are stored separately in `data/files/`, outside the public asset routes.

## Alternative Python hosting (not used for the Netlify deployment)

The entire portfolio now needs a Python application host with **persistent writable storage**, HTTPS, and backups. It can still use a single public domain. No public deployment, domain purchase, paid hosting, or cloud storage has been created by making these files.

A static-only host cannot run client login or store private uploads. Deploy this whole project and run `python server.py`, rather than uploading only `index.html`.

| Setting | Meaning |
| --- | --- |
| `HOPESCOPE_DATA` | Absolute directory on the persistent disk, e.g. `/var/lib/hopescope` |
| `PUBLIC_URL` | Exact public HTTPS address, with no path, e.g. `https://YOUR-DOMAIN.example` |
| `COOKIE_SECURE` | Set to `1` on HTTPS hosting; keep `0` for local HTTP testing |
| `STORAGE_LIMIT_GB` | Original-photo allowance; defaults to `100` |
| `HOST` | Bind address; defaults to `127.0.0.1`; set `0.0.0.0` when required by a host |
| `PORT` | Defaults to `8000`; use the port assigned by the host if needed |

Run `python server.py setup` with the **same `HOPESCOPE_DATA`** used by the hosted server. Then start with `python server.py`. Use one application process in this starter because login throttling is held in that process. A Dockerfile is also supplied for hosts that use containers; mount a persistent volume at `/var/lib/hopescope` and run setup in that same volume.

Configure HTTPS, request limits around 51 MB, and adequate upload/download timeouts at the host or reverse proxy. Set `PUBLIC_URL` exactly so same-origin checks work behind the proxy. Never expose `data/` as a public web folder. The app's access logs are off by default; keep authentication details out of proxy logs too.

Client codes and admin passwords are hashed. Sessions use HTTP-only cookies, login attempts are throttled, and admin changes require a CSRF token. This is a tested single-admin starter, not an independently audited or managed storage service.

### Backups and admin password reset

Stop the server before copying the whole private data directory to a backup. Keep the database, configuration, and `files/` folder together. Backups are not automatic; a persistent disk alone is not a backup.

To reset a forgotten admin password, stop the server and run `python server.py setup` again. Confirm replacement. This invalidates admin sessions but does not delete photographs. Restart the server afterward.

If migrating an existing standalone gallery data folder into this app, client names and photos are retained. Old client passwords and client sessions are invalidated during the migration; generate a new code for each gallery. Old standalone sharing URLs no longer open galleries here.

## Editing the portfolio

| File | What to edit |
| --- | --- |
| `index.html` | Portfolio copy, navigation, Work collections, About, Contact, Your Moments panel |
| `styles.css` | Colors, layout, film-strip tabs, textures, responsive styles, cursor |
| `script.js` | Portfolio navigation, sound cycle, social links, contact email draft, gallery panel integration |
| `assets/cursor.js`, `assets/cursor.css` | Shared frame-paced local ladybug cursor for portfolio and Your Moments |
| `server.py` | Admin/client API, name/code login, private storage, preview generation, ZIP downloads |
| `moments_web/index.html` | Your Moments panel shell and new-gallery form |
| `moments_web/style.css` | Client/admin panel styling |
| `moments_web/app.js` | Client and admin screens, uploads, code generation workflow, downloads |
| `requirements.txt` | Alternative Python server dependencies |
| `netlify.toml`, `package.json` | Netlify build, routing, functions, and test configuration |
| `netlify/functions/api.mjs`, `netlify/lib/` | Netlify API and private storage adapter |
| `supabase/setup.sql` | Private database tables, storage bucket, quota and rate-limit functions |
| `NETLIFY-SETUP.md` | Netlify publishing and live verification checklist |
| `tests/test_moments.py` | Integration tests |

The contact form still prepares a draft to **hopescopestudios@gmail.com**. Instagram is **@360hopescope**, LinkedIn is **https://www.linkedin.com/in/HopeDiana/**. Your résumé and TikTok link remain removed.

The film strip now includes Home, Work, About Me, Contact, and Your Moments. Primary actions use the temporary synthesized shutter cycle; smaller controls use a very soft click. The exact YouTube sounds still need supplied audio clips; configure `shutterClips` in `script.js` if those are added later.

Work remains ordered Global Stage Hollywood, Women in Media, then portraits. Your About copy, quote, underlined italic HOPE, stickers, texture, and moving ladybug cursor are retained. The portfolio and Your Moments now share `assets/cursor.js` and `assets/cursor.css`. Each document tracks its mouse locally and batches updates to one per animation frame, avoiding per-move cross-frame messaging and geometry reads. The head hotspot, 20 × 26 pixel size, angle, leg animation, and reduced-motion behavior are preserved. Native cursors remain as a fallback until the custom pointer is positioned.

## Validation

Run after installing requirements:

```bash
python -m unittest discover -s tests -v
```

The suite covers name/code access, normalized names, code hashing, protection of previews/originals/ZIPs, gallery separation, code replacement, paused and expired access, logout, admin authentication, CSRF/origin controls, same-site routes, the 100 GB default, quota cleanup, upload validation, deletion, throttling, and persistence after restart.

API integration tests run through an in-process HTTP client. JavaScript syntax, existing portfolio interactions, asset references, and packaging were checked. Browser launch is blocked in the authoring environment, so the embedded panel layout, scroll/focus behavior, clipboard, email-app handoff, and browser downloads still need a real-browser review.

The project ZIP contains no configured admin password, private client uploads, real client codes, or runtime database. The portable preview uses only labeled sample portfolio photos and demo credentials.

## Netlify test suite

```bash
npm test
npm run build
```

The Node tests cover the Netlify API with a simulated data store, secret handling, name/code access, private upload signing, quota checks, session/code revocation, ZIP manifests, and streaming ZIP64 byte preservation. Live Supabase and Netlify behavior is not verified until your accounts are connected. Follow NETLIFY-SETUP.md for the published-site test checklist.
