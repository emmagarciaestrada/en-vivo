// Prueba: ¿podemos leer los rayos del satélite GOES-19 (GLM) desde Vercel?
// Lista los archivos más recientes del bucket público de NOAA y baja el último.

const BUCKET = "https://noaa-goes19.s3.amazonaws.com";

function diaDelAnio(d) {
  const inicio = Date.UTC(d.getUTCFullYear(), 0, 0);
  return Math.floor((d.getTime() - inicio) / 86400000);
}

async function listar(fecha) {
  const anio = fecha.getUTCFullYear();
  const dia = String(diaDelAnio(fecha)).padStart(3, "0");
  const hora = String(fecha.getUTCHours()).padStart(2, "0");
  const prefijo = `GLM-L2-LCFA/${anio}/${dia}/${hora}/`;
  const r = await fetch(`${BUCKET}/?list-type=2&prefix=${prefijo}`);
  const xml = await r.text();
  const claves = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
  return { estado: r.status, prefijo, claves };
}

module.exports = async (req, res) => {
  const salida = { hora: new Date().toISOString() };
  try {
    let ahora = new Date();
    let lista = await listar(ahora);
    if (!lista.claves.length) {
      ahora = new Date(ahora.getTime() - 3600000);
      lista = await listar(ahora);
    }
    salida.listado = {
      estado: lista.estado,
      carpeta: lista.prefijo,
      cantidad: lista.claves.length,
      ultimo: lista.claves[lista.claves.length - 1] || null,
    };
    if (lista.claves.length) {
      const clave = lista.claves[lista.claves.length - 1];
      const t = Date.now();
      const r = await fetch(`${BUCKET}/${clave}`);
      const buf = Buffer.from(await r.arrayBuffer());
      salida.descarga = {
        estado: r.status,
        bytes: buf.length,
        ms: Date.now() - t,
        // los archivos NetCDF4 empiezan con la firma HDF5: 89 48 44 46
        firmaHDF5: buf.slice(1, 4).toString("ascii") === "HDF",
      };
    }
  } catch (e) {
    salida.error = String(e && e.message ? e.message : e);
  }
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(salida);
};
