# TelaJunto

Sala simples de transmissão de tela para você e seus amigos, direto no navegador.
Sem app instalado, sem bot, sem intermediário — a pessoa entra com o nome e já pode
compartilhar ou ver a tela de quem estiver transmitindo.

## Como funciona

- `server.js`: servidor de sinalização (Express + Socket.io). Ele não recebe nem
  retransmite vídeo — só troca as mensagens necessárias para os navegadores se
  conectarem direto entre si (WebRTC).
- `public/`: front-end (tela de entrar na sala + tela de transmissão).
- O vídeo trafega **peer-to-peer** entre os navegadores (mesh). Isso significa
  que o consumo de upload de quem está transmitindo cresce com o número de
  espectadores — funciona bem para grupos pequenos (uso pessoal entre amigos).
- Salas são identificadas pelo parâmetro `?room=` na URL. Se ninguém enviar um,
  o próprio site gera um código e atualiza o link.
- Uma sala é esquecida da memória do servidor 5 minutos depois de ficar vazia
  (não existe gravação nem histórico — nada fica salvo).

## Rodando localmente

```bash
npm install
npm start
```

Acesse `http://localhost:3000`. Compartilhe o link que aparece no painel lateral
("LINK DA SALA") com quem você quiser que entre na mesma sala.

## Deploy

**Importante:** este app precisa de um processo Node.js rodando continuamente
para manter as conexões WebSocket abertas — a Vercel (no plano padrão de
funções serverless) não é um bom encaixe para isso. Use algo como:

- [Railway](https://railway.app) ou [Render](https://render.com) — sobe o
  repositório, ele detecta o `npm start` e já funciona com WebSocket.
- Uma VPS simples (ex: um droplet da DigitalOcean) rodando `node server.js`
  atrás de um Nginx com proxy reverso, usando PM2 para manter o processo vivo.

Depois de publicado, troque `localhost:3000` pelo domínio real — o `app.js`
já usa `window.location.origin` automaticamente, então não precisa mexer em
nada no código pra isso funcionar.

## Personalizar

- Nome/marca: edite `public/index.html` (`.brand-word`) e `public/style.css`
  (variáveis `--accent`, `--bg` no topo do arquivo).
- Limite de tempo de sala vazia: constante `EMPTY_ROOM_TIMEOUT_MS` em `server.js`.
