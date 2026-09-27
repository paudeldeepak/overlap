# Overlap: find the day that works for everyone

Create an event, share its link, and everyone marks the days they're free.
Overlap is one small Node server and one SQLite file. It has no dependencies to install.

## Run it

You need Node.js 22.13 or newer (https://nodejs.org). In this folder, run:

    npm start

Open http://127.0.0.1:8080. The database is created at `data/overlap.db` the first time the server starts.

These environment variables change the defaults:

| Variable      | Default            | What it does |
| ------------- | ------------------ | ------------ |
| `PORT`        | `8080`             | Port to listen on. |
| `HOST`        | `127.0.0.1`        | Address to listen on. Use `0.0.0.0` only if nothing sits in front of the server. |
| `DB_PATH`     | `data/overlap.db`  | Where the SQLite file lives. |
| `TRUST_PROXY` | off                | Set to `1` when a reverse proxy sits in front and sets `X-Forwarded-*` headers. |

## Put it on the internet

Serve it over HTTPS through a reverse proxy. With Caddy, which gets certificates for you, the whole config is:

    overlap.example.com {
        reverse_proxy 127.0.0.1:8080
    }

Then start Overlap with `TRUST_PROXY=1 npm start`. The session cookie is marked `Secure` whenever the request came in over HTTPS.

To keep it running with systemd, create `/etc/systemd/system/overlap.service`:

    [Unit]
    Description=Overlap
    After=network.target

    [Service]
    WorkingDirectory=/opt/overlap
    Environment=TRUST_PROXY=1
    ExecStart=/usr/bin/npm start
    Restart=on-failure
    User=overlap

    [Install]
    WantedBy=multi-user.target

Then run `sudo systemctl enable --now overlap`.

## The database

There are three tables:

- `people` has one row per browser. It stores a random ID and the SHA-256 hash of that browser's session token, never the token itself.
- `events` has the title, when it was made, who made it, and the name they answered with.
- `responses` has one row per person per event: their name and a JSON list of dates.

To see every event:

    npm run events

To delete an event along with everyone's answers:

    npm run delete-event -- <event id>

You can also do it straight from the `sqlite3` shell. A trigger removes the event's answers with it:

    sqlite3 data/overlap.db "DELETE FROM events WHERE id = 'abc123';"

The server and the npm scripts overwrite deleted rows on disk (`secure_delete`). A plain `sqlite3` shell only does that if you run `PRAGMA secure_delete = ON;` first.

To back up while the server is running:

    sqlite3 data/overlap.db ".backup overlap-backup.db"

## How it works

- The home page lets anyone create a named event. Each event gets its own link (`?e=...`).
- Friends open the link, enter their name, and tap or drag across any dates in any month.
- The Everyone tab and the Best days list show where schedules overlap. Changes appear for everyone with the event open, without reloading.
- Only the person who created an event can rename or delete it.

## Security

- Nobody signs up. The first visit gets a random 256-bit token in an `HttpOnly`, `SameSite=Strict` cookie, so page scripts can't read it and other sites can't send it.
- Every write runs in its own `BEGIN IMMEDIATE` transaction and is rolled back on any error. Every query uses bound parameters. Rename and delete check ownership inside the SQL statement itself.
- The server rejects writes from other sites (checked with `Origin` and `Sec-Fetch-Site`), anything that isn't JSON, request bodies over 16 KB, names over the length limits, dates that don't exist, and more than 400 days.
- Simple rate limits stop a script from filling the database.
- The page ships with a Content Security Policy that only allows its own script, matched by hash.
- The server only serves `index.html` and the API. No other file in this folder can be requested.
- Anyone with an event link can add a response, so share links only with the people you're inviting. Events can't be listed through the API, only opened by link.
- Identity lives in the browser, so someone who switches devices shows up as a new person.

If you edit `public/index.html`, restart the server so it picks up the new script hash.
