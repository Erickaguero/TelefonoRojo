const $ = (id) => document.getElementById(id);

const ESTADOS = {
  escuchando: "En vivo",
  conectando: "Conectando…",
  terminado: "Directo terminado",
  detenido: "Detenido",
  error: "Error",
};

const st = {
  streamId: null,
  stream: null,
  mensajes: [],
  filtro: "sin-leer",
  seleccion: null,
  fuente: null,
  nuevos: new Set(),
  animarEntrada: false,
  resumenPrevio: {},
};

const DURACION_SALIDA = 320;
const DURACION_COLAPSO = 280;
const GAP_LISTA = 14;

const formatoHora = new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const formatoNumero = new Intl.NumberFormat("es", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const sinMovimiento = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- API ----------
async function api(ruta, opciones = {}) {
  const res = await fetch(ruta, {
    ...opciones,
    headers: { "Content-Type": "application/json" },
    body: opciones.body ? JSON.stringify(opciones.body) : undefined,
  });
  const datos = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(datos.error || `Error ${res.status}`);
  return datos;
}

// ---------- Carga de directos ----------
async function cargarListaStreams() {
  const streams = await api("/api/streams");
  const select = $("select-stream");
  select.replaceChildren(new Option("Directos guardados…", ""));
  for (const s of streams) {
    const nombre = s.titulo || s.id;
    const op = new Option(`${nombre} — ${s.sin_leer} sin leer / ${s.total}`, s.id);
    select.add(op);
  }
  select.value = st.streamId ?? "";
}

async function abrirStream(id) {
  if (!id) return;
  st.streamId = id;
  st.seleccion = null;
  st.nuevos.clear();
  st.resumenPrevio = {};
  st.animarEntrada = true;
  if (location.hash.slice(1) !== id) history.replaceState(null, "", `#${id}`);
  st.mensajes = await api(`/api/streams/${id}/mensajes`);
  st.stream = await api(`/api/streams/${id}`);
  conectarEventos(id);
  pintarStream();
  pintarLista();
  cargarListaStreams();
}

function conectarEventos(id) {
  st.fuente?.close();
  const fuente = new EventSource(`/api/streams/${id}/eventos`);
  st.fuente = fuente;

  fuente.addEventListener("mensaje", (e) => {
    const m = JSON.parse(e.data);
    if (st.mensajes.some((x) => x.id === m.id)) return;
    st.mensajes.push(m);
    st.mensajes.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
    st.nuevos.add(m.id);
    pintarLista();
  });

  fuente.addEventListener("actualizado", (e) => {
    const m = JSON.parse(e.data);
    const i = st.mensajes.findIndex((x) => x.id === m.id);
    if (i >= 0 && st.mensajes[i].leido !== m.leido) {
      st.mensajes[i] = m;
      pintarLista();
    }
  });

  fuente.addEventListener("stream", (e) => {
    st.stream = JSON.parse(e.data);
    pintarStream();
  });

  fuente.addEventListener("recargar", async () => {
    st.mensajes = await api(`/api/streams/${id}/mensajes`);
    pintarLista();
  });

  // EventSource reintenta solo; al reconectar volvemos a pedir la lista
  // por si se perdió algún mensaje mientras estaba caído.
  let caido = false;
  fuente.addEventListener("error", () => { caido = true; });
  fuente.addEventListener("open", async () => {
    if (!caido) return;
    caido = false;
    st.mensajes = await api(`/api/streams/${id}/mensajes`);
    pintarLista();
  });
}

// ---------- Pintado ----------
function pintarStream() {
  const s = st.stream;
  const hay = Boolean(s);
  $("cabecera-stream").hidden = !hay;
  $("controles").hidden = !hay;
  $("estado").hidden = !hay;
  if (!hay) return;

  $("titulo").textContent = s.titulo || `Directo ${s.id}`;
  $("canal").textContent = s.canal || "";
  const estado = $("estado");
  estado.dataset.estado = s.estado;
  estado.textContent = ESTADOS[s.estado] ?? s.estado;
  estado.title = s.detalle || "";
  if (s.detalle && s.estado !== "escuchando") estado.textContent += ` · ${s.detalle}`;

  const activo = s.estado === "escuchando" || s.estado === "conectando";
  $("btn-detener").hidden = !activo;
  pintarContador();
  moverIndicador();
}

function pintarContador() {
  const total = st.mensajes.length;
  const sinLeer = st.mensajes.filter((m) => !m.leido).length;
  $("contador").textContent = `${sinLeer} sin leer de ${total}`;
  document.title = sinLeer ? `(${sinLeer}) Lector de Super Chats` : "Lector de Super Chats";
  pintarResumen();
}

function visibles() {
  if (st.filtro === "sin-leer") return st.mensajes.filter((m) => !m.leido);
  if (st.filtro === "leidos") return st.mensajes.filter((m) => m.leido);
  return st.mensajes;
}

function pintarLista() {
  const lista = $("lista");
  const items = visibles();
  lista.replaceChildren(...items.map(tarjeta));
  st.nuevos.clear();
  st.animarEntrada = false;

  let yaDeslizo = false;
  try { yaDeslizo = localStorage.getItem("ya-deslizo") === "1"; } catch {}
  $("pista").hidden = yaDeslizo || !items.some((m) => !m.leido);

  const vacio = $("vacio");
  vacio.hidden = items.length > 0 || !st.stream;
  if (!items.length) {
    vacio.textContent =
      st.filtro === "sin-leer" && st.mensajes.length
        ? "Leíste todo. Los Super Chats nuevos aparecerán aquí."
        : st.filtro === "leidos"
          ? "Todavía no marcaste ninguno como leído."
          : "Aún no hay Super Chats. Aparecerán aquí en cuanto lleguen.";
  }
  pintarContador();
}

function tarjeta(m, indice) {
  const envoltura = document.createElement("div");
  envoltura.className = "deslizable";
  if (m.leido) envoltura.classList.add("desmarcar");
  if (st.nuevos.has(m.id)) envoltura.classList.add("nueva");
  else if (st.animarEntrada && indice < 20) {
    envoltura.classList.add("entrada");
    envoltura.style.setProperty("--i", indice);
  }
  if (m.color) {
    envoltura.style.setProperty("--color-sc", m.color);
    envoltura.style.setProperty("--color-texto-sc", textoSobre(m.color));
  }

  // Lo que se ve detrás de la tarjeta mientras se arrastra.
  const fondo = document.createElement("div");
  fondo.className = "swipe-fondo";
  fondo.setAttribute("aria-hidden", "true");
  const etiqueta = document.createElement("span");
  etiqueta.className = "swipe-etiqueta";
  etiqueta.append(span("rayo", ""), m.leido ? "No leído" : "Leído");
  fondo.append(etiqueta);

  const el = document.createElement("article");
  el.className = "tarjeta";
  el.tabIndex = -1;
  el.dataset.id = m.id;
  if (m.leido) el.classList.add("leida");
  if (m.id === st.seleccion) el.classList.add("seleccionada");

  const avatar = document.createElement("img");
  avatar.className = "avatar";
  avatar.alt = "";
  avatar.loading = "lazy";
  avatar.draggable = false;
  avatar.referrerPolicy = "no-referrer";
  if (m.avatar_url) avatar.src = m.avatar_url;

  const cuerpo = document.createElement("div");
  cuerpo.className = "cuerpo";
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.append(
    span("autor", m.autor),
    span("monto", m.monto_texto || (m.tipo === "sticker" ? "Sticker" : "")),
    span("hora", formatoHora.format(new Date(m.timestamp))),
  );
  cuerpo.append(meta);
  if (m.texto) {
    const p = document.createElement("p");
    p.className = "texto";
    p.textContent = m.texto;
    cuerpo.append(p);
  }
  if (m.sticker_url) {
    const img = document.createElement("img");
    img.className = "sticker";
    img.src = m.sticker_url;
    img.alt = "Super Sticker";
    img.draggable = false;
    img.referrerPolicy = "no-referrer";
    cuerpo.append(img);
  }

  const acciones = document.createElement("div");
  acciones.className = "acciones";
  if (m.leido) acciones.append(span("sello-leido", "Leído"));
  const hasta = document.createElement("button");
  hasta.className = "hasta";
  hasta.type = "button";
  hasta.textContent = "Marcar hasta aquí";
  hasta.title = "Marca como leído este y todos los anteriores";
  hasta.addEventListener("click", () => marcarHasta(m.timestamp));
  acciones.append(hasta);

  el.append(avatar, cuerpo, acciones);
  envoltura.append(fondo, el);
  habilitarDeslizar(envoltura, el, m);
  return envoltura;
}

// Arrastrar la tarjeta hacia la derecha la marca como leída (o la desmarca si ya lo estaba).
// Funciona con dedo y con mouse; el desplazamiento vertical de la página no se ve afectado.
function habilitarDeslizar(envoltura, el, m) {
  let puntero = null;
  let inicioX = 0;
  let inicioY = 0;
  let dx = 0;
  let arrastrando = false;
  let ignorarClick = false;
  const umbral = () => Math.min(160, el.offsetWidth * 0.35);

  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button, a")) return;
    puntero = e.pointerId;
    inicioX = e.clientX;
    inicioY = e.clientY;
    dx = 0;
    arrastrando = false;
  });

  el.addEventListener("pointermove", (e) => {
    if (e.pointerId !== puntero) return;
    const mx = e.clientX - inicioX;
    const my = e.clientY - inicioY;
    if (!arrastrando) {
      if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) { puntero = null; return; }
      if (mx < 10) return;
      arrastrando = true;
      el.setPointerCapture(puntero);
      envoltura.classList.add("arrastrando");
      window.getSelection()?.removeAllRanges();
    }
    dx = Math.max(0, mx);
    const avance = Math.min(1, dx / umbral());
    el.style.transform = `translateX(${dx}px) rotate(${avance * 1.5}deg)`;
    envoltura.style.setProperty("--avance", avance);
    envoltura.classList.toggle("listo", avance >= 1);
  });

  const soltar = (e) => {
    if (e.pointerId !== puntero) return;
    puntero = null;
    if (!arrastrando) return;
    arrastrando = false;
    ignorarClick = true;
    envoltura.classList.remove("arrastrando");
    if (e.type === "pointerup" && dx >= umbral()) {
      try { localStorage.setItem("ya-deslizo", "1"); } catch {}
      cambiarLeido(m.id, !m.leido, { avisar: true });
    } else {
      envoltura.classList.add("volviendo");
      envoltura.classList.remove("listo");
      el.style.transform = "";
      envoltura.style.setProperty("--avance", 0);
      setTimeout(() => envoltura.classList.remove("volviendo"), 450);
    }
  };
  el.addEventListener("pointerup", soltar);
  el.addEventListener("pointercancel", soltar);

  el.addEventListener("click", (e) => {
    if (ignorarClick) { ignorarClick = false; return; }
    if (e.target.closest("input, button, label")) return;
    seleccionar(m.id);
  });
}

