// Tormentas cerca de una ubicación, a partir de los rayos del satélite GOES-19 (GLM).
// Agrupa los rayos de los últimos 20 minutos en "tormentas", estima hacia dónde
// se mueven y calcula si llegan a la ubicación (por defecto, Pilar).

const BUCKET = "https://noaa-goes19.s3.amazonaws.com";
const VENTANA_MIN = 20;      // cuántos minutos hacia atrás miramos
const RADIO_KM = 350;        // solo rayos a menos de esta distancia de la ubicación
const CELDA_KM = 30;         // tamaño de la grilla para agrupar rayos
const MIN_RAYOS_TORMENTA = 12;

function diaDelAnio(d) {
  return Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000);
}

async function listarHora(fecha) {
  const dia = String(diaDelAnio(fecha)).padStart(3, "0");
  const hora = String(fecha.getUTCHours()).padStart(2, "0");
  const prefijo = `GLM-L2-LCFA/${fecha.getUTCFullYear()}/${dia}/${hora}/`;
  const r = await fetch(`${BUCKET}/?list-type=2&prefix=${prefijo}`);
  const xml = await r.text();
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
}

// OR_GLM-L2-LCFA_G19_s20262951738000_e... -> milisegundos UTC del inicio del archivo
function inicioDeClave(clave) {
  const m = clave.match(/_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(\d)_/);
  if (!m) return null;
  return Date.UTC(+m[1], 0, 1) + (+m[2] - 1) * 86400000 + (+m[3]) * 3600000 + (+m[4]) * 60000 + (+m[5]) * 1000 + (+m[6]) * 100;
}

function leer(f, nombre) {
  const ds = f.get(nombre);
  if (!ds) return null;
  const v = Array.from(ds.value);
  const sf = ds.attrs && ds.attrs.scale_factor ? Number(ds.attrs.scale_factor.value) : null;
  const off = ds.attrs && ds.attrs.add_offset ? Number(ds.attrs.add_offset.value) : null;
  if (sf !== null || off !== null) return v.map((x) => x * (sf === null ? 1 : sf) + (off === null ? 0 : off));
  return v;
}

function rumbo(vx, vy) {
  // dirección HACIA donde se mueve
  const grados = (Math.atan2(vx, vy) * 180) / Math.PI;
  const g = (grados + 360) % 360;
  const nombres = ["norte", "noreste", "este", "sudeste", "sur", "sudoeste", "oeste", "noroeste"];
  return nombres[Math.round(g / 45) % 8];
}

function media(a) { return a.reduce((s, x) => s + x, 0) / a.length; }

