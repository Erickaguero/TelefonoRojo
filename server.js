// El servidor solo hace de intermediario con YouTube (el navegador no puede
// pedirle el chat directamente). No guarda nada: los directos, los Super Chats
// y lo marcado como leído viven en el navegador (ver public/lector.js).
import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ErrorYouTube, obtenerSesion, pedirChat } from "./src/youtubeLive.js";

const PUERTO = Number(process.env.PORT) || 3000;
const app = express();
const raiz = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json());
// En Vercel la carpeta public/ se sirve sola; esto es para correrlo en local.
app.use(express.static(path.join(raiz, "public")));

// Abre la página del directo y devuelve lo necesario para leer su chat.
app.post("/api/sesion", async (req, res) => {
  const videoId = req.body?.videoId;
  if (typeof videoId !== "string" || !/^[\w-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: "Id de video inválido", final: true });
  }
  try {
    res.json(await obtenerSesion(videoId));
  } catch (err) {
    responderError(res, err);
  }
});

// Pide el siguiente bloque del chat a partir de una continuación.
app.post("/api/chat", async (req, res) => {
  const { apiKey, clientVersion, continuation } = req.body ?? {};
  if (![apiKey, clientVersion, continuation].every((v) => typeof v === "string" && v)) {
    return res.status(400).json({ error: "Sesión de chat incompleta" });
  }
  try {
    res.json(await pedirChat({ apiKey, clientVersion, continuation }));
  } catch (err) {
    responderError(res, err);
  }
});

function responderError(res, err) {
  if (!(err instanceof ErrorYouTube)) throw err;
  res.status(502).json({
    error: err.message,
    final: err.final,
    terminado: Boolean(err.terminado),
    info: err.info ?? null,
  });
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Error del servidor" });
});

if (!process.env.VERCEL) {
  app.listen(PUERTO, () => {
    console.log(`Lector de Super Chats listo en http://localhost:${PUERTO}`);
  });
}

export default app;
