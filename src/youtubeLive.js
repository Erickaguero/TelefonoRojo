// Acceso de bajo nivel al chat en vivo de YouTube, igual que lo hace el navegador
// (endpoint interno "youtubei"). No es una API oficial: si YouTube cambia el
// formato, este es el único archivo que hay que ajustar.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "es-419,es;q=0.9",
  // Evita la página de consentimiento de cookies en algunas regiones.
  Cookie: "SOCS=CAI",
};

export class ErrorYouTube extends Error {
  constructor(message, { final = false } = {}) {
    super(message);
    this.final = final;
  }
}

/** Abre la página del video y obtiene lo necesario para leer el chat. */
export async function obtenerSesion(videoId) {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers: HEADERS });
  if (!res.ok) throw new ErrorYouTube(`YouTube respondió ${res.status}`);
  const html = await res.text();

  let titulo =
    cadenaJson(html, /"videoDetails":\{"videoId":"[^"]+","title":"((?:[^"\\]|\\.)*)"/) ??
    entidades(html.match(/<meta name="title" content="([^"]*)"/)?.[1]);
  let canal = cadenaJson(html, /"ownerChannelName":"((?:[^"\\]|\\.)*)"/);
  if (!titulo || !canal) {
    const oembed = await infoOembed(videoId);
    titulo ||= oembed?.title ?? null;
    canal ||= oembed?.author_name ?? null;
  }
  const enVivo = /"isLive":true|"isLiveNow":true/.test(html);
  const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  const clientVersion = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1];
  // La primera continuación es la del chat principal ("Chat destacado"),
  // donde siempre aparecen los Super Chats.
  const continuation = html.match(/"liveChatRenderer":\{"continuations":\[\{"reloadContinuationData":\{"continuation":"([^"]+)"/)?.[1];

  const info = { titulo, canal, enVivo };
  if (!apiKey || !clientVersion) throw new ErrorYouTube("No se pudo leer la página de YouTube", { final: false });
  if (!enVivo || !continuation) {
    const terminado = /"isLiveContent":true/.test(html) && !enVivo;
    throw Object.assign(
      new ErrorYouTube(
        terminado ? "El directo no está en vivo (terminó o aún no empieza)" : "No es un directo con chat en vivo disponible",
        { final: true },
      ),
      { info, terminado },
    );
  }
  return { ...info, apiKey, clientVersion, continuation };
}

/**
 * Pide el siguiente bloque del chat.
 * Devuelve { destacados, continuation, esperaMs, fin }: los Super Chats,
 * Super Stickers y mensajes de hito de membresía de ese bloque.
 */
export async function pedirChat(sesion) {
  const res = await fetch(
    `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${sesion.apiKey}&prettyPrint=false`,
    {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        context: { client: { clientName: "WEB", clientVersion: sesion.clientVersion, hl: "es" } },
        continuation: sesion.continuation,
      }),
    },
  );
  if (!res.ok) throw new ErrorYouTube(`El chat respondió ${res.status}`);
  const datos = await res.json();
  const chat = datos.continuationContents?.liveChatContinuation;
  const cont = chat?.continuations?.[0];
  const siguiente = cont?.invalidationContinuationData ?? cont?.timedContinuationData ?? cont?.reloadContinuationData;
  if (!chat || !siguiente?.continuation) {
    return { destacados: [], continuation: null, esperaMs: 0, fin: true };
  }

  const destacados = [];
  for (const accion of chat.actions ?? []) {
    for (const item of itemsDestacados(accion)) {
      const m = normalizar(item);
      if (m) destacados.push(m);
    }
  }
  return {
    destacados,
    continuation: siguiente.continuation,
    esperaMs: Math.min(Math.max(siguiente.timeoutMs ?? 3000, 1500), 10000),
    fin: false,
  };
}

const COLOR_MIEMBRO = "#0F9D58"; // el verde con que YouTube muestra los hitos de membresía

/** Los items del chat que nos interesan; cada uno trae un solo renderer. */
function* itemsDestacados(accion) {
  const item = accion.addChatItemAction?.item;
  if (item) yield item;

  // La "cinta" de arriba del chat conserva Super Chats e hitos enviados antes
  // de conectarnos; así recuperamos algunos que se habrían perdido.
  const ticker = accion.addLiveChatTickerItemAction?.item;
  const interno = (
    ticker?.liveChatTickerPaidMessageItemRenderer ??
    ticker?.liveChatTickerPaidStickerItemRenderer ??
    ticker?.liveChatTickerSponsorItemRenderer
  )?.showItemEndpoint?.showLiveChatItemEndpoint?.renderer;
  if (interno) yield interno;
}

