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

Overlap runs in Docker and Caddy sits in front of it, serving it over HTTPS. Caddy gets the certificates for you.

### 1. Start Overlap with Docker Compose

You need Docker with the Compose plugin. In this folder:

    cp .env.example .env

Edit `.env` and set the port you want. For example:

    PORT=3005

Then build and start it:

    docker compose up -d --build

Overlap is now listening on `127.0.0.1:3005` on the host. It is only reachable from the machine itself, so traffic has to go through Caddy. The database lives in the `overlap-data` Docker volume, which survives restarts, rebuilds and `docker compose down`.

The settings in `.env`:

| Variable      | Default     | What it does |
| ------------- | ----------- | ------------ |
| `PORT`        | `8080`      | Port Overlap listens on, inside the container and on the host. Caddy must point at the same one. |
| `BIND`        | `127.0.0.1` | Host address the port is published on. Keep `127.0.0.1` when Caddy runs on the same machine. |
| `TRUST_PROXY` | `1`         | Trust the `X-Forwarded-*` headers Caddy sets. Only set it to `0` if nothing sits in front of Overlap. |

To see the logs:

    docker compose logs -f

After pulling new code, run `docker compose up -d --build` again.

### 2. Point Caddy at it

Add this to your Caddyfile, using your domain and the same port as `PORT` in `.env`:

    overlap.example.com {
        reverse_proxy 127.0.0.1:3005
    }

Then reload Caddy:

    sudo systemctl reload caddy

The session cookie is marked `Secure` whenever the request came in over HTTPS, which it always does through Caddy.

If Caddy itself runs in a Docker container, put both containers on the same Docker network and use `reverse_proxy overlap:3005` instead. In that case you don't need the `ports:` section in `docker-compose.yml` at all.

### Without Docker

Run `TRUST_PROXY=1 PORT=3005 npm start` and point Caddy at the same port as above. To keep it running with systemd, create `/etc/systemd/system/overlap.service`:

    [Unit]
    Description=Overlap
    After=network.target

    [Service]
    WorkingDirectory=/opt/overlap
    Environment=TRUST_PROXY=1
    Environment=PORT=3005
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

With Docker, run the same commands inside the container:

    docker compose exec overlap node --disable-warning=ExperimentalWarning server/admin.js list
    docker compose exec overlap node --disable-warning=ExperimentalWarning server/admin.js delete <event id>

You can also do it straight from the `sqlite3` shell. A trigger removes the event's answers with it:

    sqlite3 data/overlap.db "DELETE FROM events WHERE id = 'abc123';"

The server and the npm scripts overwrite deleted rows on disk (`secure_delete`). A plain `sqlite3` shell only does that if you run `PRAGMA secure_delete = ON;` first.

To back up while the server is running:

    sqlite3 data/overlap.db ".backup overlap-backup.db"

With Docker, the database is inside the volume. The container has no `sqlite3`, so copy it out through a throwaway container that does. This backs it up to `overlap-backup.db` in the current folder:

    docker run --rm -v overlap_overlap-data:/data -v "$PWD":/backup alpine \
      sh -c 'apk add -q sqlite && sqlite3 /data/overlap.db ".backup /backup/overlap-backup.db"'

The volume's full name starts with the Compose project name, which is the folder name (`overlap` here). `docker volume ls` shows it.

## How it works

- The home page lets anyone create a named event. Each event gets its own link (`?e=...`).
- Friends open the link, enter their name, and tap or drag across any dates in any month.
- The Together tab and the Best days list show where schedules overlap. Changes appear for everyone with the event open, without reloading.
- Once three or more people have answered, the Together tab has a row of name chips. Pick a few to see only the days those people are all free. With more than eight people, the rest sit behind a "+n more" chip.
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
