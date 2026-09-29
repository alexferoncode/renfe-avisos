# Avisos Renfe

Cada 10 minutos, GitHub Actions busca en Renfe los trenes de la lista y avisa por Telegram
cuando alguno tiene plazas de clase Estándar (las que admite el abono). No cuenta las plazas "solo H".

- **Lista de trenes:** variable de Actions `TRENES`, que se edita desde la web (`docs/`, publicada en GitHub Pages).
- **Secretos:** `TELEGRAM_TOKEN` y `TELEGRAM_CHAT_ID`.
- **Estado:** qué trenes ya se avisaron; se guarda en la caché de Actions. Solo se avisa cuando un tren *pasa* a estar disponible.

Prueba local sin enviar nada:

```bash
DRY_RUN=1 TRENES='[{"fecha":"2026-10-09","origen":"17000","destino":"60600","hora":"16:00"}]' node check.mjs
```

Códigos de estación: 60000 Atocha · 17000 Chamartín · 60600 Albacete-Los Llanos.