function span(clase, texto) {
  const s = document.createElement("span");
  s.className = clase;
  s.textContent = texto;
  return s;
}

function textoSobre(hex) {
  const n = parseInt(hex.slice(1, 7), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#000" : "#fff";
}

// ---------- Acciones ----------
async function marcar(id, leido) {
  const m = st.mensajes.find((x) => x.id === id);
  if (!m) return;
  const anterior = m.leido;
  m.leido = leido ? 1 : 0;
  pintarLista();
  try {
    Object.assign(m, await api(`/api/mensajes/${encodeURIComponent(id)}`, { method: "PATCH", body: { leido } }));
  } catch (err) {
    m.leido = anterior;
    pintarLista();
    mostrarError(err.message);
  }
}

// Anima la tarjeta (sale hacia la derecha y se cierra el hueco) y luego guarda el cambio.
async function cambiarLeido(id, leido, { avisar = false } = {}) {
  const m = st.mensajes.find((x) => x.id === id);
  if (!m) return;
  const envoltura = buscarTarjeta(id)?.parentElement;
  const sigueVisible = st.filtro === "todos";

  if (envoltura && !sinMovimiento()) {
    const el = envoltura.querySelector(".tarjeta");
    envoltura.classList.add("listo");
    if (sigueVisible) {
      envoltura.classList.add("volviendo");
      el.style.transform = "";
      await espera(450);
    } else {
      envoltura.classList.add("saliendo");
      el.style.transform = `translateX(${envoltura.offsetWidth + 40}px) rotate(4deg)`;
      await espera(DURACION_SALIDA);
      envoltura.style.height = `${envoltura.offsetHeight}px`;
      envoltura.offsetHeight; // fuerza el reflow para que la transición arranque
      envoltura.classList.add("colapsando");
      envoltura.style.height = "0px";
      envoltura.style.marginTop = `-${GAP_LISTA}px`;
      await espera(DURACION_COLAPSO);
    }
  }

  await marcar(id, leido);
  if (sigueVisible) buscarTarjeta(id)?.parentElement.classList.add("marcada");
  if (avisar) mostrarToast(leido ? "Marcado como leído" : "Marcado como no leído", () => marcar(id, !leido));
}

function buscarTarjeta(id) {
  return document.querySelector(`.tarjeta[data-id="${CSS.escape(id)}"]`);
}

let temporizadorToast = null;
function mostrarToast(texto, deshacer) {
  const toast = $("toast");
  $("toast-texto").textContent = texto;
  toast.hidden = false;
  toast.style.animation = "none";
  toast.offsetHeight;
  toast.style.animation = "";
  $("toast-deshacer").onclick = () => {
    toast.hidden = true;
    deshacer();
  };
  clearTimeout(temporizadorToast);
  temporizadorToast = setTimeout(() => { toast.hidden = true; }, 5000);
}

async function marcarHasta(timestamp) {
  try {
    await api(`/api/streams/${st.streamId}/marcar-hasta`, { method: "POST", body: { timestamp } });
    st.mensajes = await api(`/api/streams/${st.streamId}/mensajes`);
    pintarLista();
  } catch (err) {
    mostrarError(err.message);
  }
}

function seleccionar(id, desplazar = false) {
  st.seleccion = id;
  for (const el of document.querySelectorAll(".tarjeta")) {
    el.classList.toggle("seleccionada", el.dataset.id === id);
    if (el.dataset.id === id && desplazar) {
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }
}

function mover(delta) {
  const items = visibles();
  if (!items.length) return;
  const i = items.findIndex((m) => m.id === st.seleccion);
  const j = i < 0 ? 0 : Math.max(0, Math.min(items.length - 1, i + delta));
  seleccionar(items[j].id, true);
}

async function leerYSeguir() {
  const items = visibles();
  if (!items.length) return;
  let i = items.findIndex((m) => m.id === st.seleccion);
  if (i < 0) i = 0;
  const actual = items[i];
  // Elegimos el siguiente antes de marcar, porque en "Sin leer" la tarjeta desaparece.
  const siguiente = items[i + 1] ?? (st.filtro === "sin-leer" ? items[i - 1] : actual);
  if (!actual.leido) await cambiarLeido(actual.id, true);
  if (siguiente) seleccionar(siguiente.id, true);
}

function irAlPrimeroSinLeer() {
  const primero = st.mensajes.find((m) => !m.leido);
  if (!primero) return;
  if (!visibles().includes(primero)) cambiarFiltro("sin-leer");
  seleccionar(primero.id, true);
}

function cambiarFiltro(filtro) {
  st.filtro = filtro;
  for (const b of document.querySelectorAll("[data-filtro]")) {
    b.classList.toggle("activo", b.dataset.filtro === filtro);
  }
  moverIndicador();
  st.animarEntrada = true;
  pintarLista();
}

// Pastilla roja que se desliza bajo el filtro activo.
const indicador = document.createElement("span");
indicador.className = "indicador";
document.querySelector(".filtros").prepend(indicador);
function moverIndicador() {
  const activo = document.querySelector("[data-filtro].activo");
  if (!activo || !activo.offsetWidth) return;
  indicador.style.width = `${activo.offsetWidth}px`;
  indicador.style.transform = `translateX(${activo.offsetLeft}px)`;
}
addEventListener("resize", moverIndicador);
document.fonts?.ready.then(moverIndicador);

// ---------- Resumen ----------
// "20,00 US$", "$5.00", "CLP 2.000" -> { valor, moneda }
function leerMonto(texto) {
  const num = texto?.match(/\d[\d.,\s ]*/);
  if (!num) return null;
  const s = num[0].replace(/[\s ]/g, "").replace(/[.,]$/, "");
  const sep = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  const conDecimales = sep >= 0 && s.length - sep - 1 <= 2;
  const valor = conDecimales
    ? Number(`${s.slice(0, sep).replace(/[.,]/g, "")}.${s.slice(sep + 1)}`)
    : Number(s.replace(/[.,]/g, ""));
  const moneda = texto.replace(num[0], "").trim() || "¤";
  return Number.isFinite(valor) ? { valor, moneda } : null;
}

const dinero = (valor, moneda) => `${formatoNumero.format(valor)} ${moneda}`;

function pintarResumen() {
  $("resumen").hidden = !st.stream;
  if (!st.stream) return;

  const total = st.mensajes.length;
  const sinLeer = st.mensajes.filter((m) => !m.leido).length;
  ponerCifra("r-sin-leer", sinLeer);
  ponerCifra("r-leidos", total - sinLeer);
  ponerCifra("r-total", total);
  $("r-progreso").style.width = total ? `${((total - sinLeer) / total) * 100}%` : "0";

  // Los montos vienen en la moneda de quien dona; se suman por moneda, sin convertir.
  const montos = new Map(st.mensajes.map((m) => [m.id, leerMonto(m.monto_texto)]));
  const porMoneda = new Map();
  for (const monto of montos.values()) {
    if (!monto) continue;
    const g = porMoneda.get(monto.moneda) ?? { suma: 0, n: 0 };
    g.suma += monto.valor;
    g.n++;
    porMoneda.set(monto.moneda, g);
  }
  const monedas = [...porMoneda].sort((a, b) => b[1].n - a[1].n);
  const principal = monedas[0]?.[0];

  const porAutor = new Map();
  let mayor = null;
  for (const m of st.mensajes) {
    const a = porAutor.get(m.autor) ?? { suma: 0, n: 0 };
    a.n++;
    const monto = montos.get(m.id);
    if (monto?.moneda === principal) {
      a.suma += monto.valor;
      if (!mayor || monto.valor > montos.get(mayor.id).valor) mayor = m;
    }
    porAutor.set(m.autor, a);
  }

  $("r-montos").replaceChildren(
    ...(monedas.length
      ? monedas.slice(0, 4).map(([moneda, g]) => {
          const li = document.createElement("li");
          li.textContent = dinero(g.suma, moneda);
          const small = document.createElement("small");
          small.textContent = `${g.n} aporte${g.n === 1 ? "" : "s"}`;
          li.append(small);
          return li;
        })
      : [vacioResumen("Todavía nada")]),
  );

  ponerCifra("r-chats", st.mensajes.filter((m) => m.tipo !== "sticker").length);
  ponerCifra("r-stickers", st.mensajes.filter((m) => m.tipo === "sticker").length);
  const ultimo = st.mensajes.at(-1);
  $("r-ritmo").textContent = ultimo ? `Último: ${formatoHora.format(new Date(ultimo.timestamp))}` : "—";

  const top = [...porAutor].sort((a, b) => b[1].suma - a[1].suma || b[1].n - a[1].n).slice(0, 5);
  $("r-top").replaceChildren(
    ...top.map(([autor, a]) => {
      const li = document.createElement("li");
      const cifra = a.suma ? dinero(a.suma, principal) : `${a.n}×`;
      li.append(span("nombre", autor), span("cifra", a.n > 1 && a.suma ? `${cifra} (${a.n})` : cifra));
      return li;
    }),
  );
  if (!top.length) $("r-top").append(vacioResumen("Sin aportes aún"));

  const caja = $("r-mayor");
  if (mayor) {
    const quien = document.createElement("div");
    quien.textContent = mayor.autor;
    caja.replaceChildren(span("monto-grande", mayor.monto_texto), quien);
    if (mayor.texto) {
      const p = document.createElement("p");
      p.textContent = mayor.texto;
      caja.append(p);
    }
  } else {
    caja.replaceChildren(vacioResumen("—"));
  }
}

// Actualiza un número del resumen con un pequeño salto cuando cambia.
function ponerCifra(id, valor) {
  if (st.resumenPrevio[id] === valor) return;
  const habia = id in st.resumenPrevio;
  st.resumenPrevio[id] = valor;
  const el = $(id);
  el.textContent = valor;
  if (!habia) return;
  el.classList.remove("salto");
  el.offsetWidth;
  el.classList.add("salto");
}

function vacioResumen(texto) {
  const p = document.createElement("p");
  p.className = "r-vacio";
  p.textContent = texto;
  return p;
}

function mostrarError(texto) {
  const el = $("error");
  el.textContent = texto;
  el.hidden = !texto;
}

// ---------- Eventos de la interfaz ----------
$("form-url").addEventListener("submit", async (e) => {
  e.preventDefault();
  mostrarError("");
  const boton = e.submitter;
  boton.disabled = true;
  try {
    const stream = await api("/api/streams", { method: "POST", body: { url: $("input-url").value } });
    $("input-url").value = "";
    await abrirStream(stream.id);
  } catch (err) {
    mostrarError(err.message);
  } finally {
    boton.disabled = false;
  }
});

$("select-stream").addEventListener("change", (e) => abrirStream(e.target.value));

$("btn-detener").addEventListener("click", async () => {
  st.stream = await api(`/api/streams/${st.streamId}/stop`, { method: "POST" });
  pintarStream();
});

$("btn-primero").addEventListener("click", irAlPrimeroSinLeer);

for (const b of document.querySelectorAll("[data-filtro]")) {
  b.addEventListener("click", () => cambiarFiltro(b.dataset.filtro));
}

$("resumen-barra").addEventListener("click", () => {
  const abierto = $("resumen").classList.toggle("abierto");
  $("resumen-barra").setAttribute("aria-expanded", String(abierto));
});

document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, select, textarea") || e.ctrlKey || e.metaKey || e.altKey) return;
  if (!st.stream) return;
  const tecla = e.key.toLowerCase();
  if (tecla === "j") mover(1);
  else if (tecla === "k") mover(-1);
  else if (tecla === " ") leerYSeguir();
  else if (tecla === "u" && st.seleccion) cambiarLeido(st.seleccion, false);
  else return;
  e.preventDefault();
});

// ---------- Inicio ----------
await cargarListaStreams();
const inicial = location.hash.slice(1);
if (inicial) abrirStream(inicial).catch(() => history.replaceState(null, "", location.pathname));
