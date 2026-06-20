# Centralunlocker eSIM WhatsApp

Bot WhatsApp do zero para venda de eSIM com PixGo.

## Funções

- WhatsApp via Baileys
- Menu de cliente
- Planos com estoque visível: `TIM 50GB - 10 disponíveis`
- PixGo automático
- Entrega automática quando tiver QR em estoque
- Entrega manual quando estoque acabar
- Aviso para admin
- Painel admin Web
- Produtos em destaque
- Estoque baixo/zerado
- Pedidos manuais
- Backup do banco
- Reset da sessão WhatsApp

## Instalar local

```bash
npm install
cp .env.example .env
npm start
```

Abra no navegador:

```txt
http://localhost:10000/qr
```

## Render

Build command:

```bash
npm install
```

Start command:

```bash
npm start
```

Crie Persistent Disk com mount path:

```txt
/data
```

## Painel

```txt
https://SEU-SERVICO.onrender.com/admin
```

Login padrão:

```txt
Usuário: admin
Senha: 123456
```

Troque depois pelo painel.

## Webhook PixGo

```txt
https://SEU-SERVICO.onrender.com/webhook/pixgo
```
