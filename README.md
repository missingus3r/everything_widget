# Control Center

Widget de escritorio flotante (Electron) que junta todo en una sola pantalla:
reloj, clima, uso de CPU/RAM/disco/red, speedtest, mercado, consumo de APIs de
IA, una sección **Finanzas** para seguir saldos, gastos e ingresos, y un
navegador de **torrents YIFY**.

> **Continuación de [CC_usage_widget](https://github.com/missingus3r/CC_usage_widget).**
> Este proyecto retoma y amplía aquel widget de consumo de Claude Code,
> sumando clima, métricas de sistema, mercado, speedtest y Finanzas.

## Funciones

- **Sistema:** CPU, RAM, disco y red en vivo.
- **Clima:** condiciones actuales por ubicación (Open-Meteo).
- **Speedtest:** medición de velocidad con historial.
- **Mercado:** cotizaciones y tipo de cambio.
- **Uso de IA:** consumo y costo estimado de Claude, Codex, ElevenLabs y otras APIs.
- **Finanzas:** saldos por cuenta, gastos/servicios/suscripciones e ingresos,
  con gráficas y totales convertidos.
- **Torrents:** últimas películas y búsqueda en YIFY (con filtros, vistas
  múltiples, ficha con cast/trailer y links magnet), con health check al inicio
  por si la API del mirror se cae.

## AI Usage: previsión semanal

Debajo de **Local Tokens**, **Previsión semanal** indica para Claude y Codex si
el cupo semanal alcanza hasta el próximo reinicio. Muestra uso actual, porcentaje
proyectado al reinicio, margen o tiempo hasta agotar el cupo, ritmo diario y
presupuesto diario disponible. Si el ritmo es excesivo, sugiere cuánto reducirlo.

La estimación usa los porcentajes semanales y las fechas de reinicio de las
lecturas existentes de cada proveedor; los tokens locales y los costos estimados
no se convierten en cupo. Con al menos 30 minutos entre mediciones, calcula el
aumento observado durante las últimas 24 horas disponibles, incluyendo pausas.
Antes de eso usa el promedio desde el inicio de la semana (ventana de 7 días);
durante la primera hora, espera a reunir datos suficientes. Es una extrapolación:
el uso futuro, los modelos y los límites del proveedor pueden cambiar.

Los contadores de la previsión se recalculan cada minuto. Las mediciones reales
siguen `refreshMinutesAI` (15 minutos por defecto) y el botón de actualización
de AI Usage. Una lectura fallida no agrega historial ni renueva su fecha; después
de dos intervalos sin datos (mínimo 30 minutos) se muestra como desactualizada.
Al vencer el reinicio espera la confirmación del proveedor.

El historial se guarda en el almacenamiento local de Electron
(`nexus.ai-weekly-forecast.v1`), con un máximo de 2048 observaciones por proveedor.
Solo conserva porcentajes y fechas. Un cambio de reinicio o una caída del
porcentaje inicia una serie nueva. Si no se puede guardar, funciona durante la
sesión e indica que el historial es temporal.

Verificación del cálculo:

```bash
node --test tests/aiForecast.test.js
```

## Finanzas: almacenamiento

Finanzas usa **MongoDB Atlas como store primario** y **SQLite como espejo local**
(lecturas instantáneas y modo offline). Cada cambio se escribe en ambos; al
iniciar, el widget sincroniza bajando la copia autoritativa de Mongo a SQLite.
Si el cluster no está disponible, funciona en modo SQLite-only sin interrumpir.

La cadena de conexión se configura en `config.json` (ignorado por git) bajo
`financesMongoUri`, o con la variable de entorno `FINANCES_MONGO_URI`. Ver
`config.example.json` para el formato.

## Desarrollo

```bash
npm install
npm start
```

Requiere Node.js 18+. Copiá `config.example.json` a `config.json` y completá
tus claves y la URI de Mongo. `config.json`, `.creds` y los `*.sqlite` están
fuera de git (ver `.gitignore`).
