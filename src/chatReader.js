// Mantiene una lectura activa por directo: consulta el chat en bucle, guarda
// los mensajes pagados y avisa de los cambios. Los detalles de YouTube están
// en youtubeLive.js.
import { EventEmitter } from "node:events";
import * as db from "./db.js";
import { obtenerSesion, pedirChat } from "./youtubeLive.js";

const ERRORES_PARA_RECONECTAR = 3;
const MAX_REINTENTOS = 8;

/** Emite: "mensaje" (mensaje guardado), "stream" (stream actualizado). */
export const eventos = new EventEmitter();
eventos.setMaxListeners(0);

const activos = new Map(); // videoId -> { sesion, erroresSeguidos, reintentos, timer, detenido }

export function extraerVideoId(entrada) {
  const texto = String(entrada ?? "").trim();
  if (/^[\w-]{11}$/.test(texto)) return texto;
  let url;
  try {
    url = new URL(texto.startsWith("http") ? texto : `https://${texto}`);
  } catch {
    return null;
  }
  if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(url.hostname)) return null;
  if (url.hostname.endsWith("youtu.be")) return valido(url.pathname.slice(1));
  const v = url.searchParams.get("v");
  if (v) return valido(v);
  const m = url.pathname.match(/^\/(?:live|shorts|embed)\/([\w-]{11})/);
  return m ? m[1] : null;
}

function valido(id) {
  return /^[\w-]{11}$/.test(id) ? id : null;
}

/** Empieza a escuchar; resuelve cuando la primera conexión tuvo éxito o falló. */
export async function escuchar(videoId) {
  detener(videoId, false);
  db.upsertStream(videoId, `https://www.youtube.com/watch?v=${videoId}`);
  notificarStream(videoId);

  const estado = { sesion: null, erroresSeguidos: 0, reintentos: 0, timer: null, detenido: false };
  activos.set(videoId, estado);
  await conectar(videoId, estado);
}

export function detener(videoId, marcar = true) {
  const estado = activos.get(videoId);
  if (estado) {
    estado.detenido = true;
    clearTimeout(estado.timer);
    activos.delete(videoId);
  }
  if (marcar && db.getStream(videoId)) {
    db.setStreamEstado(videoId, "detenido");
    notificarStream(videoId);
  }
}

async function conectar(videoId, estado) {
  if (estado.detenido) return;
  try {
    estado.sesion = await obtenerSesion(videoId);
  } catch (err) {
    if (estado.detenido) return;
    if (err.info) db.setStreamInfo(videoId, err.info.titulo, err.info.canal);
    if (err.final) {
      finalizar(videoId, err.terminado ? "terminado" : "error", err.message);
    } else {
      reconectar(videoId, estado, err.message);
    }
    return;
  }
  if (estado.detenido) return;

  db.setStreamInfo(videoId, estado.sesion.titulo, estado.sesion.canal);
  db.setStreamEstado(videoId, "escuchando");
  notificarStream(videoId);
  estado.erroresSeguidos = 0;
  await sondear(videoId, estado);
}

async function sondear(videoId, estado) {
  if (estado.detenido) return;
  let espera;
  try {
    const r = await pedirChat(estado.sesion);
    if (estado.detenido) return;
    if (r.fin) {
      // Sin continuación: normalmente el directo terminó. Lo confirmamos
      // volviendo a abrir la página.
      reconectar(videoId, estado, "El chat dejó de responder");
      return;
    }
    estado.sesion.continuation = r.continuation;
    estado.erroresSeguidos = 0;
    estado.reintentos = 0;
    guardar(videoId, r.pagados);
    espera = r.esperaMs;
  } catch (err) {
    if (estado.detenido) return;
    estado.erroresSeguidos++;
    if (estado.erroresSeguidos >= ERRORES_PARA_RECONECTAR) {
      reconectar(videoId, estado, err.message);
      return;
    }
    espera = 3000;
  }
  estado.timer = setTimeout(() => sondear(videoId, estado), espera);
}

function guardar(videoId, pagados) {
  let hubo = false;
  for (const p of pagados) {
    const guardado = db.insertMensaje({ ...p, stream_id: videoId });
    if (guardado) {
      hubo = true;
      eventos.emit("mensaje", guardado);
    }
  }
  if (hubo) notificarStream(videoId);
}

function reconectar(videoId, estado, detalle) {
  estado.reintentos++;
  if (estado.reintentos > MAX_REINTENTOS) {
    finalizar(videoId, "error", `No se pudo reconectar: ${detalle}`);
    return;
  }
  db.setStreamEstado(videoId, "conectando", `Reconectando (intento ${estado.reintentos})…`);
  notificarStream(videoId);
  const espera = Math.min(30000, 2000 * 2 ** (estado.reintentos - 1));
  estado.timer = setTimeout(() => conectar(videoId, estado), espera);
}

function finalizar(videoId, estadoFinal, detalle) {
  const estado = activos.get(videoId);
  if (estado) {
    estado.detenido = true;
    clearTimeout(estado.timer);
    activos.delete(videoId);
  }
  db.setStreamEstado(videoId, estadoFinal, detalle);
  notificarStream(videoId);
}

function notificarStream(videoId) {
  const stream = db.getStream(videoId);
  if (stream) eventos.emit("stream", stream);
}
