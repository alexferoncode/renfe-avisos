// Comprueba si los trenes de la lista tienen plazas de clase Estándar en Renfe
// y avisa por Telegram cuando alguno pasa a estar disponible.
//
// Variables de entorno:
//   TRENES            JSON: [{"fecha":"2026-10-02","origen":"60000","destino":"60600","hora":"14:27"}, ...]
//   TELEGRAM_TOKEN    token del bot (de @BotFather)
//   TELEGRAM_CHAT_ID  tu id de Telegram (de @userinfobot)
//   ESTADO_PATH       dónde guardar el estado entre ejecuciones (por defecto .estado/estado.json)
//   CHROME_CHANNEL    canal de Chrome para Playwright (por defecto "chrome")
//   DRY_RUN=1         no envía nada a Telegram, solo lo muestra

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const ESTACIONES = {
  '60000': { clave: '0071,60000,00600', nombre: 'MADRID-PUERTA DE ATOCHA-ALMUDENA GRANDES', corto: 'Atocha' },
  '17000': { clave: '0071,17000,17000', nombre: 'MADRID-CHAMARTIN-CLARA CAMPOAMOR', corto: 'Chamartín' },
  '60600': { clave: '0071,60600,60600', nombre: 'ALBACETE-LOS LLANOS', corto: 'Albacete' },
};

const ESTADO_PATH = process.env.ESTADO_PATH || '.estado/estado.json';
const DRY_RUN = process.env.DRY_RUN === '1';
const AVISAR_FALLO_TRAS = 6; // ejecuciones seguidas fallando (~1 h con cron cada 10 min)

function ahoraMadrid() {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map(p => [p.type, p.value]),
  );
  return { fecha: `${partes.year}-${partes.month}-${partes.day}`, hora: `${partes.hour}:${partes.minute}` };
}

const clave = t => `${t.fecha}|${t.origen}|${t.destino}|${t.hora}`;

