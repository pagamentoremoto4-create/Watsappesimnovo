# WhatsApp eSIM - Correção pagamento e saldo

Correções desta versão:

- Webhook PixGo confirma `payment.completed`, `payment.paid` e `payment.approved`.
- Status SQL corrigidos com parâmetros para evitar erro `no such column`.
- Compra com saldo entrega pelo painel sem erro 502.
- PIX copia e cola continua em mensagem separada.

Variáveis Render:

```txt
NODE_VERSION=20.20.2
BASE_URL=https://watsappesimnovo.onrender.com
PIXGO_API_KEY=sua_chave
PIXGO_URL=https://pixgo.org/api/v1/payment/create
```

Webhook PixGo:

```txt
https://watsappesimnovo.onrender.com/webhook/pixgo
```
