import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, "comentarios.db"));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS streams (
    id         TEXT PRIMARY KEY,
    url        TEXT NOT NULL,
    titulo     TEXT,
    canal      TEXT,
    estado     TEXT NOT NULL DEFAULT 'detenido',
    detalle    TEXT,
    creado_en  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mensajes (
    id           TEXT PRIMARY KEY,
    stream_id    TEXT NOT NULL REFERENCES streams(id),
    tipo         TEXT NOT NULL,
    autor        TEXT NOT NULL,
    avatar_url   TEXT,
    monto_texto  TEXT,
    color        TEXT,
    texto        TEXT,
    sticker_url  TEXT,
    timestamp    INTEGER NOT NULL,
    leido        INTEGER NOT NULL DEFAULT 0,
    leido_en     INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_mensajes_stream_ts ON mensajes(stream_id, timestamp);
`);

// Al arrancar el servidor ningún lector está activo.
db.exec(`UPDATE streams SET estado = 'detenido' WHERE estado IN ('escuchando', 'conectando')`);

const q = {
  upsertStream: db.prepare(`
    INSERT INTO streams (id, url, estado, creado_en) VALUES (?, ?, 'conectando', ?)
    ON CONFLICT(id) DO UPDATE SET url = excluded.url, estado = 'conectando', detalle = NULL
  `),
  setInfo: db.prepare(`UPDATE streams SET titulo = ?, canal = ? WHERE id = ?`),
  setEstado: db.prepare(`UPDATE streams SET estado = ?, detalle = ? WHERE id = ?`),
  getStream: db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM mensajes m WHERE m.stream_id = s.id) AS total,
      (SELECT COUNT(*) FROM mensajes m WHERE m.stream_id = s.id AND m.leido = 0) AS sin_leer
    FROM streams s WHERE s.id = ?
  `),
  listStreams: db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM mensajes m WHERE m.stream_id = s.id) AS total,
      (SELECT COUNT(*) FROM mensajes m WHERE m.stream_id = s.id AND m.leido = 0) AS sin_leer
    FROM streams s ORDER BY s.creado_en DESC
  `),
  insertMensaje: db.prepare(`
    INSERT OR IGNORE INTO mensajes
      (id, stream_id, tipo, autor, avatar_url, monto_texto, color, texto, sticker_url, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getMensaje: db.prepare(`SELECT * FROM mensajes WHERE id = ?`),
  listMensajes: db.prepare(`SELECT * FROM mensajes WHERE stream_id = ? ORDER BY timestamp ASC, id ASC`),
  setLeido: db.prepare(`UPDATE mensajes SET leido = ?, leido_en = ? WHERE id = ?`),
  marcarHasta: db.prepare(`
    UPDATE mensajes SET leido = 1, leido_en = ?
    WHERE stream_id = ? AND timestamp <= ? AND leido = 0
  `),
};

export function upsertStream(id, url) {
  q.upsertStream.run(id, url, Date.now());
}

export function setStreamInfo(id, titulo, canal) {
  q.setInfo.run(titulo ?? null, canal ?? null, id);
}

export function setStreamEstado(id, estado, detalle = null) {
  q.setEstado.run(estado, detalle, id);
}

export function getStream(id) {
  return q.getStream.get(id);
}

export function listStreams() {
  return q.listStreams.all();
}

/** Devuelve el mensaje guardado, o null si ya existía. */
export function insertMensaje(m) {
  const { changes } = q.insertMensaje.run(
    m.id, m.stream_id, m.tipo, m.autor, m.avatar_url, m.monto_texto,
    m.color, m.texto, m.sticker_url, m.timestamp,
  );
  return changes ? q.getMensaje.get(m.id) : null;
}

export function getMensaje(id) {
  return q.getMensaje.get(id);
}

export function listMensajes(streamId) {
  return q.listMensajes.all(streamId);
}

export function setLeido(id, leido) {
  q.setLeido.run(leido ? 1 : 0, leido ? Date.now() : null, id);
  return q.getMensaje.get(id);
}

export function marcarHasta(streamId, timestamp) {
  return q.marcarHasta.run(Date.now(), streamId, timestamp).changes;
}
