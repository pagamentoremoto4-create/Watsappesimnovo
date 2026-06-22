# Correção de travamento do painel

Melhorias aplicadas:

- SQLite com WAL, `busy_timeout`, `synchronous=NORMAL` e `temp_store=MEMORY`.
- Timeout nas requisições do painel para evitar conexão pendurada.
- Página de clientes, pedidos e estoque limitada a 100 registros por vez.
- Adicionar saldo não espera o WhatsApp enviar mensagem para carregar a página.
- Mensagem em massa roda em segundo plano com pausa entre envios.
- Envio de texto/imagem pelo WhatsApp com timeout, evitando travar o painel.
- Rota `/status` para conferir se o servidor está vivo.
- Tratamento global de erros para reduzir queda do processo.

Variáveis recomendadas no Render:

```env
WEB_CONCURRENCY=1
NODE_VERSION=20.20.2
DATA_DIR=/data
DB_PATH=/data/esim.db
UPLOAD_DIR=/data/uploads_esim
AUTH_DIR=/data/auth_esim
BACKUP_DIR=/data/backups_esim
```
