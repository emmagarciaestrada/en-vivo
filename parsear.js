// Prueba 2: abrir un archivo de rayos del satélite GOES-19 y contar los rayos cerca de Pilar.

const BUCKET = "https://noaa-goes19.s3.amazonaws.com";
const PILAR = { lat: -34.46, lon: -58.91 };

function diaDelAnio(d) {
  return Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000);
}

async function ultimoArchivo() {
  for (let atras = 0; atras < 3; atras++) {
    const f = new Date(Date.now() - atras * 3600000);
    const dia = String(diaDelAnio(f)).padStart(3, "0");
    const hora = String(f.getUTCHours()).padStart(2, "0");
    const prefijo = `GLM-L2-LCFA/${f.getUTCFullYear()}/${dia}/${hora}/`;
    const r = await fetch(`${BUCKET}/?list-type=2&prefix=${prefijo}`);
    const claves = [...(await r.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
    if (claves.length) return claves[claves.length - 1];
  }
  return null;
}

function km(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
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

module.exports = async (req, res) => {
  const salida = { hora: new Date().toISOString() };
  res.setHeader("Cache-Control", "no-store");
  try {
    const clave = await ultimoArchivo();
    salida.archivo = clave;
    if (!clave) throw new Error("No encontré archivos de rayos");

    const buf = new Uint8Array(await (await fetch(`${BUCKET}/${clave}`)).arrayBuffer());

    const h5wasm = await import("h5wasm/node");
    await h5wasm.ready;
    try { h5wasm.FS.mkdir("/tmp"); } catch (e) {}
    const ruta = "/tmp/glm.nc";
    h5wasm.FS.writeFile(ruta, buf);
    const f = new h5wasm.File(ruta, "r");
    salida.variables = f.keys().slice(0, 40);

    const lat = leer(f, "flash_lat");
    const lon = leer(f, "flash_lon");
    if (!lat || !lon) throw new Error("No encontré flash_lat / flash_lon en el archivo");
    salida.rayosEnElArchivo = lat.length;

    const cerca = { km100: 0, km200: 0, km300: 0, km500: 0 };
    lat.forEach((la, i) => {
      const d = km(PILAR.lat, PILAR.lon, la, lon[i]);
      if (d <= 100) cerca.km100++;
      if (d <= 200) cerca.km200++;
      if (d <= 300) cerca.km300++;
      if (d <= 500) cerca.km500++;
    });
    salida.cercaDePilar = cerca;
    salida.ejemplo = lat.slice(0, 3).map((la, i) => ({ lat: Number(la.toFixed(2)), lon: Number(lon[i].toFixed(2)) }));
    f.close();
  } catch (e) {
    salida.error = String(e && e.message ? e.message : e);
    salida.detalle = String(e && e.stack ? e.stack : "").split("\n").slice(0, 4).join(" | ");
  }
  res.status(200).json(salida);
};