module.exports = async (req, res) => {
  const t0 = Date.now();
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
  const lat0 = parseFloat((req.query && req.query.lat) || "-34.46");
  const lon0 = parseFloat((req.query && req.query.lon) || "-58.91");
  const kmLon = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  const kmLat = 110.57;

  const salida = { ubicacion: { lat: lat0, lon: lon0 } };
  try {
    const ahora = Date.now();
    const desde = ahora - VENTANA_MIN * 60000;

    // 1) archivos de rayos de la última ventana
    const horas = [new Date(ahora), new Date(ahora - 3600000)];
    const listas = await Promise.all(horas.map(listarHora));
    const claves = [].concat(...listas)
      .map((k) => ({ k, t: inicioDeClave(k) }))
      .filter((x) => x.t !== null && x.t >= desde - 20000)
      .sort((a, b) => a.t - b.t);
    salida.archivos = claves.length;
    if (!claves.length) throw new Error("No encontré archivos de rayos recientes");
    salida.ultimoArchivoHace_s = Math.round((ahora - claves[claves.length - 1].t) / 1000);

    // 2) descarga en paralelo (de a 12)
    const bufs = new Array(claves.length);
    for (let i = 0; i < claves.length; i += 12) {
      const lote = claves.slice(i, i + 12);
      const res2 = await Promise.all(
        lote.map(async (c) => new Uint8Array(await (await fetch(`${BUCKET}/${c.k}`)).arrayBuffer()))
      );
      res2.forEach((b, j) => (bufs[i + j] = b));
    }

    // 3) abrir cada archivo y quedarnos con los rayos cercanos
    const h5wasm = await import("h5wasm/node");
    await h5wasm.ready;
    try { h5wasm.FS.mkdir("/tmp"); } catch (e) {}
    const rayos = []; // {x, y, t} en km respecto de la ubicación, t en ms
    for (let i = 0; i < claves.length; i++) {
      const ruta = "/tmp/glm.nc";
      h5wasm.FS.writeFile(ruta, bufs[i]);
      const f = new h5wasm.File(ruta, "r");
      const la = leer(f, "flash_lat");
      const lo = leer(f, "flash_lon");
      if (la && lo) {
        for (let j = 0; j < la.length; j++) {
          const x = (lo[j] - lon0) * kmLon;
          const y = (la[j] - lat0) * kmLat;
          if (x * x + y * y <= RADIO_KM * RADIO_KM) rayos.push({ x, y, t: claves[i].t + 10000 });
        }
      }
      f.close();
      try { h5wasm.FS.unlink(ruta); } catch (e) {}
    }
    salida.rayosCercanos = rayos.length;

    // 4) agrupar en tormentas (grilla + vecinos)
    const celdas = new Map();
    rayos.forEach((r, idx) => {
      const key = Math.floor(r.x / CELDA_KM) + "," + Math.floor(r.y / CELDA_KM);
      if (!celdas.has(key)) celdas.set(key, []);
      celdas.get(key).push(idx);
    });
    const activas = new Set([...celdas.entries()].filter(([, v]) => v.length >= 2).map(([k]) => k));
    const visto = new Set();
    const grupos = [];
    for (const k of activas) {
      if (visto.has(k)) continue;
      const pila = [k];
      visto.add(k);
      const miembros = [];
      while (pila.length) {
        const cur = pila.pop();
        miembros.push(...celdas.get(cur));
        const [cx, cy] = cur.split(",").map(Number);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const nk = cx + dx + "," + (cy + dy);
          if (activas.has(nk) && !visto.has(nk)) { visto.add(nk); pila.push(nk); }
        }
      }
      if (miembros.length >= MIN_RAYOS_TORMENTA) grupos.push(miembros);
    }

    // 5) para cada tormenta: posición actual, velocidad y llegada
    const corte = ahora - (VENTANA_MIN / 2) * 60000;
    const tormentas = grupos.map((idxs) => {
      const pts = idxs.map((i) => rayos[i]);
      const nuevos = pts.filter((p) => p.t >= corte);
      const viejos = pts.filter((p) => p.t < corte);
      const base = nuevos.length >= 4 ? nuevos : pts;
      const cx = media(base.map((p) => p.x));
      const cy = media(base.map((p) => p.y));
      const rms = Math.sqrt(media(base.map((p) => (p.x - cx) ** 2 + (p.y - cy) ** 2)));
      const radio = Math.min(30, Math.max(8, rms * 1.5));
      const distancia = Math.hypot(cx, cy);

      let vx = null, vy = null, rapidez = null;
      if (nuevos.length >= 4 && viejos.length >= 4) {
        const dtH = (media(nuevos.map((p) => p.t)) - media(viejos.map((p) => p.t))) / 3600000;
        if (dtH > 0.05) {
          vx = (cx - media(viejos.map((p) => p.x))) / dtH;
          vy = (cy - media(viejos.map((p) => p.y))) / dtH;
          rapidez = Math.hypot(vx, vy);
          if (rapidez > 110) { vx = vy = rapidez = null; } // poco confiable
        }
      }

      const t = {
        rayos: pts.length,
        rayosUltimos10min: nuevos.length,
        distanciaKm: Math.round(distancia),
        radioKm: Math.round(radio),
        posicionKm: { este: Math.round(cx), norte: Math.round(cy) },
        rapidezKmh: rapidez === null ? null : Math.round(rapidez),
        haciaDonde: rapidez === null || rapidez < 5 ? null : rumbo(vx, vy),
      };

      if (distancia <= radio) {
        t.estado = "sobre";
      } else if (rapidez === null) {
        t.estado = "sin_direccion_clara";
      } else if (rapidez < 5) {
        t.estado = "casi_estacionaria";
      } else {
        const v2 = vx * vx + vy * vy;
        const cv = cx * vx + cy * vy;
        const disc = cv * cv - v2 * (cx * cx + cy * cy - radio * radio);
        if (disc >= 0) {
          const t1 = (-cv - Math.sqrt(disc)) / v2; // horas hasta tocar el radio de la tormenta
          if (t1 > 0 && t1 <= 3) { t.estado = "se_acerca"; t.llegaEnMin = Math.max(1, Math.round(t1 * 60)); }
          else if (t1 > 3) t.estado = "lejos_aun";
          else t.estado = "se_aleja";
        } else {
          const tmin = Math.max(0, -cv / v2);
          t.estado = cv < 0 ? "pasa_de_largo" : "se_aleja";
          if (cv < 0) t.pasaAKm = Math.round(Math.hypot(cx + vx * tmin, cy + vy * tmin));
        }
      }
      return t;
    }).sort((a, b) => a.distanciaKm - b.distanciaKm);

    salida.tormentas = tormentas.slice(0, 6);

    // 6) resumen para la ubicación
    const sobre = tormentas.find((t) => t.estado === "sobre");
    const viene = tormentas.filter((t) => t.estado === "se_acerca").sort((a, b) => a.llegaEnMin - b.llegaEnMin)[0];
    salida.resumen = sobre
      ? { estado: "sobre", distanciaKm: sobre.distanciaKm }
      : viene
      ? { estado: "se_acerca", llegaEnMin: viene.llegaEnMin, distanciaKm: viene.distanciaKm, haciaDonde: viene.haciaDonde, rapidezKmh: viene.rapidezKmh }
      : tormentas.length
      ? { estado: "hay_tormentas_pero_no_llegan", masCercanaKm: tormentas[0].distanciaKm }
      : { estado: "sin_tormentas" };
  } catch (e) {
    salida.error = String(e && e.message ? e.message : e);
    salida.detalle = String(e && e.stack ? e.stack : "").split("\n").slice(0, 4).join(" | ");
  }
  salida.tardoMs = Date.now() - t0;
  res.status(200).json(salida);
};
