# Chave do atualizador automático

- `memorycard-updater.key` — chave **privada** (não vai para o git). Assina as builds que o app aceita como atualização.
  **Faça backup em lugar seguro** (gerenciador de senhas, pendrive): sem ela, quem já instalou o app não recebe mais atualizações automáticas.
- `memorycard-updater.key.pub` — chave pública, a mesma que está em `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.

Build + publicação: `npm run release:app -- --bump patch --publish --notes "Novidades"`
(veja `scripts/release-app.mjs`). Variáveis do login de admin: `MEMORYCARD_ADMIN_EMAIL`, `MEMORYCARD_ADMIN_PASSWORD`.