function describir(t) {
  const d = new Date(`${t.fecha}T12:00:00Z`);
  const dia = d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${dia} · ${t.hora} ${ESTACIONES[t.origen]?.corto ?? t.origen} → ${ESTACIONES[t.destino]?.corto ?? t.destino}`;
}

function leerEstado() {
  try { return JSON.parse(fs.readFileSync(ESTADO_PATH, 'utf8')); } catch { return {}; }
}

function guardarEstado(estado) {
  fs.mkdirSync(path.dirname(ESTADO_PATH), { recursive: true });
  fs.writeFileSync(ESTADO_PATH, JSON.stringify(estado, null, 2));
}

async function telegram(texto) {
  if (DRY_RUN || !process.env.TELEGRAM_TOKEN) {
    console.log(`[telegram${DRY_RUN ? ' (dry run)' : ' sin configurar'}] ${texto}`);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: texto, parse_mode: 'HTML' }),
  });
  if (!res.ok) throw new Error(`Telegram respondió ${res.status}: ${await res.text()}`);
}

// Envía el mismo formulario que el buscador de renfe.com y devuelve la lista de trenes del día.
async function buscar(page, fecha, origen, destino) {
  const [y, m, d] = fecha.split('-');
  const f = `${d}/${m}/${y}`;
  const campos = {
    tipoBusqueda: 'autocomplete', currenLocation: 'menuBusqueda', vengoderenfecom: 'SI',
    desOrigen: ESTACIONES[origen].nombre, desDestino: ESTACIONES[destino].nombre,
    cdgoOrigen: ESTACIONES[origen].clave, cdgoDestino: ESTACIONES[destino].clave, idiomaBusqueda: 'ES',
    FechaIdaSel: f, FechaVueltaSel: '', _fechaIdaVisual: f, _fechaVueltaVisual: '',
    minPriceDeparture: 'false', minPriceReturn: 'false', adultos_: '1', ninos_: '0', ninosMenores: '0',
    codPromocional: '', plazaH: 'false', sinEnlace: 'false', conMascota: 'false', conBicicleta: 'false',
    asistencia: 'false', franjaHoraI: '', franjaHoraV: '', Idioma: 'es', Pais: 'ES',
  };
  await page.goto('about:blank');
  await page.evaluate(c => {
    const form = document.createElement('form');
    form.method = 'post';
    form.action = 'https://venta.renfe.com/vol/buscarTren.do?Idioma=es&Pais=ES';
    for (const [k, v] of Object.entries(c)) {
      const input = document.createElement('input');
      input.name = k; input.value = v;
      form.appendChild(input);
    }
    document.body.appendChild(form);
  }, campos);
  await Promise.all([
    page.waitForURL(/buscarTrenEnlaces/, { timeout: 60_000 }),
    page.evaluate(() => document.forms[0].submit()),
  ]);
  await page.waitForFunction(() => window.trenesIda && 'listviajeViewEnlaceBean' in window.trenesIda, null, { timeout: 45_000 });
  return page.evaluate(() => (window.trenesIda.listviajeViewEnlaceBean || []).map(v => ({
    hora: v.horaSalida,
    completo: v.completo,
    soloH: v.soloPlazaH,
    tarifas: (v.tarifasDisponibles || []).map(t => ({ clase: t.cdgoClase, soloH: t.soloPlazasH, titulo: t.titulo, precio: t.precioTarifa })),
  })));
}

// Disponible para el abono = alguna tarifa de clase Estándar ("T") que no sea solo plaza H.
function evaluar(trenesDelDia, hora) {
  const candidatos = trenesDelDia.filter(v => v.hora === hora);
  if (!candidatos.length) return { estado: 'no_encontrado' };
  for (const v of candidatos) {
    if (!v.completo && !v.soloH && v.tarifas.some(t => t.clase === 'T' && !t.soloH)) return { estado: 'disponible' };
  }
  return { estado: 'completo' };
}

async function main() {
  let lista;
  try { lista = JSON.parse(process.env.TRENES || '[]'); } catch { throw new Error('TRENES no es un JSON válido'); }
  const ahora = ahoraMadrid();
  const pendientes = lista.filter(t => ESTACIONES[t.origen] && ESTACIONES[t.destino]
    && (t.fecha > ahora.fecha || (t.fecha === ahora.fecha && t.hora > ahora.hora)));

  const estado = leerEstado();
  estado.trenes ??= {};
  estado.fallosSeguidos ??= 0;
  // Olvida los trenes que ya no están en la lista.
  const vivos = new Set(pendientes.map(clave));
  for (const k of Object.keys(estado.trenes)) if (!vivos.has(k)) delete estado.trenes[k];

  console.log(`${pendientes.length} tren(es) por comprobar (${lista.length - pendientes.length} ignorados por pasados o inválidos)`);
  if (!pendientes.length) { guardarEstado(estado); return; }

  // Agrupa por búsqueda (fecha + trayecto) para no repetir consultas.
  const busquedas = new Map();
  for (const t of pendientes) {
    const k = `${t.fecha}|${t.origen}|${t.destino}`;
    if (!busquedas.has(k)) busquedas.set(k, []);
    busquedas.get(k).push(t);
  }

  // Renfe devuelve error 500 si detecta el navegador como automatizado ("HeadlessChrome", navigator.webdriver).
  const browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL || 'chrome',
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  let errores = 0;
  try {
    const context = await browser.newContext({
      locale: 'es-ES',
      timezoneId: 'Europe/Madrid',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    let n = 0;
    for (const [k, trenes] of busquedas) {
      const [fecha, origen, destino] = k.split('|');
      n++;
      let delDia;
      for (let intento = 1; intento <= 2 && !delDia; intento++) {
        try { delDia = await buscar(page, fecha, origen, destino); } catch (e) {
          console.log(`búsqueda ${n}: intento ${intento} falló: ${e.message.split('\n')[0]}`);
        }
      }
      if (!delDia) {
        errores++;
        for (const t of trenes) resumen.trenes.push({ k: clave(t), e: 'error' });
        continue;
      }

      for (const t of trenes) {
        const r = evaluar(delDia, t.hora);
        const antes = estado.trenes[clave(t)];
        console.log(`tren ${t.hora}: ${r.estado}${antes && antes !== r.estado ? ` (antes: ${antes})` : ''}`);
        let avisado = false;
        if (r.estado === 'disponible' && antes !== 'disponible') {
          await telegram(`🚆 <b>¡Hay plazas!</b>\n${describir(t)}\n\nEntra en la app de Renfe y sácalo. Luego quítalo de la lista.`);
          avisado = true;
        } else if (r.estado === 'no_encontrado' && antes !== 'no_encontrado') {
          await telegram(`⚠️ No encuentro el tren de las ${t.hora} en Renfe para ${describir(t)}. ¿Ha cambiado el horario? Revisa la lista.`);
          avisado = true;
        }
        estado.trenes[clave(t)] = r.estado;
        resumen.trenes.push({ k: clave(t), e: r.estado, ...(avisado && { avisado }) });
      }
    }
  } finally {
    await browser.close();
  }

  if (errores === busquedas.size) throw new Error('todas las búsquedas fallaron');
  if (estado.avisoFallo) await telegram('✅ La comprobación de trenes vuelve a funcionar.');
  estado.fallosSeguidos = 0;
  estado.avisoFallo = false;
  guardarEstado(estado);
}

// Resumen de la ejecución para el historial de la web. Se publica como anotación de GitHub
// (la web la lee con la API de check-runs), en una sola línea de JSON.
const resumen = { trenes: [], error: null };

function publicarResumen() {
  const linea = JSON.stringify(resumen).replace(/%/g, '%25');
  if (process.env.GITHUB_ACTIONS) console.log(`::${resumen.error ? 'error' : 'notice'} title=resumen::${linea}`);
  else console.log('resumen:', linea);
}

main().then(publicarResumen, async e => {
  console.error('Error:', e.message);
  resumen.error = e.message.split('\n')[0];
  publicarResumen();
  const estado = leerEstado();
  estado.fallosSeguidos = (estado.fallosSeguidos ?? 0) + 1;
  if (estado.fallosSeguidos >= AVISAR_FALLO_TRAS && !estado.avisoFallo) {
    try {
      await telegram(`❌ La comprobación de trenes lleva ${estado.fallosSeguidos} intentos seguidos fallando (${e.message}). Mientras tanto, revisa a mano.`);
      estado.avisoFallo = true;
    } catch (err) { console.error('Tampoco pude avisar por Telegram:', err.message); }
  }
  guardarEstado(estado);
  // Salimos con 0 para no recibir un email de GitHub cada 10 minutos; el aviso va por Telegram.
});
