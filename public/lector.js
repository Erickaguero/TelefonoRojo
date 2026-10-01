// Lectura del chat y almacenamiento, todo en el navegador. El servidor solo
// trae los datos de YouTube (/api/sesion y /api/chat); los directos, sus
// Super Chats y lo marcado como leído se guardan en localStorage.

const ERRORES_PARA_RECONECTAR = 3;
const MAX_REINTENTOS = 8;
const ACTIVOS = new Set(["escuchando", "conectando"]);

// ---------- Almacenamiento ----------
const CLAVE_STREAMS = "tr:streams";
const claveMensajes = (id) => `tr:mensajes:${id}`;

let alFallarGuardado = () => {};
/** Avisa cuando el navegador no deja guardar (modo privado, sin espacio…). */
export function siFallaGuardado(fn) {
  alFallarGuardado = fn;
}

function leer(clave, porDefecto) {
  try {
    const texto = localStorage.getItem(clave);
    return texto ? JSON.parse(texto) : porDefecto;
  } catch {
    return porDefecto;
  }
}

function escribir(clave, valor) {
  try {
    localStorage.setItem(clave, JSON.stringify(valor));
  } catch {
    alFallarGuardado("El navegador no deja guardar los datos: se perderán al cerrar la página.");
  }
}

// Copia en memoria: si localStorage falla, la app sigue funcionando mientras esté abierta.
const streams = leer(CLAVE_STREAMS, {});
const mensajes = new Map();

function mensajesDe(id) {
  if (!mensajes.has(id)) mensajes.set(id, leer(claveMensajes(id), []));
  return mensajes.get(id);
}

const guardarStreams = () => escribir(CLAVE_STREAMS, streams);
const guardarMensajes = (id) => escribir(claveMensajes(id), mensajesDe(id));

const porOrden = (a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id);

/** Lo que ve la interfaz: sin la sesión interna y con los contadores. */
function publico(s) {
  if (!s) return null;
  const lista = mensajesDe(s.id);
  const { sesion, errores_seguidos, reintentos, proximo_intento, ...visible } = s;
  return { ...visible, total: lista.length, sin_leer: lista.filter((m) => !m.leido).length };
}

export function listStreams() {
  return Object.values(streams).sort((a, b) => b.creado_en - a.creado_en).map(publico);
}

export function getStream(id) {
  return publico(streams[id]);
}

export function listMensajes(id) {
  return mensajesDe(id).map((m) => ({ ...m }));
}

export function setLeido(streamId, mensajeId, leido) {
  const m = mensajesDe(streamId).find((x) => x.id === mensajeId);
  if (!m) throw new Error("Mensaje no encontrado");
  m.leido = leido;
  m.leido_en = leido ? Date.now() : null;
  guardarMensajes(streamId);
  return { ...m };
}

export function marcarHasta(streamId, timestamp) {
  let cambiados = 0;
  for (const m of mensajesDe(streamId)) {
    if (m.timestamp <= timestamp && !m.leido) {
      m.leido = true;
      m.leido_en = Date.now();
      cambiados++;
    }
  }
  if (cambiados) guardarMensajes(streamId);
  return cambiados;
}

function guardarNuevos(streamId, destacados) {
  const lista = mensajesDe(streamId);
  const vistos = new Set(lista.map((m) => m.id));
  const nuevos = [];
  for (const p of destacados) {
    if (vistos.has(p.id)) continue;
    vistos.add(p.id);
    const m = { ...p, stream_id: streamId, leido: false, leido_en: null };
    lista.push(m);
    nuevos.push({ ...m });
  }
  if (nuevos.length) {
    lista.sort(porOrden);
    guardarMensajes(streamId);
  }
  return nuevos.sort(porOrden);
}

// ---------- Link del directo ----------
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

// ---------- Lectura del chat ----------
// Cada vez que se empieza a escuchar un directo cambia su "generación"; así una
// respuesta que llega tarde de una lectura anterior no pisa el estado actual.
const generaciones = new Map();

/** Empieza a escuchar y hace la primera lectura. Devuelve el stream. */
export async function escuchar(entrada) {
  const id = extraerVideoId(entrada);
  if (!id) throw new Error("No reconozco ese link. Pega la URL del directo de YouTube.");
  const s = (streams[id] ??= { id, creado_en: Date.now(), titulo: null, canal: null });
  Object.assign(s, {
    url: `https://www.youtube.com/watch?v=${id}`,
    estado: "conectando",
    detalle: null,
    sesion: null,
    errores_seguidos: 0,
    reintentos: 0,
    proximo_intento: 0,
  });
  generaciones.set(id, (generaciones.get(id) ?? 0) + 1);
  guardarStreams();
  await avanzar(id);
  return getStream(id);
}

