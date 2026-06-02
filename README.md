# everything_widget

Widget de escritorio flotante (Electron) que junta todo en una sola pantalla:
reloj, clima, uso de CPU/RAM/disco/red, speedtest, consumo de APIs de IA y una
sección **Finanzas** para seguir saldos, gastos e ingresos.

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
