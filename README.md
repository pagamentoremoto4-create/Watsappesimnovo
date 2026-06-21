# WhatsApp eSIM Centralunlocker - versão completa

Inclui:
- PIX PixGo funcionando com copia e cola separado
- Compra com saldo
- Depósito de saldo via PIX
- Entrega automática por estoque QR
- Entrega manual quando estoque zerar
- Painel admin
- Painel financeiro
- Mensagem em massa
- Backup manual completo
- Backup automático a cada 6 horas
- Menu com imagem/banner via `MENU_IMAGE_URL`

## Variáveis Render

```txt
NODE_VERSION=20.20.2
BASE_URL=https://watsappesimnovo.onrender.com
PIXGO_API_KEY=sua_chave_pixgo
PIXGO_URL=https://pixgo.org/api/v1/payment/create
ADMIN_NUMBERS=55SEUNUMERO
ADMIN_USER=admin
ADMIN_PASS=123456
DATA_DIR=/data
BACKUP_INTERVAL_HOURS=6
BACKUP_KEEP=30
MENU_IMAGE_URL=https://link-da-sua-imagem.png
SUPORTE_WHATSAPP=55SEUNUMERO
```

## Importante
Crie um Persistent Disk no Render com mount path:

```txt
/data
```

Assim o banco, QR Codes, sessão do WhatsApp e backups ficam salvos.

## Backup
No painel acesse:

```txt
/admin/backup
```

O backup completo salva:
- banco `esim.db`
- pasta de QR Codes `uploads_esim`

Também cria backup automático conforme `BACKUP_INTERVAL_HOURS`.