function normalizar(item) {
  const pagado = item.liveChatPaidMessageRenderer;
  const sticker = item.liveChatPaidStickerRenderer;
  // Los avisos de "nuevo miembro" usan el mismo renderer pero sin headerPrimaryText
  // ("Miembro durante 6 meses"); solo nos quedamos con los hitos.
  const hito = item.liveChatMembershipItemRenderer?.headerPrimaryText ? item.liveChatMembershipItemRenderer : null;
  const r = pagado ?? sticker ?? hito;
  if (!r?.id) return null;

  const base = {
    id: r.id,
    autor: r.authorName?.simpleText || "Anónimo",
    avatar_url: absoluta(ultima(r.authorPhoto?.thumbnails)?.url),
    texto: textoDe(r.message) || null,
    sticker_url: null,
    miembro_meses: mesesDeMiembro(r),
    timestamp: r.timestampUsec ? Math.floor(Number(r.timestampUsec) / 1000) : Date.now(),
  };
  if (hito) {
    return { ...base, tipo: "miembro", monto_texto: null, color: COLOR_MIEMBRO };
  }
  if (sticker) {
    return {
      ...base,
      tipo: "sticker",
      monto_texto: r.purchaseAmountText?.simpleText ?? null,
      color: colorHex(r.backgroundColor ?? r.moneyChipBackgroundColor),
      sticker_url: absoluta(ultima(r.sticker?.thumbnails)?.url),
    };
  }
  return {
    ...base,
    tipo: "superchat",
    monto_texto: r.purchaseAmountText?.simpleText ?? null,
    color: colorHex(r.headerBackgroundColor ?? r.bodyBackgroundColor),
  };
}

function textoDe(t) {
  if (!t) return "";
  if (t.simpleText) return t.simpleText.trim();
  return (t.runs ?? [])
    .map((run) => run.text ?? run.emoji?.shortcuts?.[0] ?? run.emoji?.emojiId ?? "")
    .join("")
    .trim();
}

/**
 * Meses como miembro del canal, o null si no es miembro. En un hito sale del
 * encabezado ("Miembro durante 14 meses"); si no, de la insignia de miembro
 * ("Miembro (2 meses)", "Miembro (1 año)", "Miembro nuevo"). Las insignias de
 * miembro son las que traen imagen propia del canal (customThumbnail).
 */
function mesesDeMiembro(r) {
  const deHito = mesesEn(textoDe(r.headerPrimaryText));
  if (deHito != null) return deHito;
  for (const b of r.authorBadges ?? []) {
    const insignia = b.liveChatAuthorBadgeRenderer;
    if (!insignia?.customThumbnail) continue;
    const meses = mesesEn(insignia.tooltip ?? insignia.accessibility?.accessibilityData?.label);
    if (meses != null) return meses;
  }
  return null;
}

function mesesEn(texto) {
  if (!texto) return null;
  const m = texto.match(/(\d+)\s*(mes|month|año|ano|year)/i);
  if (m) return /año|ano|year/i.test(m[2]) ? Number(m[1]) * 12 : Number(m[1]);
  if (/nuev|new/i.test(texto)) return 0;
  return null;
}

function ultima(lista) {
  return Array.isArray(lista) && lista.length ? lista[lista.length - 1] : null;
}

function absoluta(url) {
  if (!url) return null;
  return url.startsWith("//") ? `https:${url}` : url;
}

function colorHex(n) {
  if (typeof n !== "number") return null;
  return `#${(n & 0xffffff).toString(16).padStart(6, "0").toUpperCase()}`;
}

async function infoOembed(videoId) {
  try {
    const url = encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`);
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${url}`, { headers: HEADERS });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

function entidades(texto) {
  if (!texto) return null;
  return texto
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function cadenaJson(html, regex) {
  const crudo = html.match(regex)?.[1];
  if (crudo == null) return null;
  try {
    return JSON.parse(`"${crudo}"`);
  } catch {
    return crudo;
  }
}
