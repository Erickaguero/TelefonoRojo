import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as db from "./src/db.js";
import * as lector from "./src/chatReader.js";

const PUERTO = Number(process.env.PORT) || 3000;
const app = express();
const raiz = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json());
app.use(express.static(path.join(raiz, "public")));
app.use("/assets", express.static(path.join(raiz, "Assets")));

app.get("/api/streams", (_req, res) => {
  res.json(db.listStreams());
});

app.post("/api/streams", async (req, res) => {
  const videoId = lector.extraerVideoId(req.body?.url);
  if (!videoId) {
    return res.status(400).json({ error: "No reconozco ese link. Pega la URL del directo de YouTube." });
  }
  await lector.escuchar(videoId);
  res.json(db.getStream(videoId));
});

app.get("/api/streams/:id", (req, res) => {
  const stream = db.getStream(req.params.id);
  if (!stream) return res.status(404).json({ error: "Directo no encontrado" });
  res.json(stream);
});

app.post("/api/streams/:id/stop", (req, res) => {
  lector.detener(req.params.id);
  res.json(db.getStream(req.params.id) ?? null);
});

app.get("/api/streams/:id/mensajes", (req, res) => {
  res.json(db.listMensajes(req.params.id));
});

app.patch("/api/mensajes/:id", (req, res) => {
  if (!db.getMensaje(req.params.id)) return res.status(404).json({ error: "Mensaje no encontrado" });
  const mensaje = db.setLeido(req.params.id, Boolean(req.body?.leido));
  lector.eventos.emit("mensaje-actualizado", mensaje);
  emitirStream(mensaje.stream_id);
  res.json(mensaje);
});

app.post("/api/streams/:id/marcar-hasta", (req, res) => {
  const timestamp = Number(req.body?.timestamp);
  if (!Number.isFinite(timestamp)) return res.status(400).json({ error: "timestamp inválido" });
  const cambiados = db.marcarHasta(req.params.id, timestamp);
  lector.eventos.emit("recargar", req.params.id);
  emitirStream(req.params.id);
  res.json({ cambiados });
});

app.get("/api/streams/:id/eventos", (req, res) => {
  const streamId = req.params.id;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const enviar = (tipo, datos) => res.write(`event: ${tipo}\ndata: ${JSON.stringify(datos)}\n\n`);

  const onMensaje = (m) => m.stream_id === streamId && enviar("mensaje", m);
  const onActualizado = (m) => m.stream_id === streamId && enviar("actualizado", m);
  const onStream = (s) => s.id === streamId && enviar("stream", s);
  const onRecargar = (id) => id === streamId && enviar("recargar", {});

  lector.eventos.on("mensaje", onMensaje);
  lector.eventos.on("mensaje-actualizado", onActualizado);
  lector.eventos.on("stream", onStream);
  lector.eventos.on("recargar", onRecargar);
  const latido = setInterval(() => res.write(": ping\n\n"), 25000);

  const stream = db.getStream(streamId);
  if (stream) enviar("stream", stream);

  req.on("close", () => {
    clearInterval(latido);
    lector.eventos.off("mensaje", onMensaje);
    lector.eventos.off("mensaje-actualizado", onActualizado);
    lector.eventos.off("stream", onStream);
    lector.eventos.off("recargar", onRecargar);
  });
});

function emitirStream(id) {
  const stream = db.getStream(id);
  if (stream) lector.eventos.emit("stream", stream);
}

app.listen(PUERTO, "127.0.0.1", () => {
  console.log(`Lector de Super Chats listo en http://localhost:${PUERTO}`);
});
