// Lee los avisos a corto plazo del SMN (feed oficial CAP) y los devuelve ordenados.
// Fuente: Servicio Meteorológico Nacional, licencia CC BY 4.0.

const FEED = "https://www3.smn.gob.ar/feeds/CAP/avisocortoplazo/rss_acpCAP.xml";

function limpiar(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function campo(bloque, nombre) {
  const m = bloque.match(new RegExp("<" + nombre + "[^>]*>([\\s\\S]*?)</" + nombre + ">"));
  return m ? limpiar(m[1]) : "";
}

// "2026_10_22_1641_cap_es.xml" -> fecha en UTC
function emitidoDesdeLink(link) {
  const m = link.match(/(\d{4})_(\d{2})_(\d{2})_(\d{2})(\d{2})_cap/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])).toISOString();
}

// "Afectando ... Departamentos: SANTA FE: A - B.CORDOBA: C." -> [{provincia, partidos}]
function zonasDesdeDescripcion(desc) {
  const i = desc.indexOf("Departamentos:");
  const texto = i >= 0 ? desc.slice(i + "Departamentos:".length).trim() : desc;
  return texto
    .split(/\.(?=[A-ZÑ]{2,})/)
    .map((trozo) => {
      const k = trozo.indexOf(":");
      if (k < 0) return null;
      return {
        provincia: trozo.slice(0, k).trim(),
        partidos: trozo.slice(k + 1).replace(/\.$/, "").split(" - ").map((p) => p.trim()).filter(Boolean),
      };
    })
    .filter(Boolean);
}

module.exports = async (req, res) => {
  try {
    const r = await fetch(FEED, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; en-vivo/1.0)", Accept: "application/xml, text/xml" },
    });
    if (!r.ok) throw new Error("El SMN respondió " + r.status);
    const xml = await r.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    const avisos = items.map((b) => {
      const titulo = campo(b, "title");
      const link = campo(b, "link");
      const descripcion = campo(b, "description");
      return {
        titulo,
        descripcion,
        link,
        emitido: emitidoDesdeLink(link),
        granizo: /GRANIZO/i.test(titulo),
        zonas: zonasDesdeDescripcion(descripcion),
      };
    });
    avisos.sort((a, b) => String(b.emitido).localeCompare(String(a.emitido)));
    res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=300");
    res.status(200).json({
      actualizado: campo(xml, "lastBuildDate"),
      fuente: "Servicio Meteorológico Nacional (SMN), CC BY 4.0",
      avisos,
    });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: String(e && e.message ? e.message : e) });
  }
};
