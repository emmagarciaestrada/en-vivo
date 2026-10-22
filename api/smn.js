// Prueba de fuentes de alertas del SMN.
// Intenta leer cada dirección y cuenta qué respondió.

const FUENTES = [
  { nombre: "Alertas (servicio ws1, tipo AL)", url: "https://ws1.smn.gob.ar/v1/alerts/type/AL" },
  { nombre: "Alertas a corto plazo (ws1, tipo AC)", url: "https://ws1.smn.gob.ar/v1/alerts/type/AC" },
  { nombre: "Alertas (servicio ws, tipo AL)", url: "https://ws.smn.gob.ar/alerts/type/AL" },
  { nombre: "Página oficial de alertas", url: "https://www.smn.gob.ar/alertas" },
];

async function probar(fuente) {
  const inicio = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(fuente.url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; prueba-alertas/1.0)",
        Accept: "application/json, text/html;q=0.8, */*;q=0.5",
      },
    });
    const texto = await r.text();
    return {
      nombre: fuente.nombre,
      url: fuente.url,
      ok: r.ok,
      estado: r.status,
      tipo: r.headers.get("content-type") || "",
      tamano: texto.length,
      ms: Date.now() - inicio,
      muestra: texto.slice(0, 400),
    };
  } catch (e) {
    return {
      nombre: fuente.nombre,
      url: fuente.url,
      ok: false,
      estado: 0,
      error: String(e && e.message ? e.message : e),
      ms: Date.now() - inicio,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  const resultados = await Promise.all(FUENTES.map(probar));
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ hora: new Date().toISOString(), resultados });
};
