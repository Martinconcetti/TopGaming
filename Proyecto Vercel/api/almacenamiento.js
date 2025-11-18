// api/almacenamiento.js
const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const tough = require("tough-cookie");
const cheerio = require("cheerio");

module.exports = async (req, res) => {
  try {
    // --- CONFIG / desde ENV (configurar en Vercel) ---
    const PROVIDER_LOGIN_URL = process.env.PROVIDER_LOGIN_URL || "http://jotakp.dyndns.org/loginext.aspx";
    const USER = process.env.PROVIDER_USER;          // tu usuario (setear en Vercel)
    const PASS = process.env.PROVIDER_PASS;          // tu pass (setear en Vercel)
    const CLOUDINARY_BASE = process.env.CLOUDINARY_BASE; // e.g. https://res.cloudinary.com/tuusuario/image/upload/almacenamiento/
    // lista de categorias (puedes cambiarla aquí o por env var si querés)
    const CATEGORIES = [
      "http://jotakp.dyndns.org/buscar.aspx?idsubrubro1=14",  // Discos Externos
      "http://jotakp.dyndns.org/buscar.aspx?idsubrubro1=69",  // Discos HDD
      "http://jotakp.dyndns.org/buscar.aspx?idsubrubro1=157", // M.2
      "http://jotakp.dyndns.org/buscar.aspx?idsubrubro1=156", // Discos SSD
      "http://jotakp.dyndns.org/buscar.aspx?idsubrubro1=12",  // Tarjetas SD
      "http://jotakp.dyndns.org/buscar.aspx?idsubrubro1=5"    // Pendrive
    ];

    if (!USER || !PASS) {
      return res.status(500).json({ error: "Falta PROVIDER_USER o PROVIDER_PASS en las env vars." });
    }
    if (!CLOUDINARY_BASE) {
      return res.status(500).json({ error: "Falta CLOUDINARY_BASE en las env vars." });
    }

    // --- axios con cookie jar para mantener sesión ---
    const jar = new tough.CookieJar();
    const client = wrapper(axios.create({
      withCredentials: true,
      jar,
      headers: {
        "User-Agent": "TopGamingScraper/1.0 (+https://topgaming.example)"
      },
      timeout: 20000
    }));

    // --- 1) GET login page para tomar __VIEWSTATE, __EVENTVALIDATION, etc ---
    const getLoginPage = await client.get(PROVIDER_LOGIN_URL);
    const loginHtml = getLoginPage.data;
    const $login = cheerio.load(loginHtml);

    const viewstate = $login("input[name=__VIEWSTATE]").attr("value") || "";
    const viewstateGenerator = $login("input[name=__VIEWSTATEGENERATOR]").attr("value") || "";
    const eventValidation = $login("input[name=__EVENTVALIDATION]").attr("value") || "";

    // --- 2) POST login (form urlencoded) ---
    // Campos observados en el HTML del login: TxtEmail, TxtPass1, BtnIngresar
    const qs = (obj) => Object.keys(obj).map(k => encodeURIComponent(k) + "=" + encodeURIComponent(obj[k])).join("&");

    const payload = {
      "__VIEWSTATE": viewstate,
      "__VIEWSTATEGENERATOR": viewstateGenerator,
      "__EVENTVALIDATION": eventValidation,
      "TxtEmail": USER,
      "TxtPass1": PASS,
      "BtnIngresar": "Ingresar"
      // no incluimos ChkRecordar a menos que quieras
    };

    // POST hacia la misma ruta
    await client.post(PROVIDER_LOGIN_URL, qs(payload), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": PROVIDER_LOGIN_URL
      },
      maxRedirects: 5
    });

    // Ahora el cookiejar debe tener la cookie de sesión si el login fue correcto.
    // (No hacemos validación de éxito aquí; si es necesario podés comprobar la respuesta.)

    // --- 3) Recorremos cada categoría y parseamos productos ---
    const productos = [];

    for (const catUrl of CATEGORIES) {
      try {
        const page = await client.get(catUrl, { headers: { Referer: PROVIDER_LOGIN_URL } });
        const $ = cheerio.load(page.data);

        // Selecciona todos los articles
        $("article").each((i, el) => {
          const art = $(el);

          // ID desde el <a href="articulo.aspx?id=12345">
          const aHref = art.find("a").first().attr("href") || "";
          const idMatch = aHref.match(/id=(\d+)/);
          if (!idMatch) return; // saltear si no tiene id
          const id = idMatch[1];

          // Nombre
          const nombre = art.find(".tg-article-txt").first().text().trim() || null;

          // Precio ARS (div.tg-body-f10) -> "$ 69.787,80"
          let arsText = art.find(".tg-body-f10").first().text() || "";
          // buscar primer $ ... patrón
          const arsMatch = arsText.match(/\$\s*([\d\.\,]+)/);
          let precioARS = null;
          if (arsMatch) {
            precioARS = parseFloat(arsMatch[1].replace(/\./g, "").replace(",", "."));
          }

          if (!nombre || !precioARS) {
            return;
          }

          // Cálculo: IVA 21% y ganancia 35%
          const conIVA = precioARS * 1.21;
          const precioFinal = Math.round(conIVA * 1.35); // redondeado entero

          // Imagen Cloudinary por patrón: almacenamiento-{id}.jpg
          const imagen = ${CLOUDINARY_BASE}almacenamiento-${id}.jpg;

          productos.push({
            id: id,
            nombre: nombre,
            precioARSProveedor: precioARS,
            precioFinal: precioFinal,
            imagen: imagen,
            categoriaFuente: catUrl
          });
        });

      } catch (errCat) {
        // no frenar todo por una categoría que falle
        console.error("Error leyendo categoría:", catUrl, errCat.message || errCat);
      }
    }

    // --- 4) Cache-Control (opcional): permitimos edge cache en Vercel
    // ajustar s-maxage según lo que quieras (ej. 300s)
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=120");

    return res.json(productos);

  } catch (err) {
    console.error("ERROR API:", err && err.stack ? err.stack : err);
    return res.status(500).json({ error: "Error interno", detail: err.message || String(err) });
  }
};