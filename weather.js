const https = require('https');

// WMO weather code → { emoji, label }
const WMO = {
  0:  ['☀',  'Despejado'],
  1:  ['🌤', 'Mayormente despejado'],
  2:  ['⛅', 'Parcialmente nublado'],
  3:  ['☁',  'Nublado'],
  45: ['🌫', 'Niebla'],
  48: ['🌫', 'Niebla con escarcha'],
  51: ['🌦', 'Llovizna ligera'],
  53: ['🌦', 'Llovizna'],
  55: ['🌧', 'Llovizna intensa'],
  56: ['🌧', 'Llovizna helada'],
  57: ['🌧', 'Llovizna helada intensa'],
  61: ['🌦', 'Lluvia ligera'],
  63: ['🌧', 'Lluvia'],
  65: ['🌧', 'Lluvia intensa'],
  66: ['🌧', 'Lluvia helada'],
  67: ['🌧', 'Lluvia helada intensa'],
  71: ['🌨', 'Nieve ligera'],
  73: ['🌨', 'Nieve'],
  75: ['❄',  'Nieve intensa'],
  77: ['❄',  'Granizo'],
  80: ['🌦', 'Chubascos ligeros'],
  81: ['🌧', 'Chubascos'],
  82: ['⛈', 'Chubascos fuertes'],
  85: ['🌨', 'Chubascos de nieve'],
  86: ['🌨', 'Chubascos de nieve fuertes'],
  95: ['⛈', 'Tormenta'],
  96: ['⛈', 'Tormenta con granizo'],
  99: ['⛈', 'Tormenta con granizo fuerte'],
};

function describe(code) {
  return WMO[code] || ['•', '—'];
}

function getJson(url, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'NexusWidget/1.0' } }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(e); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

// Calidad del aire (Open-Meteo Air Quality, mismo proveedor, sin key).
// Falla suave: si no responde, el clima sale igual sin la línea de AQI.
async function fetchAirQuality(latitude, longitude) {
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${latitude}&longitude=${longitude}` +
    `&current=us_aqi,uv_index,pm2_5,pm10&timezone=auto`;
  const data = await getJson(url);
  const c = data.current || {};
  return {
    aqi: typeof c.us_aqi === 'number' ? c.us_aqi : null,
    uv: typeof c.uv_index === 'number' ? c.uv_index : null,
    pm25: typeof c.pm2_5 === 'number' ? c.pm2_5 : null,
    pm10: typeof c.pm10 === 'number' ? c.pm10 : null,
  };
}

async function fetchWeather({ latitude, longitude, label }) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day` +
    `,precipitation,cloud_cover,pressure_msl,wind_direction_10m,wind_gusts_10m,dew_point_2m,visibility` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset` +
    `,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,uv_index_max` +
    `&timezone=auto&forecast_days=7`;

  const [data, air] = await Promise.all([
    getJson(url),
    fetchAirQuality(latitude, longitude).catch(() => null),
  ]);
  const cur = data.current || {};
  const d = data.daily || {};
  const [curEmoji, curLabel] = describe(cur.weather_code);
  // sunrise/sunset vienen en hora local del lugar sin offset ("2026-09-03T06:52");
  // se pasan a epoch ms con el utc_offset_seconds del API para que el renderer
  // decida día/noche con el reloj, sin depender de la zona horaria de la PC.
  const offMs = (data.utc_offset_seconds || 0) * 1000;
  const toMs = (s) => {
    if (!s) return null;
    const t = Date.parse(s + 'Z');
    return Number.isFinite(t) ? t - offMs : null;
  };
  const day = (i) => {
    const [emoji, lbl] = describe(d.weather_code?.[i]);
    return {
      date: d.time?.[i],
      code: d.weather_code?.[i],
      emoji,
      label: lbl,
      max: d.temperature_2m_max?.[i],
      min: d.temperature_2m_min?.[i],
      rainPct: d.precipitation_probability_max?.[i],
      rainMm: d.precipitation_sum?.[i],
      windMax: d.wind_speed_10m_max?.[i],
      gustMax: d.wind_gusts_10m_max?.[i],
      windDir: d.wind_direction_10m_dominant?.[i],
      uvMax: d.uv_index_max?.[i],
      sunrise: d.sunrise?.[i],
      sunset: d.sunset?.[i],
      sunriseMs: toMs(d.sunrise?.[i]),
      sunsetMs: toMs(d.sunset?.[i]),
    };
  };

  return {
    location: label,
    current: {
      temp: cur.temperature_2m,
      feels: cur.apparent_temperature,
      humidity: cur.relative_humidity_2m,
      wind: cur.wind_speed_10m,
      windDir: cur.wind_direction_10m,
      gusts: cur.wind_gusts_10m,
      precip: cur.precipitation,
      clouds: cur.cloud_cover,
      pressure: cur.pressure_msl,
      dewPoint: cur.dew_point_2m,
      visibility: cur.visibility,
      isDay: cur.is_day === 1,
      code: cur.weather_code,
      emoji: curEmoji,
      label: curLabel,
    },
    today: day(0),
    tomorrow: day(1),
    // Semana completa para el modal de detalle (hoy incluido).
    days: (d.time || []).map((_, i) => day(i)),
    air,
    fetchedAt: Date.now(),
  };
}

module.exports = { fetchWeather };
