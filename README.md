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

## Correção importante no Render

Adicione esta variável em **Environment**:

```txt
NODE_VERSION=20.20.2
```

Isso evita erro de compilação do better-sqlite3 no Node 26.

## Atualização: saldo do cliente

Esta versão adiciona:

- Opção 4 no WhatsApp: Depositar saldo via PIX
- Opção 5 no WhatsApp: Meu saldo
- Compra com saldo no plano selecionado
- Painel Admin > Clientes com botão para adicionar saldo manualmente
- Webhook PixGo reconhece depósito e credita saldo automaticamente
- Pedidos mostram tipo de pagamento: pix, saldo ou deposito

Fluxo do cliente:

1. Digita `menu`
2. Escolhe `4` para depositar saldo ou `1` para comprar eSIM
3. Ao selecionar um plano, pode escolher:
   - `1` Gerar PIX
   - `2` Comprar com saldo
   - `3` Voltar
