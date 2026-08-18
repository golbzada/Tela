# TelaJunto

Sala simples de transmissão de tela para você e seus amigos, direto no navegador.
Sem app instalado, sem bot, sem intermediário — a pessoa entra com o nome e já pode
compartilhar ou ver a tela de quem estiver transmitindo.

## Como funciona

- `server.js`: servidor de sinalização (Express + Socket.io) e fornecedor de configurações ICE (`/api/ice-servers`).
- `public/`: front-end (tela de entrar na sala + tela de transmissão WebRTC).
- O vídeo trafega **peer-to-peer** entre os navegadores (mesh WebRTC).
- Salas são identificadas pelo parâmetro `?room=` na URL.
- Suporte a fila de ICE Candidates assíncronos, Perfect Negotiation, reconexão automática com `restartIce()` e suporte completo a STUN/TURN.

## Configuração de STUN e TURN (Variáveis de Ambiente)

Para garantir conexões em redes corporativas, celulares ou sob CGNAT/NAT restritivo, configure servidores STUN/TURN no seu ambiente ou arquivo `.env`:

```env
PORT=3000

# STUN (opcional, padrão Google STUN)
STUN_URL=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302

# TURN (opcional / recomendado para produção)
TURN_URL=turn:turn.meudominio.com:3478,turns:turn.meudominio.com:5349?transport=tcp
TURN_USERNAME=usuario_turn
TURN_CREDENTIAL=senha_turn
```

As credenciais não são expostas de forma estática no frontend; o cliente consome a rota `/api/ice-servers` dinamicamente ao iniciar.

## Rodando localmente

```bash
npm install
npm start
```

Acesse `http://localhost:3000`. Compartilhe o link que aparece no painel lateral ("LINK DA SALA") com quem você quiser que entre na mesma sala.

## Deploy

- [Railway](https://railway.app) ou [Render](https://render.com) — configure as variáveis de ambiente (`TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`, etc.) no painel do serviço.
- Em VPS, execute via PM2 com proxy reverso (Nginx com suporte a WebSocket `wss://`).
