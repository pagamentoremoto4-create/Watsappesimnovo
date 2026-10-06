# Harmony Car Wash — Campanhas Anuais

Projeto independente em Node 20, Express, SQLite, Baileys, Mercado Pago, Multer, Sharp e Socket.IO.

## Fluxo
Cliente no WhatsApp → menu → serviço → cadastro (nome obtido automaticamente do perfil, casa, modelo e cor em uma única pergunta) → data/horário → escolha pagar agora ou após a lavagem → painel operacional → Estou indo → foto ANTES → Iniciar → foto DEPOIS → Finalizar → montagem automática → cliente → grupo.

- O nome é capturado automaticamente do perfil do WhatsApp. Se o WhatsApp não fornecer um nome, o bot pergunta ao cliente como alternativa de segurança.
- O nome aparece no painel administrativo e no painel operacional. O administrador pode definir manualmente o nome que o bot deve usar; essa escolha tem prioridade sobre o perfil do WhatsApp.
- Na escolha da data, o cliente pode selecionar Hoje, Amanhã ou Outra data no formato DD/MM/AAAA.

- **Pagar agora:** o horário fica reservado por 10 minutos. Sem confirmação, a reserva é cancelada e o horário é liberado.
- **Pagar após a lavagem:** o agendamento é confirmado imediatamente; ao finalizar, o PIX é criado e enviado ao cliente.
- O painel permite cadastrar Mercado Pago e MisticPay e escolher qual gateway PIX ficará ativo.
- No Mercado Pago o PIX é gerado sem documento. Na MisticPay esta versão também não pergunta CPF, conforme o fluxo solicitado; como a documentação pública marca `payerDocument` como obrigatório e não existe sandbox, valide a primeira cobrança com valor baixo.
- O status da lavagem e o status financeiro são exibidos separadamente.
- A pergunta de autorização foi removida. A publicação no grupo não inclui nome, casa ou telefone e usa uma versão da montagem com faixa de privacidade na região central inferior das fotos.

## Horários padrão
07:00, 08:30, 10:00, 13:00, 14:30, 16:00. Máximo 6/dia. Cada slot reserva 1h30.

## Serviços
- Express — R$ 70
- Premium — R$ 100

Os serviços podem ser alterados no banco/API depois; esta versão inicial já os cria automaticamente.

## Render
1. Crie um novo Web Service para este projeto.
2. Runtime Node, Build Command: `npm install`, Start Command: `npm start`.
3. Adicione Persistent Disk em `/data`.
4. Configure apenas `DATA_DIR=/data`.
5. Abra `/admin` e crie a senha no primeiro acesso.
6. No painel, cadastre o Access Token do Mercado Pago e/ou Client ID + Client Secret da MisticPay, selecione o gateway ativo, informe o endereço público e o número do WhatsApp.
7. Conecte o WhatsApp pelo QR, atualize a lista de grupos e selecione o grupo do condomínio.
8. Use o link operacional gerado pelo próprio painel no celular do operador.

## Pagamentos PIX

- **Mercado Pago:** cria cobranças em `/v1/payments`, consulta `/v1/payments/{id}` e recebe notificações em `/api/webhooks/mercadopago`.
- **MisticPay:** cria cobranças em `/api/transactions/create`, consulta `/api/transactions/check` e recebe notificações em `/api/webhooks/misticpay`.
- O gateway escolhido fica salvo em cada agendamento. Trocar o gateway no painel não altera cobranças que já foram criadas.
- O cliente recebe o Pix Copia e Cola e a confirmação é feita por consulta automática e webhook.

## Grupo
O número conectado precisa participar do grupo e ter permissão para enviar mensagens. A seleção do grupo e a ativação dos anúncios são feitas no painel.

O sistema publica:

- anúncio diário às **07:00**;
- anúncio diário às **12:00**;
- montagem de cada lavagem finalizada;
- campanha sazonal quando houver uma data ativa.

Os anúncios consultam a agenda antes de informar horários. Cada envio fica registrado no SQLite para não ser duplicado após reinício do Render.

## Calendário anual

O painel `/admin` permite ativar, pausar e editar os textos das campanhas. Datas fixas e móveis são recalculadas automaticamente a cada ano: Ano-Novo, Carnaval, Páscoa, Dia das Mães, Dia dos Namorados, São João, férias de julho, Dia dos Pais, Primavera, Dia das Crianças, Black Friday, Natal e Réveillon.

Para usar uma imagem própria em uma campanha, coloque o arquivo dentro de `/data/campanhas` e informe o nome do arquivo no banco/campo `imagem`. Sem imagem, o anúncio é enviado normalmente como texto.
