import { openDb, tx, DEFAULT_DB } from './db.js';

/* npm run events                   list every event, newest first
   npm run delete-event -- <id>     delete one event and everyone's answers to it */
const db = openDb(process.env.DB_PATH || DEFAULT_DB);
const [cmd, id] = process.argv.slice(2);

if (cmd === 'list') {
  const rows = db.prepare(`
    SELECT e.id, e.title, e.created, e.owner_name AS owner, COUNT(r.person_id) AS answers
    FROM events e LEFT JOIN responses r ON r.event_id = e.id
    GROUP BY e.id ORDER BY e.created DESC`).all();
  if (!rows.length) console.log('No events yet.');
  for (const r of rows) {
    const made = new Date(r.created).toISOString().slice(0, 10);
    console.log(`${r.id}  ${made}  ${String(r.answers).padStart(3)} answers  ${r.title}${r.owner ? `  (by ${r.owner})` : ''}`);
  }
} else if (cmd === 'delete' && id) {
  const deleted = tx(db, () => db.prepare('DELETE FROM events WHERE id = ?').run(id).changes);
  console.log(deleted ? `Deleted ${id} and its answers.` : `No event with id ${id}.`);
  if (deleted) console.log('Anyone with the event open will see it gone after they reload.');
} else {
  console.log('Usage:\n  npm run events\n  npm run delete-event -- <event id>');
  process.exitCode = 1;
}
db.close();
