# Harmony Car Wash — Campanhas Anuais

Projeto independente em Node 20, Express, SQLite, Baileys, Mercado Pago, Multer, Sharp e Socket.IO.

Esta versão inclui também as 23 imagens na raiz do projeto. Isso evita imagens ausentes quando o projeto é enviado ao GitHub sem preservar as subpastas. No primeiro início, o sistema copia automaticamente todas as imagens que estiverem faltando para o disco persistente e registra cada instalação no log do Render.

## Atendimento com duas IAs

O painel permite escolher quem conduz o atendimento:

- **OpenAI** — usa a Responses API;
- **Gemini** — usa a API `models.generateContent`;
- **Menu tradicional** — mantém o fluxo numérico sem IA.

As chaves e os modelos são configurados no painel e ficam criptografados no banco. Há botões separados para testar OpenAI e Gemini. Se a IA escolhida falhar, o bot informa a indisponibilidade e abre automaticamente o menu tradicional.

A IA entende mensagens naturais e coleta serviço, casa, veículo, data, horário e forma de pagamento. O código continua sendo a autoridade para preços, disponibilidade, criação da reserva, cobrança PIX e confirmação do pagamento. A IA nunca confirma diretamente uma cobrança.

Modelos iniciais sugeridos no painel: `gpt-5-mini` e `gemini-3.5-flash-lite`. Os dois campos são editáveis para permitir futuras atualizações sem alterar o código.

## Fluxo
Cliente no WhatsApp → menu → serviço → cadastro (nome obtido automaticamente do perfil, casa, modelo e cor em uma única pergunta) → data/horário → escolha pagar agora ou após a lavagem → painel operacional → Estou indo → foto ANTES → Iniciar → foto DEPOIS → Finalizar → montagem automática → cliente → grupo.

- O nome é capturado automaticamente do perfil do WhatsApp. Se o WhatsApp não fornecer um nome, o bot pergunta ao cliente como alternativa de segurança.
- O nome aparece no painel administrativo e no painel operacional. O administrador pode definir manualmente o nome que o bot deve usar; essa escolha tem prioridade sobre o perfil do WhatsApp.
- Na escolha da data, o cliente pode selecionar Hoje, Amanhã ou Outra data no formato DD/MM/AAAA.

- **Pagar agora:** o horário fica reservado por 10 minutos. Sem confirmação, a reserva é cancelada e o horário é liberado.
- **Pagar após a lavagem:** o agendamento é gravado como confirmado; ao finalizar, as fotos são enviadas, o PIX é criado e enviado ao cliente. Após a confirmação do pagamento, o cliente recebe agradecimento e pedido de avaliação.
- O painel permite cadastrar Mercado Pago e MisticPay e escolher qual gateway PIX ficará ativo.
- No Mercado Pago o PIX é gerado sem documento. Na MisticPay o bot solicita o CPF uma vez, salva no cadastro do cliente e envia o campo obrigatório `payerDocument` ao criar a cobrança.
- O status da lavagem e o status financeiro são exibidos separadamente.
- A pergunta de autorização foi removida. A publicação no grupo não inclui nome, casa ou telefone e usa uma versão da montagem com faixa de privacidade na região central inferior das fotos.
- O cliente recebe a confirmação somente depois que o banco grava a reserva. O WhatsApp do lavador, configurado no painel operacional, recebe um aviso quando o agendamento é confirmado e outro aviso **15 minutos antes** da lavagem.
- A assistente usa o tom próximo do André e dos vizinhos, mas nunca se apresenta como uma pessoa humana. O histórico recente de serviços, veículos, casas e avaliações é enviado à IA para personalização; preços, agenda, pagamento e confirmação continuam sob controle do código.
- O lembrete de 15 minutos é enviado somente ao lavador, não ao cliente.

## Horários padrão
08:00, 09:45, 14:00, 15:45. Meta de 4 carros/dia. Cada lavagem reserva 1h30 + 15min de intervalo; almoço bloqueado das 11:30 às 14:00.

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
6. No painel, cadastre o Access Token do Mercado Pago e/ou Client ID + Client Secret da MisticPay, selecione o gateway ativo, informe o endereço público, o número público e o WhatsApp do lavador com DDI e DDD.
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

O pacote inclui cinco fotos para os anúncios diários. A mesma foto é usada nos envios das 07h e 12h de um dia; no dia seguinte o sistema passa para a próxima, voltando à primeira depois da quinta. Quando houver campanha sazonal ativa, a foto da campanha substitui a foto diária.

## Fotos do menu e dos anúncios

- O menu do WhatsApp alterna automaticamente entre cinco fotos.
- O painel `/admin` exibe as cinco fotos do menu e as cinco fotos dos anúncios diários.
- Qualquer posição pode ser substituída no painel por arquivo JPEG, PNG ou WebP.
- As imagens enviadas pelo painel são ajustadas automaticamente para 1080 × 1080 pixels.
- As fotos personalizadas ficam no disco persistente e não são sobrescritas em novas inicializações.

## Calendário anual

O painel `/admin` permite ativar, pausar, editar o texto e trocar a foto de cada campanha. Datas fixas e móveis são recalculadas automaticamente a cada ano: Ano-Novo, Carnaval, Páscoa, Dia das Mães, Dia dos Namorados, São João, férias de julho, Dia dos Pais, Primavera, Dia das Crianças, Black Friday, Natal e Réveillon.

As 13 campanhas já começam com uma arte própria. As fotos trocadas no painel ficam armazenadas no disco persistente configurado em `DATA_DIR`.
