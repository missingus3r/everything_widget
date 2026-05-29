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
    const req = https.get(url, { headers: { 'User-Agent': 'SystemDashboardWidget/1.0' } }, (res) => {
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

async function fetchWeather({ latitude, longitude, label }) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset` +
    `&timezone=auto&forecast_days=2`;

  const data = await getJson(url);
  const cur = data.current || {};
  const d = data.daily || {};
  const [curEmoji, curLabel] = describe(cur.weather_code);
  const day = (i) => {
    const [emoji, lbl] = describe(d.weather_code?.[i]);
    return {
      emoji,
      label: lbl,
      max: d.temperature_2m_max?.[i],
      min: d.temperature_2m_min?.[i],
      rainPct: d.precipitation_probability_max?.[i],
      sunrise: d.sunrise?.[i],
      sunset: d.sunset?.[i],
    };
  };

  return {
    location: label,
    current: {
      temp: cur.temperature_2m,
      feels: cur.apparent_temperature,
      humidity: cur.relative_humidity_2m,
      wind: cur.wind_speed_10m,
      isDay: cur.is_day === 1,
      emoji: curEmoji,
      label: curLabel,
    },
    today: day(0),
    tomorrow: day(1),
    fetchedAt: Date.now(),
  };
}

module.exports = { fetchWeather };