export function detener(id) {
  const s = streams[id];
  if (!s) return null;
  generaciones.set(id, (generaciones.get(id) ?? 0) + 1);
  Object.assign(s, { estado: "detenido", detalle: null, sesion: null });
  guardarStreams();
  return getStream(id);
}

/**
 * Da un paso de lectura: conecta si hace falta y pide el siguiente bloque del chat.
 * Devuelve { nuevos, esperaMs }: los mensajes recién guardados y cuánto esperar
 * antes del próximo paso (null si el stream ya no está escuchando).
 */
export async function avanzar(id) {
  const s = streams[id];
  if (!s || !ACTIVOS.has(s.estado)) return { nuevos: [], esperaMs: null };
  const gen = generaciones.get(id) ?? 0;
  const vigente = () => (generaciones.get(id) ?? 0) === gen && ACTIVOS.has(s.estado);

  if (!s.sesion) {
    const falta = s.proximo_intento - Date.now();
    if (falta > 0) return { nuevos: [], esperaMs: falta };
    const espera = await conectar(s, vigente);
    if (espera !== 0) return { nuevos: [], esperaMs: espera };
  }
  return sondear(s, vigente);
}

/** Devuelve 0 si conectó, o la espera hasta el próximo intento (null si terminó). */
async function conectar(s, vigente) {
  let sesion;
  try {
    sesion = await pedir("/api/sesion", { videoId: s.id });
  } catch (err) {
    if (!vigente()) return null;
    if (err.info) Object.assign(s, { titulo: err.info.titulo, canal: err.info.canal });
    if (err.final) return finalizar(s, err.terminado ? "terminado" : "error", err.message);
    return reconectar(s, err.message);
  }
  if (!vigente()) return null;
  Object.assign(s, {
    titulo: sesion.titulo,
    canal: sesion.canal,
    sesion: { apiKey: sesion.apiKey, clientVersion: sesion.clientVersion, continuation: sesion.continuation },
    estado: "escuchando",
    detalle: null,
    errores_seguidos: 0,
  });
  guardarStreams();
  return 0;
}

async function sondear(s, vigente) {
  let r;
  try {
    r = await pedir("/api/chat", s.sesion);
  } catch (err) {
    if (!vigente()) return { nuevos: [], esperaMs: null };
    s.errores_seguidos++;
    if (s.errores_seguidos >= ERRORES_PARA_RECONECTAR) return { nuevos: [], esperaMs: reconectar(s, err.message) };
    guardarStreams();
    return { nuevos: [], esperaMs: 3000 };
  }
  if (!vigente()) return { nuevos: [], esperaMs: null };
  if (r.fin) {
    // Sin continuación: normalmente el directo terminó. Lo confirmamos
    // volviendo a abrir la página.
    return { nuevos: [], esperaMs: reconectar(s, "El chat dejó de responder") };
  }
  s.sesion.continuation = r.continuation;
  s.errores_seguidos = 0;
  s.reintentos = 0;
  guardarStreams();
  return { nuevos: guardarNuevos(s.id, r.destacados), esperaMs: r.esperaMs };
}

function reconectar(s, detalle) {
  s.reintentos++;
  if (s.reintentos > MAX_REINTENTOS) return finalizar(s, "error", `No se pudo reconectar: ${detalle}`);
  const espera = Math.min(30000, 2000 * 2 ** (s.reintentos - 1));
  Object.assign(s, {
    estado: "conectando",
    detalle: `Reconectando (intento ${s.reintentos})…`,
    sesion: null,
    proximo_intento: Date.now() + espera,
  });
  guardarStreams();
  return espera;
}

function finalizar(s, estadoFinal, detalle) {
  Object.assign(s, { estado: estadoFinal, detalle, sesion: null });
  guardarStreams();
  return null;
}

/** POST al servidor; los errores llevan final/terminado/info si vienen de YouTube. */
async function pedir(ruta, cuerpo) {
  const res = await fetch(ruta, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
  });
  const datos = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(datos.error || `Error ${res.status}`), {
      final: Boolean(datos.final),
      terminado: Boolean(datos.terminado),
      info: datos.info ?? null,
    });
  }
  return datos;
}
